// src/lib/agent/browser.ts
// Browser integration for agent — web research, scraping, and interaction

import { invoke } from '@tauri-apps/api/core'

// ── Types ────────────────────────────────────────────────────────────

export interface BrowserSearchResult {
  title: string
  url: string
  snippet: string
}

export interface BrowserExtractResult {
  url: string
  title: string
  content: string
  error?: string
}

// ── Web Search ───────────────────────────────────────────────────────

export async function searchWeb(
  query: string,
  limit: number = 5
): Promise<BrowserSearchResult[]> {
  try {
    const result = await invoke<{ ok: boolean; output: string; error: string }>(
      'web_search_command',
      { query, limit }
    )

    if (!result.ok) {
      console.error('[Browser] Search error:', result.error)
      return []
    }

    // Parse search results from output
    return parseSearchResults(result.output)
  } catch (e) {
    console.error('[Browser] Search failed:', e)
    return []
  }
}

// ── Web Extract ──────────────────────────────────────────────────────

export async function extractUrl(url: string): Promise<BrowserExtractResult> {
  try {
    const result = await invoke<{ ok: boolean; output: string; error: string }>(
      'web_extract_command',
      { url }
    )

    if (!result.ok) {
      return { url, title: '', content: '', error: result.error }
    }

    // Try to extract title from content
    const titleMatch = result.output.match(/^#\s+(.+)$/m)
    const title = titleMatch ? titleMatch[1] : url

    return {
      url,
      title,
      content: result.output,
    }
  } catch (e) {
    return {
      url,
      title: '',
      content: '',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseSearchResults(output: string): BrowserSearchResult[] {
  const results: BrowserSearchResult[] = []
  const lines = output.split('\n')

  for (const line of lines) {
    // Try to parse "Title - URL\nSnippet" format
    const match = line.match(/^(.+?)\s*[-–]\s*(https?:\/\/\S+)/)
    if (match) {
      results.push({
        title: match[1].trim(),
        url: match[2],
        snippet: '',
      })
    }
  }

  // If no structured results, return the raw output as a single result
  if (results.length === 0 && output.trim()) {
    results.push({
      title: 'Search Results',
      url: '',
      snippet: output.trim(),
    })
  }

  return results
}
