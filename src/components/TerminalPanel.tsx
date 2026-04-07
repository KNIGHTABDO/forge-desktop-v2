// src/components/TerminalPanel.tsx
// Embedded sandboxed terminal for command execution

import { useState, useRef, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface TerminalEntry {
  id: string
  type: 'input' | 'output' | 'error' | 'system'
  content: string
  timestamp: number
  exitCode?: number
}

interface TerminalPanelProps {
  isOpen: boolean
  onClose: () => void
  workspacePath?: string
}

function makeId(): string {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID()
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

export function TerminalPanel({ isOpen, onClose, workspacePath }: TerminalPanelProps) {
  const [entries, setEntries] = useState<TerminalEntry[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [commandHistory, setCommandHistory] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [entries, scrollToBottom])

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
    if (isOpen && entries.length === 0) {
      setEntries([{
        id: makeId(),
        type: 'system',
        content: `Forge Terminal — Workspace: ${workspacePath || 'none'}`,
        timestamp: Date.now(),
      }])
    }
  }, [isOpen])

  if (!isOpen) return null

  const executeCommand = async (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed) return

    // Add to history
    setCommandHistory((prev) => [...prev.slice(-50), trimmed])
    setHistoryIndex(-1)

    // Handle built-in commands
    if (trimmed === 'clear' || trimmed === 'cls') {
      setEntries([])
      return
    }

    if (trimmed === 'pwd') {
      setEntries((prev) => [...prev,
        { id: makeId(), type: 'input', content: `$ ${trimmed}`, timestamp: Date.now() },
        { id: makeId(), type: 'output', content: workspacePath || process.cwd(), timestamp: Date.now() },
      ])
      return
    }

    if (trimmed === 'help') {
      setEntries((prev) => [...prev,
        { id: makeId(), type: 'input', content: `$ ${trimmed}`, timestamp: Date.now() },
        {
          id: makeId(),
          type: 'output',
          content: [
            'Built-in commands:',
            '  clear/cls  — Clear terminal',
            '  pwd        — Print working directory',
            '  help       — Show this help',
            '',
            'All other commands are executed via sandboxed shell.',
            'Dangerous commands (rm -rf /, mkfs, etc.) are blocked.',
          ].join('\n'),
          timestamp: Date.now(),
        },
      ])
      return
    }

    // Add input entry
    const inputEntry: TerminalEntry = {
      id: makeId(),
      type: 'input',
      content: `$ ${trimmed}`,
      timestamp: Date.now(),
    }
    setEntries((prev) => [...prev, inputEntry])
    setRunning(true)
    setInput('')

    try {
      const result = await invoke<{
        ok: boolean
        output: string
        error: string
        code: number
      }>('run_command_sandboxed', {
        command: trimmed,
        cwd: workspacePath || null,
        timeout: 60_000,
      })

      const outputContent = result.output || ''
      const errorContent = result.error || ''

      if (outputContent) {
        setEntries((prev) => [...prev, {
          id: makeId(),
          type: 'output',
          content: outputContent,
          timestamp: Date.now(),
          exitCode: result.code,
        }])
      }

      if (errorContent && !result.ok) {
        setEntries((prev) => [...prev, {
          id: makeId(),
          type: 'error',
          content: errorContent,
          timestamp: Date.now(),
          exitCode: result.code,
        }])
      }

      // Show exit code for non-zero
      if (result.code !== 0) {
        setEntries((prev) => [...prev, {
          id: makeId(),
          type: 'system',
          content: `Process exited with code ${result.code}`,
          timestamp: Date.now(),
        }])
      }
    } catch (e) {
      setEntries((prev) => [...prev, {
        id: makeId(),
        type: 'error',
        content: `Execution error: ${String(e)}`,
        timestamp: Date.now(),
      }])
    } finally {
      setRunning(false)
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      executeCommand(input)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (commandHistory.length === 0) return
      const newIdx = historyIndex === -1
        ? commandHistory.length - 1
        : Math.max(0, historyIndex - 1)
      setHistoryIndex(newIdx)
      setInput(commandHistory[newIdx] || '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex === -1) return
      const newIdx = historyIndex + 1
      if (newIdx >= commandHistory.length) {
        setHistoryIndex(-1)
        setInput('')
      } else {
        setHistoryIndex(newIdx)
        setInput(commandHistory[newIdx] || '')
      }
    }
  }

  const getPrompt = () => {
    const dir = workspacePath
      ? workspacePath.split(/[/\\]/).pop() || workspacePath
      : '~'
    return `${dir} $`
  }

  return (
    <div className="terminal-panel-overlay" onClick={onClose}>
      <div className="terminal-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="terminal-header">
          <div className="terminal-title">
            <h3>⌨️ Terminal</h3>
            {workspacePath && (
              <span className="terminal-cwd" title={workspacePath}>
                {workspacePath.split(/[/\\]/).pop()}
              </span>
            )}
          </div>
          <div className="terminal-actions">
            <button
              className="terminal-btn-small"
              onClick={() => setEntries([])}
              title="Clear terminal"
            >
              Clear
            </button>
            <button className="terminal-close" onClick={onClose}>×</button>
          </div>
        </div>

        {/* Output */}
        <div className="terminal-output" ref={scrollRef}>
          {entries.map((entry) => (
            <div key={entry.id} className={`terminal-line terminal-${entry.type}`}>
              <pre>{entry.content}</pre>
            </div>
          ))}

          {/* Input prompt */}
          <div className="terminal-input-line">
            <span className="terminal-prompt">{getPrompt()}</span>
            <input
              ref={inputRef}
              type="text"
              className="terminal-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={running}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              placeholder={running ? 'Running...' : 'Type a command...'}
            />
            {running && <span className="terminal-spinner">⟳</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
