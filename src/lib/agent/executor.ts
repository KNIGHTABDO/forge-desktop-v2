// src/lib/agent/executor.ts
// Built-in tool executors — connects tool definitions to real operations

import { invoke } from '@tauri-apps/api/core'
import { ToolRegistry } from './tools'
import type { ToolExecutor, ToolResult, ToolExecutionContext } from './types'

// ── Tauri Bridge Types ───────────────────────────────────────────────

type TauriCommandResult =
  | { ok: true; output: string; code: number }
  | { ok: false; error: string; code: number }

// ── Helpers ──────────────────────────────────────────────────────────

function resolvePath(workspacePath: string, requestedPath: string): string {
  if (!requestedPath) return workspacePath || '.'
  // If absolute, use as-is
  if (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(requestedPath)) return requestedPath
  // If no workspace, return relative
  if (!workspacePath) return requestedPath
  return `${workspacePath.replace(/[\\/]+$/, '')}/${requestedPath}`
}

// ── File Tool Executors ──────────────────────────────────────────────

const readFileExecutor: ToolExecutor = async (params, context) => {
  const start = Date.now()
  const filePath = resolvePath(context.workspacePath, params.path as string)
  const offset = (params.offset as number) || 1
  const limit = (params.limit as number) || 200

  try {
    const result = await invoke<TauriCommandResult>('read_file_command', {
      path: filePath,
      offset,
      limit,
    })

    if (!result.ok) {
      return {
        toolCallId: '',
        toolName: 'read_file',
        status: 'error',
        output: '',
        error: result.error,
        startedAt: start,
        finishedAt: Date.now(),
      }
    }

    return {
      toolCallId: '',
      toolName: 'read_file',
      status: 'done' as const,
      output: result.output,
      startedAt: start,
      finishedAt: Date.now(),
    }
  } catch (e: unknown) {
    return {
      toolCallId: '',
      toolName: 'read_file',
      status: 'error' as const,
      output: '',
      error: e instanceof Error ? e.message : String(e),
      startedAt: start,
      finishedAt: Date.now(),
    }
  }
}

const writeFileExecutor: ToolExecutor = async (params, context) => {
  const start = Date.now()
  const filePath = resolvePath(context.workspacePath, params.path as string)
  const content = params.content as string

  try {
    const result = await invoke<TauriCommandResult>('write_file_command', {
      path: filePath,
      content,
    })

    if (!result.ok) {
      return {
        toolCallId: '',
        toolName: 'write_file',
        status: 'error' as const,
        output: '',
        error: result.error,
        startedAt: start,
        finishedAt: Date.now(),
      }
    }

    return {
      toolCallId: '',
      toolName: 'write_file',
      status: 'done' as const,
      output: result.output || `File written: ${params.path}`,
      startedAt: start,
      finishedAt: Date.now(),
    }
  } catch (e: unknown) {
    return {
      toolCallId: '',
      toolName: 'write_file',
      status: 'error' as const,
      output: '',
      error: e instanceof Error ? e.message : String(e),
      startedAt: start,
      finishedAt: Date.now(),
    }
  }
}

const editFileExecutor: ToolExecutor = async (params, context) => {
  const start = Date.now()
  const filePath = resolvePath(context.workspacePath, params.path as string)
  const oldText = params.oldText as string
  const newText = params.newText as string

  try {
    const result = await invoke<TauriCommandResult>('edit_file_command', {
      path: filePath,
      oldText,
      newText,
    })

    if (!result.ok) {
      return {
        toolCallId: '',
        toolName: 'edit_file',
        status: 'error' as const,
        output: '',
        error: result.error,
        startedAt: start,
        finishedAt: Date.now(),
      }
    }

    return {
      toolCallId: '',
      toolName: 'edit_file',
      status: 'done' as const,
      output: result.output || `File edited: ${params.path}`,
      startedAt: start,
      finishedAt: Date.now(),
    }
  } catch (e: unknown) {
    return {
      toolCallId: '',
      toolName: 'edit_file',
      status: 'error' as const,
      output: '',
      error: e instanceof Error ? e.message : String(e),
      startedAt: start,
      finishedAt: Date.now(),
    }
  }
}

const listFilesExecutor: ToolExecutor = async (params, context) => {
  const start = Date.now()
  const dirPath = resolvePath(context.workspacePath, (params.path as string) || '.')
  const pattern = (params.pattern as string) || '*'
  const maxDepth = (params.maxDepth as number) || 3
  const limit = (params.limit as number) || 100

  try {
    const result = await invoke<TauriCommandResult>('list_files_command', {
      path: dirPath,
      pattern,
      maxDepth,
      limit,
    })

    if (!result.ok) {
      return {
        toolCallId: '',
        toolName: 'list_files',
        status: 'error' as const,
        output: '',
        error: result.error,
        startedAt: start,
        finishedAt: Date.now(),
      }
    }

    return {
      toolCallId: '',
      toolName: 'list_files',
      status: 'done' as const,
      output: result.output,
      startedAt: start,
      finishedAt: Date.now(),
    }
  } catch (e: unknown) {
    return {
      toolCallId: '',
      toolName: 'list_files',
      status: 'error' as const,
      output: '',
      error: e instanceof Error ? e.message : String(e),
      startedAt: start,
      finishedAt: Date.now(),
    }
  }
}

