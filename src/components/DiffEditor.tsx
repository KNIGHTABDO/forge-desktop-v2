// src/components/DiffEditor.tsx
// Visual diff editor with approve/reject workflow for safe code changes

import { useState, useMemo, useCallback } from 'react'

export interface DiffLine {
  type: 'context' | 'added' | 'removed'
  content: string
  oldLineNum?: number
  newLineNum?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
  oldStart: number
  newStart: number
}

export interface DiffEditorProps {
  original: string
  modified: string
  fileName?: string
  language?: string
  onApprove?: () => void
  onReject?: () => void
  onModify?: (newContent: string) => void
  readOnly?: boolean
  showLineNumbers?: boolean
}

// ── Diff Computation ─────────────────────────────────────────────────

function computeDiff(original: string, modified: string): DiffLine[] {
  const origLines = original.split('\n')
  const modLines = modified.split('\n')

  // Simple LCS-based diff
  const m = origLines.length
  const n = modLines.length

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origLines[i - 1] === modLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to get diff
  const result: DiffLine[] = []
  let i = m
  let j = n
  const stack: DiffLine[] = []

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === modLines[j - 1]) {
      stack.push({
        type: 'context',
        content: origLines[i - 1],
        oldLineNum: i,
        newLineNum: j,
      })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({
        type: 'added',
        content: modLines[j - 1],
        newLineNum: j,
      })
      j--
    } else {
      stack.push({
        type: 'removed',
        content: origLines[i - 1],
        oldLineNum: i,
      })
      i--
    }
  }

  // Reverse and return
  while (stack.length > 0) {
    result.push(stack.pop()!)
  }

  return result
}

function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.type === 'added') added++
    if (line.type === 'removed') removed++
  }
  return { added, removed }
}

// ── Component ────────────────────────────────────────────────────────

export function DiffEditor({
  original,
  modified,
  fileName,
  onApprove,
  onReject,
  readOnly = false,
  showLineNumbers = true,
}: DiffEditorProps) {
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified')

  const diffLines = useMemo(() => computeDiff(original, modified), [original, modified])
  const changes = useMemo(() => countChanges(diffLines), [diffLines])
  const hasChanges = changes.added > 0 || changes.removed > 0

  const getLineClass = (type: DiffLine['type']): string => {
    switch (type) {
      case 'added': return 'diff-line-added'
      case 'removed': return 'diff-line-removed'
      default: return 'diff-line-context'
    }
  }

  const getLinePrefix = (type: DiffLine['type']): string => {
    switch (type) {
      case 'added': return '+'
      case 'removed': return '-'
      default: return ' '
    }
  }

  if (!hasChanges) {
    return (
      <div className="diff-editor-empty">
        <p>No changes detected.</p>
      </div>
    )
  }

  return (
    <div className="diff-editor">
      {/* Header */}
      <div className="diff-header">
        <div className="diff-file-info">
          {fileName && <span className="diff-filename">{fileName}</span>}
          <span className="diff-stats">
            <span className="diff-stat-added">+{changes.added}</span>
            {' '}
            <span className="diff-stat-removed">-{changes.removed}</span>
          </span>
        </div>
        <div className="diff-controls">
          <button
            className={`diff-view-btn ${viewMode === 'unified' ? 'active' : ''}`}
            onClick={() => setViewMode('unified')}
          >
            Unified
          </button>
          <button
            className={`diff-view-btn ${viewMode === 'split' ? 'active' : ''}`}
            onClick={() => setViewMode('split')}
          >
            Split
          </button>
        </div>
      </div>

      {/* Diff Content */}
      <div className="diff-content">
        {viewMode === 'unified' ? (
          <table className="diff-table">
            <tbody>
              {diffLines.map((line, idx) => (
                <tr key={idx} className={getLineClass(line.type)}>
                  {showLineNumbers && (
                    <>
                      <td className="diff-line-num old-num">{line.oldLineNum || ''}</td>
                      <td className="diff-line-num new-num">{line.newLineNum || ''}</td>
                    </>
                  )}
                  <td className="diff-line-prefix">{getLinePrefix(line.type)}</td>
                  <td className="diff-line-content">{line.content}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <SplitDiffView
            lines={diffLines}
            showLineNumbers={showLineNumbers}
          />
        )}
      </div>

      {/* Actions */}
      {!readOnly && (onApprove || onReject) && (
        <div className="diff-actions">
          {onReject && (
            <button className="diff-btn diff-btn-reject" onClick={onReject}>
              Reject Changes
            </button>
          )}
          {onApprove && (
            <button className="diff-btn diff-btn-approve" onClick={onApprove}>
              Approve & Apply
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Split View ───────────────────────────────────────────────────────

interface SplitDiffViewProps {
  lines: DiffLine[]
  showLineNumbers: boolean
}

function SplitDiffView({ lines, showLineNumbers }: SplitDiffViewProps) {
  // Build left (original) and right (modified) columns
  const rows: Array<{
    left: DiffLine | null
    right: DiffLine | null
  }> = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (line.type === 'context') {
      rows.push({ left: line, right: line })
      i++
    } else if (line.type === 'removed') {
      // Pair with next added line if available
      const next = lines[i + 1]
      if (next && next.type === 'added') {
        rows.push({ left: line, right: next })
        i += 2
      } else {
        rows.push({ left: line, right: null })
        i++
      }
    } else if (line.type === 'added') {
      rows.push({ left: null, right: line })
      i++
    } else {
      i++
    }
  }

  return (
    <div className="diff-split">
      <table className="diff-table diff-table-left">
        <tbody>
          {rows.map((row, idx) => (
            <tr
              key={idx}
              className={row.left ? getLineClass(row.left.type) : 'diff-line-empty'}
            >
              {showLineNumbers && (
                <td className="diff-line-num">{row.left?.oldLineNum || ''}</td>
              )}
              <td className="diff-line-prefix">{row.left ? getLinePrefix(row.left.type) : ''}</td>
              <td className="diff-line-content">{row.left?.content || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="diff-table diff-table-right">
        <tbody>
          {rows.map((row, idx) => (
            <tr
              key={idx}
              className={row.right ? getLineClass(row.right.type) : 'diff-line-empty'}
            >
              {showLineNumbers && (
                <td className="diff-line-num">{row.right?.newLineNum || ''}</td>
              )}
              <td className="diff-line-prefix">{row.right ? getLinePrefix(row.right.type) : ''}</td>
              <td className="diff-line-content">{row.right?.content || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function getLineClass(type: DiffLine['type']): string {
  switch (type) {
    case 'added': return 'diff-line-added'
    case 'removed': return 'diff-line-removed'
    default: return 'diff-line-context'
  }
}

function getLinePrefix(type: DiffLine['type']): string {
  switch (type) {
    case 'added': return '+'
    case 'removed': return '-'
    default: return ' '
  }
}
