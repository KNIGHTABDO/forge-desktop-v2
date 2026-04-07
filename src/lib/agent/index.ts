// src/lib/agent/index.ts
// Forge Agent — public API surface

export { AgentLoop } from './core'
export type { AgentRunResult } from './core'

export { ToolRegistry, BUILTIN_TOOLS, formatToolsForPrompt, formatToolsForOpenAI } from './tools'

export { AgentMemoryStore } from './memory'

export { SubagentManager } from './subagents'
export type { SubagentConfig } from './subagents'

export { registerBuiltinExecutors } from './executor'

export type {
  AgentConfig,
  AgentPhase,
  AgentPlan,
  AgentStep,
  AgentTurn,
  AgentEvent,
  AgentEventHandler,
  AgentEventType,
  ToolDefinition,
  ToolParameter,
  ToolCall,
  ToolResult,
  ToolStatus,
  ToolExecutionContext,
  ToolExecutor,
  SubagentInstance,
  SubagentTask,
  SubagentStatus,
  MemoryEntry,
  AgentMemory,
} from './types'
