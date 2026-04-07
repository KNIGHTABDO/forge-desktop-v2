// src/lib/agent/useLocalAgent.ts
// React hook that wraps the AgentLoop and bridges to Forge Desktop's chat state

import { useCallback, useRef, useState } from 'react'
import { AgentLoop } from './core'
import { registerBuiltinExecutors } from './executor'
import { ToolRegistry, BUILTIN_TOOLS } from './tools'
import type {
  AgentConfig,
  AgentEvent,
  AgentRunResult,
  ToolCall,
  ToolResult,
} from './types'

// ── Bridge Types (match existing App.tsx types) ──────────────────────

export type ToolEventStatus = 'running' | 'done' | 'error'

export interface LocalToolEvent {
  name: string
  status: ToolEventStatus
  detail: string
}

export interface LocalAgentResult {
  ok: boolean
  reply: string
  thinking: string[]
  toolEvents: LocalToolEvent[]
  error?: string
  stepsExecuted: number
  toolsUsed: string[]
  cancelled: boolean
}

// ── Hook ─────────────────────────────────────────────────────────────

export interface UseLocalAgentOptions {
  model?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
  maxSteps?: number
  temperature?: number
}

export function useLocalAgent(defaults?: UseLocalAgentOptions) {
  const [isRunning, setIsRunning] = useState(false)
  const [phase, setPhase] = useState<string>('idle')
  const abortRef = useRef<AbortController | null>(null)
  const registeredRef = useRef(false)

  // Ensure built-in tools are registered once
  if (!registeredRef.current) {
    registerBuiltinExecutors()
    registeredRef.current = true
  }

  const runAgent = useCallback(
    async (
      prompt: string,
      options: {
        workspacePath: string
        history?: Array<{ role: string; content: string }>
        systemPrompt?: string
        onToolEvent?: (event: LocalToolEvent) => void
        onThinking?: (thought: string) => void
        onPhaseChange?: (phase: string) => void
      }
    ): Promise<LocalAgentResult> => {
      if (isRunning) {
        return {
          ok: false,
          reply: '',
          thinking: [],
          toolEvents: [],
          error: 'Agent is already running',
          stepsExecuted: 0,
          toolsUsed: [],
          cancelled: false,
        }
      }

      setIsRunning(true)
      setPhase('starting')

      const thinking: string[] = []
      const toolEvents: LocalToolEvent[] = []
      const toolEventMap = new Map<string, number>() // toolCallId -> index in toolEvents

      const abortController = new AbortController()
      abortRef.current = abortController

      // Build agent config
      const config: AgentConfig = {
        model: defaults?.model || 'xiaomi/mimo-v2-pro',
        provider: defaults?.provider || 'nous',
        baseUrl: defaults?.baseUrl,
        apiKey: defaults?.apiKey,
        maxSteps: defaults?.maxSteps || 20,
        maxRetries: 2,
        temperature: defaults?.temperature ?? 0.3,
        timeout: 60_000,
        workspacePath: options.workspacePath || '',
        autoApprove: false,
      }

      // Build full system prompt with history context
      let systemPrompt = options.systemPrompt || ''
      if (options.history && options.history.length > 0) {
        const historyContext = options.history
          .slice(-6)
          .map((h) => `${h.role}: ${h.content.slice(0, 500)}`)
          .join('\n')
        systemPrompt += `\n\n## Recent Conversation History\n${historyContext}`
      }

      // Event handler bridges AgentLoop events to our format
      const handleEvent = (event: AgentEvent) => {
        switch (event.type) {
          case 'phase_change': {
            const newPhase = event.data.phase as string
            setPhase(newPhase)
            options.onPhaseChange?.(newPhase)
            break
          }

          case 'thinking': {
            const thought = event.data.content as string
            if (thought) {
              thinking.push(thought)
              options.onThinking?.(thought)
            }
            break
          }

          case 'tool_start': {
            const toolCall = event.data.toolCall as ToolCall
            if (toolCall) {
              const idx = toolEvents.length
              toolEventMap.set(toolCall.id, idx)
              toolEvents.push({
                name: toolCall.name,
                status: 'running',
                detail: JSON.stringify(toolCall.parameters).slice(0, 200),
              })
              options.onToolEvent?.(toolEvents[idx])
            }
            break
          }

          case 'tool_complete': {
            const result = event.data.result as ToolResult
            if (result) {
              const idx = toolEventMap.get(result.toolCallId)
              if (idx !== undefined && toolEvents[idx]) {
                toolEvents[idx] = {
                  name: result.toolName,
                  status: result.status === 'done' ? 'done' : 'error',
                  detail:
                    result.status === 'done'
                      ? result.output.slice(0, 200)
                      : result.error || 'Unknown error',
                }
                options.onToolEvent?.(toolEvents[idx])
              }
            }
            break
          }

          case 'tool_error': {
            const result = event.data.result as ToolResult
            if (result) {
              const idx = toolEventMap.get(result.toolCallId)
              if (idx !== undefined && toolEvents[idx]) {
                toolEvents[idx].status = 'error'
                toolEvents[idx].detail = result.error || 'Tool failed'
                options.onToolEvent?.(toolEvents[idx])
              }
            }
            break
          }

          case 'message': {
            const turn = event.data.turn as { role: string; content: string }
            if (turn?.role === 'assistant' && turn.content) {
              // Assistant thinking/reasoning gets captured here
              thinking.push(turn.content.slice(0, 500))
            }
            break
          }

          case 'approval_needed': {
            // For now, auto-approve in local mode (user can change this later)
            thinking.push('⚠️ Approval needed — auto-approving in local mode')
            break
          }
        }
      }

      try {
        // Create and run the agent loop
        const agent = new AgentLoop(config, handleEvent)
        const result: AgentRunResult = await agent.run(prompt, systemPrompt)

        setPhase('idle')
        abortRef.current = null

        // Deduplicate thinking entries
        const uniqueThinking = Array.from(new Set(thinking)).slice(0, 20)

        return {
          ok: !result.error && !result.cancelled,
          reply: result.content,
          thinking: uniqueThinking,
          toolEvents,
          error: result.error,
          stepsExecuted: result.stepsExecuted,
          toolsUsed: result.toolsUsed,
          cancelled: result.cancelled,
        }
      } catch (error: unknown) {
        setPhase('idle')
        abortRef.current = null

        return {
          ok: false,
          reply: '',
          thinking,
          toolEvents,
          error: error instanceof Error ? error.message : String(error),
          stepsExecuted: 0,
          toolsUsed: [],
          cancelled: false,
        }
      } finally {
        setIsRunning(false)
      }
    },
    [isRunning, defaults]
  )

  const cancelAgent = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
  }, [])

  return {
    runAgent,
    cancelAgent,
    isRunning,
    phase,
  }
}

// ── Provider Config Loader ───────────────────────────────────────────

export interface LocalProviderConfig {
  model: string
  provider: string
  baseUrl: string
  apiKey: string
}

export function loadProviderConfig(): LocalProviderConfig {
  // Read from the same config location as hermes agent
  // For the frontend, we read from localStorage or use defaults
  const stored = localStorage.getItem('forge-local-agent-config')
  if (stored) {
    try {
      return JSON.parse(stored)
    } catch {
      // Fall through to defaults
    }
  }

  return {
    model: 'xiaomi/mimo-v2-pro',
    provider: 'nous',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    apiKey: '', // User must set this
  }
}

export function saveProviderConfig(config: LocalProviderConfig): void {
  localStorage.setItem('forge-local-agent-config', JSON.stringify(config))
}
