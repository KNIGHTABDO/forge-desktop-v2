// src/lib/vector.ts
// Local vector search engine for workspace RAG

import { invoke } from '@tauri-apps/api/core'

// ── Types ────────────────────────────────────────────────────────────

export interface VectorDocument {
  id: string
  path: string
  content: string
  chunkIndex: number
  embedding?: number[]
  metadata: Record<string, unknown>
  indexedAt: number
}

export interface VectorSearchResult {
  document: VectorDocument
  score: number
  matchedText: string
}

export interface IndexStats {
  totalDocuments: number
  totalChunks: number
  totalFiles: number
  lastIndexed: number | null
}

// ── Simple Embedding (TF-IDF-like without external deps) ─────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'and', 'but',
  'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because',
  'if', 'when', 'where', 'how', 'what', 'which', 'who', 'whom', 'this',
  'that', 'these', 'those', 'it', 'its', 'he', 'she', 'they', 'them',
  'we', 'us', 'you', 'your', 'my', 'his', 'her', 'our', 'their',
])

// Simple hash function for consistent token hashing
function hashToken(token: string): number {
  let hash = 0
  for (let i = 0; i < token.length; i++) {
    const char = token.charCodeAt(i)
    hash = ((hash << 5) - hash + char) & 0x7fffffff
  }
  return hash
}

// Create a sparse vector representation using token hashing
function createEmbedding(text: string, dimensions: number = 256): number[] {
  const vector = new Array(dimensions).fill(0)
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))

  for (const token of tokens) {
    const idx = hashToken(token) % dimensions
    vector[idx] += 1
  }

  // Normalize
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= magnitude
    }
  }

  return vector
}

// Cosine similarity
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ── Chunking ─────────────────────────────────────────────────────────

function chunkText(text: string, maxChunkSize: number = 1000, overlap: number = 100): string[] {
  if (text.length <= maxChunkSize) return [text]

  const chunks: string[] = []
  const lines = text.split('\n')
  let currentChunk = ''
  let currentSize = 0

  for (const line of lines) {
    if (currentSize + line.length + 1 > maxChunkSize && currentChunk) {
      chunks.push(currentChunk.trim())
      // Keep overlap from end of previous chunk
      const overlapStart = Math.max(0, currentChunk.length - overlap)
      currentChunk = currentChunk.slice(overlapStart) + '\n' + line
      currentSize = currentChunk.length
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line
      currentSize += line.length + 1
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim())
  }

  return chunks
}

// ── Vector Store ─────────────────────────────────────────────────────

const VECTOR_STORAGE_KEY = 'forge-desktop-vector-index-v1'

class VectorStoreClass {
  private documents: Map<string, VectorDocument> = new Map()
  private loaded = false
  private indexing = false

  // Load from localStorage
  private loadFromStorage(): void {
    if (this.loaded) return
    try {
      const raw = localStorage.getItem(VECTOR_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as VectorDocument[]
        for (const doc of parsed) {
          this.documents.set(doc.id, doc)
        }
      }
    } catch {
      console.warn('[Vector] Failed to load index from storage')
    }
    this.loaded = true
  }

  private saveToStorage(): void {
    try {
      const docs = Array.from(this.documents.values())
      // Keep only last 10K documents
      const trimmed = docs.slice(-10000)
      localStorage.setItem(VECTOR_STORAGE_KEY, JSON.stringify(trimmed))
    } catch {
      console.warn('[Vector] Failed to save index')
    }
  }

  // Index a single file
  async indexFile(path: string, content: string): Promise<number> {
    this.loadFromStorage()

    // Remove existing chunks for this file
    for (const [id, doc] of this.documents) {
      if (doc.path === path) {
        this.documents.delete(id)
      }
    }

    const chunks = chunkText(content)
    let indexed = 0

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const embedding = createEmbedding(chunk)
      const id = `${path}:${i}`

      this.documents.set(id, {
        id,
        path,
        content: chunk,
        chunkIndex: i,
        embedding,
        metadata: {
          lines: chunk.split('\n').length,
          chars: chunk.length,
        },
        indexedAt: Date.now(),
      })
      indexed++
    }

