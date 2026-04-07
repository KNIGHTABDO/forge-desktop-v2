// src/components/VectorPanel.tsx
// Panel for workspace vector indexing and semantic search (RAG)

import { useState, useCallback, useEffect } from 'react'
import { VectorSearch } from '../lib/vector'
import type { VectorSearchResult, IndexStats } from '../lib/vector'
import { invoke } from '@tauri-apps/api/core'

interface VectorPanelProps {
  isOpen: boolean
  onClose: () => void
  workspacePath?: string
  onInsertContext?: (text: string) => void
}

type PanelView = 'search' | 'index' | 'history'

export function VectorPanel({ isOpen, onClose, workspacePath, onInsertContext }: VectorPanelProps) {
  const [view, setView] = useState<PanelView>('search')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<VectorSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [indexProgress, setIndexProgress] = useState('')
  const [stats, setStats] = useState<IndexStats | null>(null)
  const [recentQueries, setRecentQueries] = useState<string[]>([])

  const refreshStats = useCallback(() => {
    setStats(VectorSearch.getStats())
  }, [])

  useEffect(() => {
    if (isOpen) {
      refreshStats()
      const stored = localStorage.getItem('forge-vector-recent-queries')
      if (stored) {
        try {
          setRecentQueries(JSON.parse(stored))
        } catch { /* ignore */ }
      }
    }
  }, [isOpen, refreshStats])

  if (!isOpen) return null

  const handleSearch = async () => {
    if (!query.trim()) return
    setSearching(true)

    try {
      const searchResults = await VectorSearch.search(query, 8)
      setResults(searchResults)

      // Save to recent queries
      const updated = [query, ...recentQueries.filter((q) => q !== query)].slice(0, 10)
      setRecentQueries(updated)
      localStorage.setItem('forge-vector-recent-queries', JSON.stringify(updated))
    } catch (e) {
      console.error('Search error:', e)
    } finally {
      setSearching(false)
    }
  }

  const handleIndex = async () => {
    if (!workspacePath) return
    setIndexing(true)
    setIndexProgress('Starting indexing...')

    try {
      const fileReader = async (path: string): Promise<string | null> => {
        try {
          const result = await invoke<{ ok: boolean; output: string; error: string }>(
            'read_file_command',
            { path, offset: 1, limit: 500 }
          )
          return result.ok ? result.output : null
        } catch {
          return null
        }
      }

      const indexStats = await VectorSearch.indexWorkspace(workspacePath, fileReader)
      setStats(indexStats)
      setIndexProgress(`Indexed ${indexStats.totalFiles} files, ${indexStats.totalChunks} chunks`)
    } catch (e) {
      setIndexProgress(`Error: ${String(e)}`)
    } finally {
      setIndexing(false)
    }
  }

  const handleClear = () => {
    VectorSearch.clear()
    setResults([])
    refreshStats()
  }

  const handleInsertResult = (result: VectorSearchResult) => {
    const text = [
      `## Context from ${result.document.path}`,
      `Score: ${result.score}`,
      '',
      result.matchedText,
    ].join('\n')
    onInsertContext?.(text)
  }

  const formatLastIndexed = (timestamp: number | null): string => {
    if (!timestamp) return 'Never'
    const diff = Date.now() - timestamp
    const mins = Math.floor(diff / 60_000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  return (
    <div className="vector-panel-overlay" onClick={onClose}>
      <div className="vector-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="vector-panel-header">
          <div className="vector-panel-title">
            <h3>🔍 Vector Search</h3>
            {stats && (
              <span className="vector-stats-badge">
                {stats.totalFiles} files · {stats.totalChunks} chunks
              </span>
            )}
          </div>
          <div className="vector-panel-actions">
            <button
              className={`vector-tab ${view === 'search' ? 'active' : ''}`}
              onClick={() => setView('search')}
            >
              Search
            </button>
            <button
              className={`vector-tab ${view === 'index' ? 'active' : ''}`}
              onClick={() => setView('index')}
            >
              Index
            </button>
            <button className="vector-btn-close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        {/* Search View */}
        {view === 'search' && (
          <>
            <div className="vector-search-bar">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Search workspace semantically..."
                className="vector-search-input"
                autoFocus
              />
              <button
                className="vector-search-btn"
                onClick={handleSearch}
                disabled={searching || !query.trim()}
              >
                {searching ? '...' : 'Search'}
              </button>
            </div>

            {/* Recent Queries */}
            {recentQueries.length > 0 && results.length === 0 && (
              <div className="vector-recent">
                <span className="vector-recent-label">Recent:</span>
                {recentQueries.slice(0, 5).map((q, i) => (
                  <button
                    key={i}
                    className="vector-recent-btn"
                    onClick={() => {
                      setQuery(q)
                      handleSearch()
                    }}
                  >
                    {q.length > 30 ? q.slice(0, 30) + '...' : q}
                  </button>
                ))}
              </div>
            )}

            {/* Results */}
            <div className="vector-results">
              {results.length === 0 && query && !searching && (
                <div className="vector-no-results">
                  <p>No results found.</p>
                  {(!stats || stats.totalChunks === 0) && (
                    <p className="vector-hint">
                      Index your workspace first to enable semantic search.
                      <button
                        className="vector-link-btn"
                        onClick={() => setView('index')}
                      >
                        Go to Index →
                      </button>
                    </p>
                  )}
                </div>
              )}

              {results.map((result, i) => (
                <div key={i} className="vector-result-card">
                  <div className="vector-result-header">
                    <span className="vector-result-path" title={result.document.path}>
                      {result.document.path.split(/[/\\]/).pop()}
                    </span>
                    <span className="vector-result-score">
                      {Math.round(result.score * 100)}%
                    </span>
                  </div>
                  <pre className="vector-result-content">{result.matchedText}</pre>
                  <div className="vector-result-footer">
                    <span className="vector-result-file">
                      {result.document.path}
                    </span>
                    <button
                      className="vector-insert-btn"
                      onClick={() => handleInsertResult(result)}
                      title="Insert as context for the agent"
                    >
                      + Context
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Index View */}
        {view === 'index' && (
          <div className="vector-index">
            <div className="vector-index-status">
              <h4>Index Status</h4>
              {stats ? (
                <div className="vector-index-stats">
                  <div className="stat-row">
                    <span className="stat-label">Files indexed</span>
                    <span className="stat-value">{stats.totalFiles}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">Total chunks</span>
                    <span className="stat-value">{stats.totalChunks}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">Vector entries</span>
                    <span className="stat-value">{stats.totalDocuments}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">Last indexed</span>
                    <span className="stat-value">{formatLastIndexed(stats.lastIndexed)}</span>
                  </div>
                </div>
              ) : (
                <p className="vector-muted">No index built yet.</p>
              )}
            </div>

            <div className="vector-index-actions">
              {!workspacePath ? (
                <p className="vector-muted">Select a workspace first to index files.</p>
              ) : (
                <>
                  <p className="vector-workspace">
                    Workspace: <code>{workspacePath}</code>
                  </p>

                  {indexProgress && (
                    <div className={`vector-progress ${indexProgress.startsWith('Error') ? 'error' : ''}`}>
                      {indexProgress}
                    </div>
                  )}

                  <div className="vector-index-buttons">
                    <button
                      className="vector-btn-primary"
                      onClick={handleIndex}
                      disabled={indexing}
                    >
                      {indexing ? '⏳ Indexing...' : '🔄 Rebuild Index'}
                    </button>
                    <button
                      className="vector-btn-danger"
                      onClick={handleClear}
                      disabled={indexing}
                    >
                      🗑 Clear Index
                    </button>
                  </div>

                  <p className="vector-hint">
                    Indexing scans all source files (.ts, .js, .py, .rs, .md, etc.) and creates
                    vector embeddings for semantic search. This runs locally — no data leaves your machine.
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
