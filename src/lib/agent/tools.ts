// src/lib/agent/tools.ts
// Pluggable tool registry for the Forge Agent

import type {
  ToolDefinition,
  ToolExecutor,
  ToolResult,
  ToolCall,
  ToolExecutionContext,
  ToolStatus,
} from './types'

// ── Tool Registry ────────────────────────────────────────────────────

class ToolRegistryClass {
  private tools: Map<string, { definition: ToolDefinition; executor: ToolExecutor }> = new Map()
  private executionHistory: ToolResult[] = []
  private readonly maxHistorySize = 500

  register(definition: ToolDefinition, executor: ToolExecutor): void {
    if (this.tools.has(definition.name)) {
      console.warn(`[ToolRegistry] Overwriting tool: ${definition.name}`)
    }
    this.tools.set(definition.name, { definition, executor })
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition
  }

  listTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition)
  }

  listByCategory(category: ToolDefinition['category']): ToolDefinition[] {
    return this.listTools().filter((t) => t.category === category)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  requiresApproval(name: string): boolean {
    const tool = this.tools.get(name)
    return tool?.definition.dangerous === true
  }

  async execute(
    toolCall: ToolCall,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const entry = this.tools.get(toolCall.name)
    if (!entry) {
      return this.errorResult(toolCall, `Unknown tool: ${toolCall.name}`)
    }

    const { definition, executor } = entry
    const timeout = definition.timeout ?? 30_000
    const startedAt = Date.now()

    // Validate required parameters
    const missing = definition.parameters
      .filter((p) => p.required && !(p.name in toolCall.parameters))
      .map((p) => p.name)

    if (missing.length > 0) {
      return this.errorResult(
        toolCall,
        `Missing required parameters: ${missing.join(', ')}`
      )
    }

    // Merge defaults
    const params = { ...toolCall.parameters }
    for (const param of definition.parameters) {
      if (!(param.name in params) && param.default !== undefined) {
        params[param.name] = param.default
      }
    }

    // Execute with timeout
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeout)

    // Link parent abort signal
    if (context.abortSignal) {
      context.abortSignal.addEventListener('abort', () => controller.abort(), {
        once: true,
      })
    }

    try {
      const execContext: ToolExecutionContext = {
        ...context,
        abortSignal: controller.signal,
      }

      const result = await executor(params, execContext)
      clearTimeout(timeoutHandle)

      const finalResult: ToolResult = {
        ...result,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        startedAt,
        finishedAt: Date.now(),
      }

      this.addToHistory(finalResult)
      return finalResult
    } catch (error: unknown) {
      clearTimeout(timeoutHandle)
      const isTimeout = error instanceof DOMException && error.name === 'AbortError'
      const status: ToolStatus = isTimeout ? 'timeout' : 'error'
      const message = isTimeout
        ? `Tool timed out after ${timeout}ms`
        : error instanceof Error
          ? error.message
          : String(error)

      const result: ToolResult = {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status,
        output: '',
        error: message,
        startedAt,
        finishedAt: Date.now(),
      }

      this.addToHistory(result)
      return result
    }
  }

  private errorResult(toolCall: ToolCall, message: string): ToolResult {
    const result: ToolResult = {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      status: 'error',
      output: '',
      error: message,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    }
    this.addToHistory(result)
    return result
  }

  private addToHistory(result: ToolResult): void {
    this.executionHistory.push(result)
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory = this.executionHistory.slice(-this.maxHistorySize)
    }
  }

  getHistory(filter?: { toolName?: string; status?: ToolStatus; limit?: number }): ToolResult[] {
    let results = [...this.executionHistory]
    if (filter?.toolName) {
      results = results.filter((r) => r.toolName === filter.toolName)
    }
    if (filter?.status) {
      results = results.filter((r) => r.status === filter.status)
    }
    if (filter?.limit) {
      results = results.slice(-filter.limit)
    }
    return results
  }

  getStats(): {
    totalExecutions: number
    successRate: number
    avgDurationMs: number
    byTool: Record<string, { count: number; errors: number; avgMs: number }>
  } {
    const total = this.executionHistory.length
    const successes = this.executionHistory.filter((r) => r.status === 'done').length
    const totalDuration = this.executionHistory.reduce(
      (sum, r) => sum + (r.finishedAt - r.startedAt),
      0
    )

    const byTool: Record<string, { count: number; errors: number; totalMs: number }> = {}
    for (const r of this.executionHistory) {
      if (!byTool[r.toolName]) {
        byTool[r.toolName] = { count: 0, errors: 0, totalMs: 0 }
      }
      byTool[r.toolName].count++
      if (r.status === 'error' || r.status === 'timeout') {
        byTool[r.toolName].errors++
      }
      byTool[r.toolName].totalMs += r.finishedAt - r.startedAt
    }

    const byToolStats: Record<string, { count: number; errors: number; avgMs: number }> = {}
    for (const [name, stats] of Object.entries(byTool)) {
      byToolStats[name] = {
        count: stats.count,
        errors: stats.errors,
        avgMs: stats.count > 0 ? Math.round(stats.totalMs / stats.count) : 0,
      }
    }

    return {
      totalExecutions: total,
      successRate: total > 0 ? Math.round((successes / total) * 100) / 100 : 1,
      avgDurationMs: total > 0 ? Math.round(totalDuration / total) : 0,
      byTool: byToolStats,
    }
  }

  clearHistory(): void {
    this.executionHistory = []
  }
}