const searchFilesExecutor: ToolExecutor = async (params, context) => {
  const start = Date.now()
  const searchPath = resolvePath(context.workspacePath, (params.path as string) || '.')
  const pattern = params.pattern as string
  const fileGlob = params.fileGlob as string | undefined
  const maxResults = (params.maxResults as number) || 50

  try {
    const result = await invoke<TauriCommandResult>('search_files_command', {
      path: searchPath,
      pattern,
      fileGlob: fileGlob || null,
      maxResults,
    })

    if (!result.ok) {
      return {
        toolCallId: '',
        toolName: 'search_files',
        status: 'error' as const,
        output: '',
        error: result.error,
        startedAt: start,
        finishedAt: Date.now(),
      }
    }

    return {
      toolCallId: '',
      toolName: 'search_files',
      status: 'done' as const,
      output: result.output,
      startedAt: start,
      finishedAt: Date.now(),
    }
  } catch (e: unknown) {
    return {
      toolCallId: '',
      toolName: 'search_files',
      status: 'error' as const,
      output: '',
      error: e instanceof Error ? e.message : String(e),
      startedAt: start,
      finishedAt: Date.now(),
    }
  }
}

// ── Terminal Executor ────────────────────────────────────────────────

const runTerminalExecutor: ToolExecutor = async (params, context) => {
  const start = Date.now()
  const command = params.command as string
  const cwd = params.cwd
    ? resolvePath(context.workspacePath, params.cwd as string)
    : context.workspacePath
  const timeout = (params.timeout as number) || 30_000

  try {
    const result = await invoke<TauriCommandResult>('run_command_sandboxed', {
      command,
      cwd: cwd || null,
      timeout,
    })

    if (!result.ok) {
      return {
        toolCallId: '',
        toolName: 'run_terminal',
        status: 'error' as const,
        output: result.output || '',
        error: result.error,
        startedAt: start,
        finishedAt: Date.now(),
      }
    }

    return {
      toolCallId: '',
      toolName: 'run_terminal',
      status: 'done' as const,
      output: result.output,
      startedAt: start,
      finishedAt: Date.now(),
      metadata: { exitCode: result.code },
    }
  } catch (e: unknown) {
    return {
      toolCallId: '',
      toolName: 'run_terminal',
      status: 'error' as const,
      output: '',
      error: e instanceof Error ? e.message : String(e),
      startedAt: start,
      finishedAt: Date.now(),
    }
  }
}

// ── Web Tool Executors ───────────────────────────────────────────────

const webSearchExecutor: ToolExecutor = async (params) => {
  const start = Date.now()
  const query = params.query as string
  const limit = (params.limit as number) || 5

  try {
    const result = await invoke<TauriCommandResult>('web_search_command', {
      query,
      limit,
    })

    if (!result.ok) {
      return {
        toolCallId: '',
        toolName: 'web_search',
        status: 'error' as const,
        output: '',
        error: result.error,
        startedAt: start,
        finishedAt: Date.now(),
      }
    }

    return {
      toolCallId: '',
      toolName: 'web_search',
      status: 'done' as const,
      output: result.output,
      startedAt: start,
      finishedAt: Date.now(),
    }
  } catch (e: unknown) {
    return {
      toolCallId: '',
      toolName: 'web_search',
      status: 'error' as const,
      output: '',
      error: e instanceof Error ? e.message : String(e),
      startedAt: start,
      finishedAt: Date.now(),
    }
  }
}

const webExtractExecutor: ToolExecutor = async (params) => {
  const start = Date.now()
  const url = params.url as string

  try {
    const result = await invoke<TauriCommandResult>('web_extract_command', {
      url,
    })

    if (!result.ok) {
      return {
        toolCallId: '',
        toolName: 'web_extract',
        status: 'error' as const,
        output: '',
        error: result.error,
        startedAt: start,
        finishedAt: Date.now(),
      }
    }

    return {
      toolCallId: '',
      toolName: 'web_extract',
      status: 'done' as const,
      output: result.output,
      startedAt: start,
      finishedAt: Date.now(),
    }
  } catch (e: unknown) {
    return {
      toolCallId: '',
      toolName: 'web_extract',
      status: 'error' as const,
      output: '',
      error: e instanceof Error ? e.message : String(e),
      startedAt: start,
      finishedAt: Date.now(),
    }
  }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerBuiltinExecutors(): void {
  ToolRegistry.register(
    ToolRegistry.getDefinition('read_file') || {
      name: 'read_file',
      description: '',
      category: 'file',
      parameters: [],
    },
    readFileExecutor
  )

  ToolRegistry.register(
    ToolRegistry.getDefinition('write_file') || {
      name: 'write_file',
      description: '',
      category: 'file',
      parameters: [],
    },
    writeFileExecutor
  )

  ToolRegistry.register(
    ToolRegistry.getDefinition('edit_file') || {
      name: 'edit_file',
      description: '',
      category: 'file',
      parameters: [],
    },
    editFileExecutor
  )

  ToolRegistry.register(
    ToolRegistry.getDefinition('list_files') || {
      name: 'list_files',
      description: '',
      category: 'file',
      parameters: [],
    },
    listFilesExecutor
  )

  ToolRegistry.register(
    ToolRegistry.getDefinition('search_files') || {
      name: 'search_files',
      description: '',
      category: 'search',
      parameters: [],
    },
    searchFilesExecutor
  )

  ToolRegistry.register(
    ToolRegistry.getDefinition('run_terminal') || {
      name: 'run_terminal',
      description: '',
      category: 'terminal',
      parameters: [],
    },
    runTerminalExecutor
  )

  ToolRegistry.register(
    ToolRegistry.getDefinition('web_search') || {
      name: 'web_search',
      description: '',
      category: 'web',
      parameters: [],
    },
    webSearchExecutor
  )

  ToolRegistry.register(
    ToolRegistry.getDefinition('web_extract') || {
      name: 'web_extract',
      description: '',
      category: 'web',
      parameters: [],
    },
    webExtractExecutor
  )
}