    this.saveToStorage()
    return indexed
  }

  // Index an entire workspace
  async indexWorkspace(
    workspacePath: string,
    fileReader: (path: string) => Promise<string | null>
  ): Promise<IndexStats> {
    if (this.indexing) {
      throw new Error('Indexing already in progress')
    }

    this.indexing = true
    this.loadFromStorage()

    try {
      // Get file list via Tauri
      const fileList = await invoke<{ ok: boolean; output: string }>(
        'list_files_command',
        { path: workspacePath, pattern: '*', maxDepth: 5, limit: 500 }
      )

      if (!fileList.ok) {
        throw new Error('Failed to list workspace files')
      }

      const files = fileList.output.split('\n').filter(Boolean)
      const indexableExtensions = new Set([
        '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp',
        '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.md', '.txt', '.json',
        '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss', '.sql', '.sh',
      ])

      let totalChunks = 0
      let totalFiles = 0
      const indexedPaths = new Set<string>()

      for (const relPath of files) {
        if (relPath.endsWith('/')) continue // skip directories

        const ext = '.' + relPath.split('.').pop()?.toLowerCase()
        if (!indexableExtensions.has(ext)) continue

        // Skip common non-source paths
        if (relPath.includes('node_modules/') || relPath.includes('.git/') ||
            relPath.includes('dist/') || relPath.includes('target/')) continue

        try {
          const fullPath = `${workspacePath}/${relPath}`
          const content = await fileReader(fullPath)
          if (content) {
            const chunks = await this.indexFile(fullPath, content)
            totalChunks += chunks
            totalFiles++
            indexedPaths.add(fullPath)
          }
        } catch {
          // Skip files that can't be read
        }
      }

      this.saveToStorage()

      return {
        totalDocuments: this.documents.size,
        totalChunks,
        totalFiles,
        lastIndexed: Date.now(),
      }
    } finally {
      this.indexing = false
    }
  }

  // Search the index
  async search(query: string, limit: number = 5): Promise<VectorSearchResult[]> {
    this.loadFromStorage()

    const queryEmbedding = createEmbedding(query)
    const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => !STOP_WORDS.has(t))

    const scored: Array<{ doc: VectorDocument; score: number }> = []

    for (const doc of this.documents.values()) {
      // Semantic score (cosine similarity of sparse embeddings)
      const semanticScore = doc.embedding
        ? cosineSimilarity(queryEmbedding, doc.embedding)
        : 0

      // Keyword score (BM25-like)
      const contentLower = doc.content.toLowerCase()
      let keywordScore = 0
      for (const term of queryTerms) {
        const termCount = (contentLower.match(new RegExp(term, 'g')) || []).length
        if (termCount > 0) {
          keywordScore += Math.log(1 + termCount)
        }
      }

      // Combined score
      const score = semanticScore * 0.6 + keywordScore * 0.4
      if (score > 0.01) {
        scored.push({ doc, score })
      }
    }

    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, limit).map(({ doc, score }) => {
      // Extract matched text context
      const firstMatch = queryTerms.find((term) =>
        doc.content.toLowerCase().includes(term)
      )
      let matchedText = doc.content.slice(0, 200)
      if (firstMatch) {
        const idx = doc.content.toLowerCase().indexOf(firstMatch)
        const start = Math.max(0, idx - 50)
        const end = Math.min(doc.content.length, idx + 150)
        matchedText = (start > 0 ? '...' : '') +
          doc.content.slice(start, end) +
          (end < doc.content.length ? '...' : '')
      }

      return {
        document: doc,
        score: Math.round(score * 100) / 100,
        matchedText,
      }
    })
  }

  // Get index stats
  getStats(): IndexStats {
    this.loadFromStorage()
    const docs = Array.from(this.documents.values())
    const uniquePaths = new Set(docs.map((d) => d.path))
    const lastIndexed = docs.length > 0
      ? Math.max(...docs.map((d) => d.indexedAt))
      : null

    return {
      totalDocuments: docs.length,
      totalChunks: docs.length,
      totalFiles: uniquePaths.size,
      lastIndexed,
    }
  }

  // Clear the index
  clear(): void {
    this.documents.clear()
    localStorage.removeItem(VECTOR_STORAGE_KEY)
  }

  // Remove a file from the index
  removeFile(path: string): void {
    this.loadFromStorage()
    for (const [id, doc] of this.documents) {
      if (doc.path === path) {
        this.documents.delete(id)
      }
    }
    this.saveToStorage()
  }

  isIndexing(): boolean {
    return this.indexing
  }
}

export const VectorSearch = new VectorStoreClass()