// Singleton
export const ToolRegistry = new ToolRegistryClass()

// ── Built-in Tool Definitions ────────────────────────────────────────

export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from the workspace. Returns file content with line numbers.',
    category: 'file',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative or absolute file path', required: true },
      { name: 'offset', type: 'number', description: 'Start line number (1-indexed)', required: false, default: 1 },
      { name: 'limit', type: 'number', description: 'Max lines to read', required: false, default: 200 },
    ],
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed. Overwrites existing content.',
    category: 'file',
    dangerous: true,
    parameters: [
      { name: 'path', type: 'string', description: 'Relative or absolute file path', required: true },
      { name: 'content', type: 'string', description: 'File content to write', required: true },
    ],
  },
  {
    name: 'edit_file',
    description: 'Make targeted edits to a file by finding and replacing text. Safer than full overwrite.',
    category: 'file',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative or absolute file path', required: true },
      { name: 'oldText', type: 'string', description: 'Text to find (must be unique in file)', required: true },
      { name: 'newText', type: 'string', description: 'Replacement text', required: true },
    ],
  },
  {
    name: 'list_files',
    description: 'List files in a directory. Supports glob patterns for filtering.',
    category: 'file',
    parameters: [
      { name: 'path', type: 'string', description: 'Directory path', required: false, default: '.' },
      { name: 'pattern', type: 'string', description: 'Glob pattern (e.g. "*.ts", "**/*.tsx")', required: false },
      { name: 'maxDepth', type: 'number', description: 'Max directory depth', required: false, default: 3 },
      { name: 'limit', type: 'number', description: 'Max files to return', required: false, default: 100 },
    ],
  },
  {
    name: 'search_files',
    description: 'Search for text content across files using regex.',
    category: 'search',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Regex pattern to search for', required: true },
      { name: 'path', type: 'string', description: 'Directory to search in', required: false, default: '.' },
      { name: 'fileGlob', type: 'string', description: 'Filter files by glob (e.g. "*.ts")', required: false },
      { name: 'maxResults', type: 'number', description: 'Max matches to return', required: false, default: 50 },
    ],
  },
  {
    name: 'run_terminal',
    description: 'Execute a shell command in the workspace. Returns stdout and stderr.',
    category: 'terminal',
    dangerous: true,
    timeout: 60_000,
    parameters: [
      { name: 'command', type: 'string', description: 'Shell command to execute', required: true },
      { name: 'cwd', type: 'string', description: 'Working directory (relative to workspace)', required: false },
      { name: 'timeout', type: 'number', description: 'Timeout in ms', required: false, default: 30_000 },
      { name: 'env', type: 'object', description: 'Additional env vars', required: false },
    ],
  },
  {
    name: 'web_search',
    description: 'Search the web for information. Returns titles, URLs, and snippets.',
    category: 'web',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
      { name: 'limit', type: 'number', description: 'Max results', required: false, default: 5 },
    ],
  },
  {
    name: 'web_extract',
    description: 'Extract content from a URL as markdown text.',
    category: 'web',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to fetch', required: true },
    ],
  },
]

// ── Tool Formatting (for LLM prompt) ────────────────────────────────

export function formatToolsForPrompt(tools: ToolDefinition[]): string {
  const lines: string[] = ['## Available Tools\n']
  
  const categories = new Set(tools.map((t) => t.category))
  for (const category of Array.from(categories).sort()) {
    const categoryTools = tools.filter((t) => t.category === category)
    lines.push(`### ${category.charAt(0).toUpperCase() + category.slice(1)} Tools\n`)

    for (const tool of categoryTools) {
      lines.push(`**${tool.name}**: ${tool.description}`)
      if (tool.dangerous) {
        lines.push('  ⚠️ Requires user approval before execution')
      }
      const params = tool.parameters
        .map((p) => {
          const req = p.required ? ' (required)' : ''
          const def = p.default !== undefined ? ` [default: ${p.default}]` : ''
          return `  - ${p.name} (${p.type})${req}${def}: ${p.description}`
        })
        .join('\n')
      if (params) {
        lines.push(params)
      }
      lines.push('')
    }
  }

  lines.push(
    '\nTo call a tool, use the tool_call format with the tool name and parameters as JSON.'
  )
  return lines.join('\n')
}

export function formatToolsForOpenAI(tools: ToolDefinition[]): object[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          tool.parameters.map((p) => [
            p.name,
            {
              type: p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string',
              description: p.description,
              ...(p.enum ? { enum: p.enum } : {}),
            },
          ])
        ),
        required: tool.parameters.filter((p) => p.required).map((p) => p.name),
      },
    },
  }))
}
