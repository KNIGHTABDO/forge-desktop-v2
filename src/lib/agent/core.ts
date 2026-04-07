// src/lib/agent/core.ts
// The main agent loop — planning, execution, reflection cycle

import type {
  AgentConfig,
  AgentPhase,
  AgentPlan,
  AgentStep,
  AgentTurn,
  AgentEvent,
  AgentEventHandler,
  AgentEventType,
  ToolCall,
  ToolResult,
  ToolStatus,
  ToolDefinition,
} from './types'
import { ToolRegistry, formatToolsForOpenAI, BUILTIN_TOOLS } from './tools'
import { AgentMemoryStore } from './memory'

function makeId(prefix: string): string {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

// ── LLM API Caller ──────────────────────────────────────────────────

interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface LLMToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface LLMResponse {
  content: string | null
  tool_calls?: LLMToolCall[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

async function callLLM(
  config: AgentConfig,
  messages: LLMMessage[],
  tools?: object[]
): Promise<LLMResponse> {
  const baseUrl = config.baseUrl || 'https://inference-api.nousresearch.com/v1'
  const url = `${baseUrl}/chat/completions`

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: 4096,
  }

  if (tools && tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error')
    throw new Error(`LLM API error ${response.status}: ${errorText}`)
  }

  const data = await response.json()
  const choice = data.choices?.[0]
  if (!choice) {
    throw new Error('No response choice from LLM')
  }

  return {
    content: choice.message?.content ?? null,
    tool_calls: choice.message?.tool_calls,
    usage: data.usage,
  }
}

// ── Agent Loop ───────────────────────────────────────────────────────

export interface AgentRunResult {
  content: string
  turns: AgentTurn[]
  plan: AgentPlan | null
  stepsExecuted: number
  toolsUsed: string[]
  error?: string
  cancelled: boolean
}

export class AgentLoop {
  private config: AgentConfig
  private memory: AgentMemoryStore
  private onEvent: AgentEventHandler
  private phase: AgentPhase = 'idle'
  private turns: AgentTurn[] = []
  private plan: AgentPlan | null = null
  private isCancelled = false
  private pendingApprovals: Map<string, { resolve: (approved: boolean) => void }> = new Map()

  constructor(config: AgentConfig, onEvent: AgentEventHandler) {
    this.config = config
    this.onEvent = onEvent
    this.memory = new AgentMemoryStore()

    // Register built-in tools
    for (const tool of BUILTIN_TOOLS) {
      if (!ToolRegistry.has(tool.name)) {
        // Tool executors will be registered separately
      }
    }
  }

  getPhase(): AgentPhase {
    return this.phase
  }

  getMemory(): AgentMemoryStore {
    return this.memory
  }

  cancel(): void {
    this.isCancelled = true
    // Resolve all pending approvals as rejected
    for (const [, pending] of this.pendingApprovals) {
      pending.resolve(false)
    }
    this.pendingApprovals.clear()
    this.setPhase('cancelled')
  }

  // Approve a pending tool call
  approveTool(toolCallId: string): void {
    const pending = this.pendingApprovals.get(toolCallId)
    if (pending) {
      pending.resolve(true)
      this.pendingApprovals.delete(toolCallId)
    }
  }

  // Reject a pending tool call
  rejectTool(toolCallId: string): void {
    const pending = this.pendingApprovals.get(toolCallId)
    if (pending) {
      pending.resolve(false)
      this.pendingApprovals.delete(toolCallId)
    }
  }

  // Main execution entry point
  async run(goal: string, systemPrompt?: string): Promise<AgentRunResult> {
    this.isCancelled = false
    this.turns = []
    const toolsUsedSet = new Set<string>()
    let stepsExecuted = 0

    try {
      this.setPhase('planning')

      // Build system prompt
      const fullSystemPrompt = this.buildSystemPrompt(systemPrompt)

      // Initial messages
      const messages: LLMMessage[] = [
        { role: 'system', content: fullSystemPrompt },
        { role: 'user', content: goal },
      ]

      // Record user turn
      this.addTurn({ role: 'user', content: goal })

      // Get available tools
      const availableTools = ToolRegistry.listTools()
      const openaiTools = formatToolsForOpenAI(availableTools)

      // Main agent loop
      let iterationCount = 0
      const maxIterations = this.config.maxSteps * 3 // safety limit
      let lastAssistantContent = ''

      while (!this.isCancelled && iterationCount < maxIterations) {
        iterationCount++
        this.setPhase('executing')

        // Call LLM
        let response: LLMResponse
        try {
          response = await callLLM(this.config, messages, openaiTools)
        } catch (error: unknown) {
          const errorMsg = error instanceof Error ? error.message : String(error)

          // Retry once on transient errors
          if (iterationCount === 1 || errorMsg.includes('429') || errorMsg.includes('529')) {
            await this.delay(2000)
            try {
              response = await callLLM(this.config, messages, openaiTools)
            } catch (retryError: unknown) {
              this.setPhase('failed')
              return this.buildResult(
                lastAssistantContent,
                null,
                stepsExecuted,
                toolsUsedSet,
                retryError instanceof Error ? retryError.message : String(retryError)
              )
            }
          } else {
            this.setPhase('failed')
            return this.buildResult(lastAssistantContent, null, stepsExecuted, toolsUsedSet, errorMsg)
          }
        }

        const assistantContent = response.content || ''

        // If no tool calls, agent is done
        if (!response.tool_calls || response.tool_calls.length === 0) {
          lastAssistantContent = assistantContent

          // Record final assistant turn
          const turn: AgentTurn = {
            id: makeId('turn'),
            role: 'assistant',
            content: assistantContent,
            timestamp: Date.now(),
          }
          this.addTurn(turn)
          messages.push({ role: 'assistant', content: assistantContent })

          // Check if this looks like a plan request (plan mode)
          if (this.isPlanResponse(assistantContent) && !this.plan) {
            this.setPhase('waiting_approval')
            this.emit('approval_needed', {
              type: 'plan',
              content: assistantContent,
            })
            // In auto mode, we continue; in manual mode the UI handles this
          }

          break
        }

        // Process tool calls
        this.setPhase('executing')
        const assistantMessage: LLMMessage = {
          role: 'assistant',
          content: assistantContent || null,
          tool_calls: response.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        }
        messages.push(assistantMessage)

        if (assistantContent) {
          lastAssistantContent = assistantContent
          const thinkingTurn: AgentTurn = {
            id: makeId('turn'),
            role: 'assistant',
            content: assistantContent,
            timestamp: Date.now(),
          }
          this.addTurn(thinkingTurn)
        }

        // Execute tools (parallel where possible, sequential if approval needed)
        const toolResults: ToolResult[] = []
        const toolMessages: LLMMessage[] = []

        for (const tc of response.tool_calls) {
          if (this.isCancelled) break

          let params: Record<string, unknown>
          try {
            params = JSON.parse(tc.function.arguments)
          } catch {
            params = {}
          }

          const toolCall: ToolCall = {
            id: tc.id,
            name: tc.function.name,
            parameters: params,
          }

          toolsUsedSet.add(toolCall.name)
          stepsExecuted++

          this.emit('tool_start', { toolCall })

          // Check if approval needed
          if (ToolRegistry.requiresApproval(toolCall.name) && !this.config.autoApprove) {
            this.setPhase('waiting_approval')
            this.emit('approval_needed', { toolCall })

            const approved = await new Promise<boolean>((resolve) => {
              this.pendingApprovals.set(toolCall.id, { resolve })
              // Auto-reject after 5 minutes
              setTimeout(() => {
                if (this.pendingApprovals.has(toolCall.id)) {
                  this.pendingApprovals.delete(toolCall.id)
                  resolve(false)
                }
              }, 300_000)
            })

            if (!approved) {
              const rejectedResult: ToolResult = {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                status: 'cancelled',
                output: '',
                error: 'Tool execution rejected by user',
                startedAt: Date.now(),
                finishedAt: Date.now(),
              }
              toolResults.push(rejectedResult)
              toolMessages.push({
                role: 'tool',
                content: 'Tool execution was rejected by the user. Ask for confirmation or try a different approach.',
                tool_call_id: tc.id,
              })
              this.emit('tool_complete', { result: rejectedResult })
              continue
            }
          }

          // Execute tool
          const context = {
            workspacePath: this.config.workspacePath,
            config: this.config,
            memory: this.memory,
            abortSignal: new AbortController().signal,
          }

          const result = await ToolRegistry.execute(toolCall, context)
          toolResults.push(result)

          // Add to memory
          this.memory.addToolResult(result)

          // Build tool response message
          const toolOutput =
            result.status === 'done'
              ? result.output.slice(0, 8000)
              : `Error: ${result.error || 'Unknown error'}`

          toolMessages.push({
            role: 'tool',
            content: toolOutput,
            tool_call_id: tc.id,
          })

          this.emit('tool_complete', { result })

          if (result.status === 'error' || result.status === 'timeout') {
            this.emit('tool_error', { result })
          }
        }

        // Add tool results to messages
        messages.push(...toolMessages)

        // Record tool turn
        if (toolResults.length > 0) {
          const toolTurn: AgentTurn = {
            id: makeId('turn'),
            role: 'assistant',
            content: '',
            toolCalls: response.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              parameters: JSON.parse(tc.function.arguments || '{}'),
            })),
            toolResults,
            timestamp: Date.now(),
          }
          this.addTurn(toolTurn)
        }

        // Reflection step — every 5 iterations, add a reflection prompt
        if (iterationCount % 5 === 0 && !this.isCancelled) {
          this.setPhase('reflecting')
          messages.push({
            role: 'user',
            content:
              'Pause and reflect: Are you making progress toward the goal? Are there any errors or blockers you need to address? Summarize what you have done so far and what remains.',
          })
        }
      }

      if (this.isCancelled) {
        this.setPhase('cancelled')
        return this.buildResult(lastAssistantContent, null, stepsExecuted, toolsUsedSet, undefined, true)
      }

      if (iterationCount >= maxIterations) {
        lastAssistantContent =
          (lastAssistantContent || '') +
          '\n\n[Agent reached maximum iteration limit. Task may be incomplete.]'
      }

      this.setPhase('completed')
      return this.buildResult(lastAssistantContent, null, stepsExecuted, toolsUsedSet)
    } catch (error: unknown) {
      this.setPhase('failed')
      return this.buildResult(
        '',
        null,
        stepsExecuted,
        toolsUsedSet,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private buildSystemPrompt(customPrompt?: string): string {
    const toolDefs = ToolRegistry.listTools()
    const toolDocs = toolDefs
      .map((t) => {
        const params = t.parameters
          .map((p) => {
            const req = p.required ? ' (required)' : ''
            return `  - ${p.name}: ${p.type}${req} — ${p.description}`
          })
          .join('\n')
        const danger = t.dangerous ? ' ⚠️ REQUIRES APPROVAL' : ''
        return `- ${t.name}${danger}: ${t.description}\n${params}`
      })
      .join('\n\n')

    const workspaceInfo = `Workspace: ${this.config.workspacePath || 'No workspace selected'}`

    const memoryContext = this.memory.buildContext(4000)

    return [
      customPrompt || 'You are Forge, an autonomous AI coding agent inside Forge Desktop.',
      '',
      '## Core Principles',
      '- You have full access to the workspace filesystem and terminal.',
      '- Always read files before editing them.',
      '- Prefer targeted edits over full file rewrites.',
      '- When executing commands, check exit codes and handle errors.',
      '- Be concise in your reasoning. Focus on action over explanation.',
      '',
      `## ${workspaceInfo}`,
      '',
      '## Available Tools',
      toolDocs,
      '',
      memoryContext,
      '',
      '## Response Format',
      'Use tool calls to take actions. When done, provide a clear summary of what was accomplished.',
      'If something fails, diagnose the issue and try a different approach before giving up.',
    ]
      .filter(Boolean)
      .join('\n')
  }

  private isPlanResponse(content: string): boolean {
    const lower = content.toLowerCase()
    return (
      lower.includes('### plan') ||
      lower.includes('implementation steps') ||
      lower.includes('objective:') ||
      lower.includes('request your approval to proceed')
    )
  }

  private setPhase(phase: AgentPhase): void {
    if (this.phase !== phase) {
      this.phase = phase
      this.emit('phase_change', { phase })
    }
  }

  private addTurn(turn: AgentTurn): void {
    this.turns.push(turn)
    this.memory.addTurn(turn)
    this.emit('message', { turn })
  }

  private emit(type: AgentEventType, data: Record<string, unknown> = {}): void {
    try {
      this.onEvent({ type, timestamp: Date.now(), data })
    } catch {
      // Don't let event handler errors crash the agent
    }
  }

  private buildResult(
    content: string,
    plan: AgentPlan | null,
    stepsExecuted: number,
    toolsUsedSet: Set<string>,
    error?: string,
    cancelled = false
  ): AgentRunResult {
    return {
      content,
      turns: this.turns,
      plan,
      stepsExecuted,
      toolsUsed: Array.from(toolsUsedSet),
      error,
      cancelled,
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
