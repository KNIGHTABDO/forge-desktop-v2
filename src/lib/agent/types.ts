// src/lib/agent/types.ts
// Core type definitions for the Forge Agent system

// ── Tool System ──────────────────────────────────────────────────────

export type ToolParameterType = 'string' | 'number' | 'boolean' | 'array' | 'object'

export interface ToolParameter {
  name: string
  type: ToolParameterType
  description: string
  required: boolean
  default?: unknown
  enum?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameter[]
  category: 'file' | 'terminal' | 'search' | 'skill' | 'web' | 'agent' | 'memory'
  dangerous?: boolean // requires user approval
  timeout?: number // ms, default 30000
}

export type ToolStatus = 'queued' | 'running' | 'done' | 'error' | 'timeout' | 'cancelled'

export interface ToolResult {
  toolCallId: string
  toolName: string
  status: ToolStatus
  output: string
  error?: string
  startedAt: number
  finishedAt: number
  metadata?: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  parameters: Record<string, unknown>
}

// ── Agent Loop ───────────────────────────────────────────────────────

export type AgentPhase =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'waiting_approval'
  | 'reflecting'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AgentStep {
  id: string
  description: string
  toolCalls: ToolCall[]
  status: ToolStatus
  result?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

export interface AgentPlan {
  id: string
  goal: string
  steps: AgentStep[]
  currentStepIndex: number
  createdAt: number
  updatedAt: number
}

export interface AgentTurn {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  thinking?: string[]
  timestamp: number
}

export interface AgentConfig {
  model: string
  provider: string
  baseUrl?: string
  apiKey?: string
  maxSteps: number
  maxRetries: number
  temperature: number
  timeout: number
  workspacePath: string
  autoApprove: boolean // if true, skip approval for dangerous tools
}

// ── Subagent System ──────────────────────────────────────────────────

export type SubagentStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface SubagentTask {
  id: string
  goal: string
  context: string // relevant context passed to subagent
  priority: number // 1 = highest
  dependencies: string[] // other task IDs this depends on
}

export interface SubagentInstance {
  id: string
  task: SubagentTask
  status: SubagentStatus
  result?: string
  error?: string
  turns: AgentTurn[]
  startedAt?: number
  finishedAt?: number
  stepsCompleted: number
}

// ── Agent Memory ─────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string
  type: 'fact' | 'file_content' | 'search_result' | 'tool_output' | 'plan' | 'reflection'
  content: string
  source: string
  relevance: number // 0-1, used for pruning
  tokens: number // approximate token count
  createdAt: number
  lastAccessedAt: number
  accessCount: number
  tags: string[]
}

export interface AgentMemory {
  entries: MemoryEntry[]
  maxTokens: number
  currentTokens: number
}

// ── Events ───────────────────────────────────────────────────────────

export type AgentEventType =
  | 'phase_change'
  | 'step_start'
  | 'step_complete'
  | 'tool_start'
  | 'tool_progress'
  | 'tool_complete'
  | 'tool_error'
  | 'plan_created'
  | 'plan_updated'
  | 'thinking'
  | 'message'
  | 'approval_needed'
  | 'subagent_spawned'
  | 'subagent_complete'
  | 'error'
  | 'complete'

export interface AgentEvent {
  type: AgentEventType
  timestamp: number
  data: Record<string, unknown>
}

export type AgentEventHandler = (event: AgentEvent) => void

// ── Execution Context ────────────────────────────────────────────────

export interface ToolExecutionContext {
  workspacePath: string
  config: AgentConfig
  memory: AgentMemory
  onProgress?: (toolCallId: string, output: string) => void
  abortSignal?: AbortSignal
}

export type ToolExecutor = (
  params: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<ToolResult>
