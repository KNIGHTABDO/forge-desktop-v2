// src/lib/agent/memory.ts
// Agent working memory with token-aware pruning

import type { MemoryEntry, AgentMemory, ToolResult, AgentTurn } from './types'

const APPROX_CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
}

function makeId(prefix: string): string {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

// ── Memory Store ─────────────────────────────────────────────────────

export class AgentMemoryStore implements AgentMemory {
  entries: MemoryEntry[] = []
  maxTokens: number
  currentTokens: number = 0

  constructor(maxTokens: number = 50_000) {
    this.maxTokens = maxTokens
  }

  add(
    type: MemoryEntry['type'],
    content: string,
    source: string,
    tags: string[] = [],
    relevance: number = 0.5
  ): MemoryEntry {
    const tokens = estimateTokens(content)
    const entry: MemoryEntry = {
      id: makeId('mem'),
      type,
      content,
      source,
      relevance,
      tokens,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      tags,
    }

    this.entries.push(entry)
    this.currentTokens += tokens
    this.pruneIfNeeded()
    return entry
  }

  addToolResult(result: ToolResult): void {
    const content = result.status === 'done' ? result.output : result.error || 'Unknown error'
    const relevance = result.status === 'done' ? 0.6 : 0.8 // errors are important to remember
    this.add('tool_output', content, `tool:${result.toolName}`, [result.toolName, result.status], relevance)
  }

  addTurn(turn: AgentTurn): void {
    if (turn.role === 'user') {
      this.add('fact', turn.content, 'user_message', ['user_input'], 0.9)
    } else if (turn.role === 'assistant' && turn.content.trim()) {
      this.add('fact', turn.content, 'assistant_response', ['assistant_output'], 0.4)
    }
    if (turn.toolResults) {
      for (const result of turn.toolResults) {
        this.addToolResult(result)
      }
    }
  }

  addFileContent(path: string, content: string): void {
    this.add('file_content', content, `file:${path}`, [path, 'file'], 0.7)
  }

  addPlan(goal: string, steps: string[]): void {
    const content = `Goal: ${goal}\nSteps:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
    this.add('plan', content, 'agent_plan', ['plan'], 0.9)
  }

  get(id: string): MemoryEntry | undefined {
    const entry = this.entries.find((e) => e.id === id)
    if (entry) {
      entry.lastAccessedAt = Date.now()
      entry.accessCount++
    }
    return entry
  }

  getByTag(tag: string): MemoryEntry[] {
    return this.entries.filter((e) => e.tags.includes(tag))
  }

  getByType(type: MemoryEntry['type']): MemoryEntry[] {
    return this.entries.filter((e) => e.type === type)
  }

  search(query: string, limit: number = 10): MemoryEntry[] {
    const queryLower = query.toLowerCase()
    const terms = queryLower.split(/\s+/).filter(Boolean)

    const scored = this.entries.map((entry) => {
      const contentLower = entry.content.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (contentLower.includes(term)) score += 1
      }
      // Boost by relevance and recency
      score *= entry.relevance
      const ageMinutes = (Date.now() - entry.createdAt) / 60_000
      score *= Math.max(0.1, 1 - ageMinutes / 120) // decay over 2 hours
      return { entry, score }
    })

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => {
        s.entry.lastAccessedAt = Date.now()
        s.entry.accessCount++
        return s.entry
      })
  }

  // Build context string for LLM — most relevant entries within token budget
  buildContext(maxTokens: number = 8000): string {
    const sorted = [...this.entries]
      .filter((e) => e.relevance > 0.3)
      .sort((a, b) => {
        // Prioritize: high relevance > recent > frequently accessed
        const relDiff = b.relevance - a.relevance
        if (Math.abs(relDiff) > 0.2) return relDiff
        const timeDiff = b.lastAccessedAt - a.lastAccessedAt
        if (Math.abs(timeDiff) > 60_000) return timeDiff
        return b.accessCount - a.accessCount
      })

    const sections: string[] = []
    let usedTokens = 0

    for (const entry of sorted) {
      if (usedTokens + entry.tokens > maxTokens) continue

      const prefix = this.typeToPrefix(entry.type)
      const truncated =
        entry.tokens > 500
          ? entry.content.slice(0, 2000) + '\n[... truncated ...]'
          : entry.content

      sections.push(`[${prefix}] (source: ${entry.source})\n${truncated}`)
      usedTokens += entry.tokens
    }

    if (sections.length === 0) return ''
    return `## Agent Memory (relevant context)\n\n${sections.join('\n\n---\n\n')}`
  }

  private typeToPrefix(type: MemoryEntry['type']): string {
    switch (type) {
      case 'fact': return 'Context'
      case 'file_content': return 'File'
      case 'search_result': return 'Search'
      case 'tool_output': return 'Tool Result'
      case 'plan': return 'Plan'
      case 'reflection': return 'Reflection'
    }
  }

  // Token-aware pruning: remove lowest value entries when over budget
  pruneIfNeeded(): void {
    if (this.currentTokens <= this.maxTokens) return

    // Sort by value (ascending) — least valuable first
    const sorted = [...this.entries].sort((a, b) => {
      const valueA = this.computeValue(a)
      const valueB = this.computeValue(b)
      return valueA - valueB
    })

    let pruned = 0
    while (this.currentTokens > this.maxTokens * 0.8 && sorted.length > 0) {
      const entry = sorted.shift()!
      const idx = this.entries.indexOf(entry)
      if (idx >= 0) {
        this.entries.splice(idx, 1)
        this.currentTokens -= entry.tokens
        pruned++
      }
    }

    if (pruned > 0) {
      console.log(`[Memory] Pruned ${pruned} entries, now ${this.currentTokens} tokens`)
    }
  }

  private computeValue(entry: MemoryEntry): number {
    let value = entry.relevance * 10

    // Recency bonus
    const ageMinutes = (Date.now() - entry.createdAt) / 60_000
    value += Math.max(0, 5 - ageMinutes / 30)

    // Access frequency bonus
    value += Math.min(entry.accessCount * 0.5, 3)

    // Plans and reflections are valuable
    if (entry.type === 'plan') value += 5
    if (entry.type === 'reflection') value += 3

    // Recent tool outputs matter
    if (entry.type === 'tool_output' && ageMinutes < 10) value += 4

    return value
  }

  clear(): void {
    this.entries = []
    this.currentTokens = 0
  }

  getStats(): { totalEntries: number; totalTokens: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {}
    for (const entry of this.entries) {
      byType[entry.type] = (byType[entry.type] || 0) + 1
    }
    return {
      totalEntries: this.entries.length,
      totalTokens: this.currentTokens,
      byType,
    }
  }

  // Snapshot for serialization
  serialize(): string {
    return JSON.stringify({
      entries: this.entries,
      maxTokens: this.maxTokens,
      currentTokens: this.currentTokens,
    })
  }

  static deserialize(data: string): AgentMemoryStore {
    const parsed = JSON.parse(data)
    const store = new AgentMemoryStore(parsed.maxTokens)
    store.entries = parsed.entries
    store.currentTokens = parsed.currentTokens
    return store
  }
}
