// src/components/SubagentPanel.tsx
// Panel showing spawned subagents, their status, and results

import { useState, useEffect, useCallback } from 'react'

interface SubagentEntry {
  id: string
  goal: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  result?: string
  error?: string
  startedAt?: number
  finishedAt?: number
  stepsCompleted: number
  parentGoal?: string
}

interface SubagentPanelProps {
  isOpen: boolean
  onClose: () => void
  subagents?: SubagentEntry[]
  onCancel?: (id: string) => void
}

export function SubagentPanel({ isOpen, onClose, subagents = [], onCancel }: SubagentPanelProps) {
  const [filter, setFilter] = useState<string>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [history, setHistory] = useState<SubagentEntry[]>([])

  useEffect(() => {
    if (isOpen) {
      // Merge live subagents with history
      const existingIds = new Set(history.map((h) => h.id))
      const newEntries = subagents.filter((s) => !existingIds.has(s.id))
      const updated = history.map((h) => {
        const live = subagents.find((s) => s.id === h.id)
        return live || h
      })
      setHistory([...updated, ...newEntries])
    }
  }, [isOpen, subagents])

  if (!isOpen) return null

  const displayList = filter === 'all'
    ? history
    : history.filter((s) => s.status === filter)

  const stats = {
    total: history.length,
    pending: history.filter((s) => s.status === 'pending').length,
    running: history.filter((s) => s.status === 'running').length,
    done: history.filter((s) => s.status === 'done').length,
    failed: history.filter((s) => s.status === 'failed').length,
    cancelled: history.filter((s) => s.status === 'cancelled').length,
  }

  const selected = selectedId ? history.find((h) => h.id === selectedId) : null

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending': return '⏳'
      case 'running': return '🔄'
      case 'done': return '✅'
      case 'failed': return '❌'
      case 'cancelled': return '⛔'
      default: return '·'
    }
  }

  const formatDuration = (entry: SubagentEntry): string => {
    if (!entry.startedAt) return '—'
    const end = entry.finishedAt || Date.now()
    const ms = end - entry.startedAt
    if (ms < 1000) return `${ms}ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  }

  const clearCompleted = () => {
    setHistory((prev) =>
      prev.filter((s) => s.status === 'pending' || s.status === 'running')
    )
  }

  return (
    <div className="subagent-panel-overlay" onClick={onClose}>
      <div className="subagent-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="subagent-header">
          <div className="subagent-title">
            <h3>🤖 Subagents</h3>
            <div className="subagent-stats">
              {stats.running > 0 && <span className="stat running">{stats.running} running</span>}
              {stats.done > 0 && <span className="stat done">{stats.done} done</span>}
              {stats.failed > 0 && <span className="stat failed">{stats.failed} failed</span>}
            </div>
          </div>
          <div className="subagent-header-actions">
            <button className="subagent-btn-small" onClick={clearCompleted}>
              Clear Done
            </button>
            <button className="subagent-close" onClick={onClose}>×</button>
          </div>
        </div>

        {/* Filters */}
        <div className="subagent-filters">
          {['all', 'running', 'pending', 'done', 'failed'].map((f) => (
            <button
              key={f}
              className={`subagent-filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? `All (${stats.total})` :
               f === 'running' ? `🔄 ${stats.running}` :
               f === 'pending' ? `⏳ ${stats.pending}` :
               f === 'done' ? `✅ ${stats.done}` :
               `❌ ${stats.failed}`}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="subagent-list">
          {displayList.length === 0 ? (
            <div className="subagent-empty">
              <p>No subagents yet.</p>
              <p className="subagent-hint">
                Subagents are spawned automatically when the agent decomposes
                complex tasks into parallel workstreams.
              </p>
            </div>
          ) : (
            displayList.map((entry) => (
              <div
                key={entry.id}
                className={`subagent-card ${selectedId === entry.id ? 'selected' : ''} status-${entry.status}`}
                onClick={() => setSelectedId(selectedId === entry.id ? null : entry.id)}
              >
                <div className="subagent-card-header">
                  <span className="subagent-status-icon">{getStatusIcon(entry.status)}</span>
                  <span className="subagent-goal">{entry.goal}</span>
                  <span className="subagent-duration">{formatDuration(entry)}</span>
                </div>

                <div className="subagent-card-meta">
                  <span className="subagent-id">{entry.id.slice(0, 16)}...</span>
                  {entry.stepsCompleted > 0 && (
                    <span className="subagent-steps">{entry.stepsCompleted} steps</span>
                  )}
                </div>

                {/* Expanded detail */}
                {selectedId === entry.id && (
                  <div className="subagent-detail">
                    {entry.parentGoal && (
                      <div className="subagent-parent">
                        <strong>Parent:</strong> {entry.parentGoal}
                      </div>
                    )}
                    {entry.result && (
                      <div className="subagent-result">
                        <strong>Result:</strong>
                        <pre>{entry.result.slice(0, 2000)}</pre>
                      </div>
                    )}
                    {entry.error && (
                      <div className="subagent-error">
                        <strong>Error:</strong> {entry.error}
                      </div>
                    )}
                    {entry.status === 'running' && onCancel && (
                      <button
                        className="subagent-btn-cancel"
                        onClick={(e) => {
                          e.stopPropagation()
                          onCancel(entry.id)
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
