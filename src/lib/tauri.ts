import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

export type BootstrapPayload = {
  appName: string
  appVersion: string
  platform: string
}

export type CliKeys = {
  GEMINI_API_KEY: string | null
  GITHUB_TOKEN: string | null
  GEMINI_MODEL: string
  GITHUB_MODEL: string
}

export type DesktopDeviceContext = {
  deviceId: string
  deviceName: string
  os: string
  platform: string
  appVersion: string
  deviceType?: 'desktop_app'
}

export type AuthLaunchPayload = {
  loginUrl: string
  callbackUrl: string
  deviceId: string
  authState: string
}

export type AuthStatusPayload = {
  status: 'idle' | 'pending' | 'success' | 'error'
  error: string | null
  hasToken: boolean
}

export type FetchDesktopKeysResult =
  | {
      ok: true
      keys: CliKeys
      warning: string | null
      requestId?: string
    }
  | {
      ok: false
      status: number
      error: string
      errorCode?: string
      toolEvents?: DesktopModelToolEvent[]
      engine?: string
      requestId?: string
    }

export type TelemetryResult = {
  ok: boolean
  warning: string | null
}

export type DesktopHealthSnapshot = {
  status: 'ready' | 'degraded'
  authVerified: boolean
  geminiKeyReady: boolean
  geminiModel: string
  geminiCliReady: boolean
  cliCommandSource?: string
  cliCommand?: string
  runtimeNodeVersion: string
  runtimePlatform: string
  guidance: string[]
}

export type DesktopHealthResult =
  | {
      ok: true
      snapshot: DesktopHealthSnapshot
      requestId?: string
    }
  | {
      ok: false
      status: number
      error: string
      errorCode?: string
      requestId?: string
    }

type TelemetryCounters = {
  commandsExecuted: number
  filesEdited: number
  activeSwarms: number
  messagesSent: number
  assistantResponses: number
  searchQueries: number
  toolCalls: number
  sessionsStarted: number
  failedTurns: number
  lastModel?: string
  lastProvider?: string
  lastWorkspacePath?: string
}

const DESKTOP_AGENT_REQUEST_TIMEOUT_MS = 150_000

type ViteImportMeta = ImportMeta & {
  env?: Record<string, string | undefined>
}

const DEFAULT_FORGE_WEB_BASE_URL = 'https://forge-app-peach.vercel.app'

function hasTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return DEFAULT_FORGE_WEB_BASE_URL
  return trimmed.replace(/\/+$/, '')
}

export type DesktopSearchHit = {
  title: string
  url: string
  snippet: string
  source: string
}

export type DesktopSearchResult =
  | {
      ok: true
      results: DesktopSearchHit[]
    }
  | {
      ok: false
      status: number
      error: string
    }

export type DesktopAgentMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type DesktopAgentToolResult = {
  name: string
  output: string
}

export type DesktopExecutionMode = 'default' | 'auto_edit' | 'yolo' | 'plan'

export type DesktopModelToolEvent = {
  name: string
  status: 'running' | 'done' | 'error'
  detail: string
}

export type DesktopAgentChatResult =
  | {
      ok: true
      reply: string
      thinking: string[]
      toolEvents: DesktopModelToolEvent[]
      engine?: string
      warning?: string
      executionMode?: DesktopExecutionMode
      requestId?: string
    }
  | {
      ok: false
      status: number
      error: string
      errorCode?: string
      toolEvents?: DesktopModelToolEvent[]
      engine?: string
      executionMode?: DesktopExecutionMode
      requestId?: string
    }

type DesktopAgentChatPayload = {
  message: string
  history: DesktopAgentMessage[]
  toolResults: DesktopAgentToolResult[]
  thinkingHints?: string[]
  workspacePath?: string
  workspaceLabel?: string
  workspaceFiles?: string[]
  modelPreference?: string
  providerPreference?: string
  executionMode?: DesktopExecutionMode
  sessionId?: string
}

type DesktopHttpHeader = {
  name: string
  value: string
}

type DesktopHttpTransportResponse = {
  status: number
  ok: boolean
  body: string
}

type JsonTransportResult = {
  status: number
  ok: boolean
  payload: unknown
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function asExecutionMode(value: unknown): DesktopExecutionMode | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'default' ||
    normalized === 'auto_edit' ||
    normalized === 'yolo' ||
    normalized === 'plan'
  ) {
    return normalized
  }

  return undefined
}

function createCorrelationId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return `desktop-${globalThis.crypto.randomUUID()}`
  }

  return `desktop-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

function readJsonSafely(response: Response): Promise<unknown> {
  return response
    .json()
    .catch(() => null)
}

function normalizeHeaders(headers?: HeadersInit): DesktopHttpHeader[] {
  if (!headers) return []

  if (headers instanceof Headers) {
    return Array.from(headers.entries()).map(([name, value]) => ({ name, value }))
  }

  if (Array.isArray(headers)) {
    return headers.map(([name, value]) => ({
      name,
      value: String(value),
    }))
  }

  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: String(value),
  }))
}

function isRetryableTransportError(error: unknown): boolean {
  const message = String(error).toLowerCase()
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('error sending request for url') ||
    message.includes('connection reset') ||
    message.includes('connection refused') ||
    message.includes('dns')
  )
}

function waitMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs)
  })
}

async function performJsonRequest(
  url: string,
  init: RequestInit,
  timeoutMs = 20000,
): Promise<JsonTransportResult> {
  if (hasTauriRuntime()) {
    const result = await invoke<DesktopHttpTransportResponse>('desktop_http_request', {
      url,
      method: init.method || 'GET',
      headers: normalizeHeaders(init.headers),
      body: typeof init.body === 'string' ? init.body : null,
      timeoutMs,
    })

    let payload: unknown = null
    if (result.body.trim()) {
      try {
        payload = JSON.parse(result.body)
      } catch {
        payload = null
      }
    }

    return {
      status: result.status,
      ok: result.ok,
      payload,
    }
  }

  const response = await fetch(url, init)
  const payload = await readJsonSafely(response)

  return {
    status: response.status,
    ok: response.ok,
    payload,
  }
}

function readApiError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const maybePayload = payload as { error?: unknown; details?: unknown }
    const errorMessage = asString(maybePayload.error)
    const detailMessage = asString(maybePayload.details)

    if (errorMessage && detailMessage) {
      if (errorMessage.includes(detailMessage)) {
        return errorMessage
      }

      return `${errorMessage}: ${detailMessage}`
    }

    if (detailMessage) return detailMessage
    if (errorMessage) return errorMessage
  }

  return fallback
}

function normalizeDeviceContext(device: DesktopDeviceContext): DesktopDeviceContext {
  return {
    deviceId: device.deviceId.trim(),
    deviceName: device.deviceName.trim() || 'Forge Desktop',
    os: device.os.trim() || 'Unknown OS',
    platform: device.platform.trim() || device.os.trim() || 'Unknown OS',
    appVersion: device.appVersion.trim() || '0.1.0',
    deviceType: 'desktop_app',
  }
}

function defaultTelemetryCounters(counters?: Partial<TelemetryCounters>): TelemetryCounters {
  const normalizedModel = asString(counters?.lastModel)
  const normalizedProvider = asString(counters?.lastProvider)
  const normalizedWorkspacePath = asString(counters?.lastWorkspacePath)

  return {
    commandsExecuted: Number.isFinite(counters?.commandsExecuted)
      ? Math.max(0, Number(counters?.commandsExecuted))
      : 0,
    filesEdited: Number.isFinite(counters?.filesEdited)
      ? Math.max(0, Number(counters?.filesEdited))
      : 0,
    activeSwarms: Number.isFinite(counters?.activeSwarms)
      ? Math.max(0, Number(counters?.activeSwarms))
      : 0,
    messagesSent: Number.isFinite(counters?.messagesSent)
      ? Math.max(0, Number(counters?.messagesSent))
      : 0,
    assistantResponses: Number.isFinite(counters?.assistantResponses)
      ? Math.max(0, Number(counters?.assistantResponses))
      : 0,
    searchQueries: Number.isFinite(counters?.searchQueries)
      ? Math.max(0, Number(counters?.searchQueries))
      : 0,
    toolCalls: Number.isFinite(counters?.toolCalls)
      ? Math.max(0, Number(counters?.toolCalls))
      : 0,
    sessionsStarted: Number.isFinite(counters?.sessionsStarted)
      ? Math.max(0, Number(counters?.sessionsStarted))
      : 0,
    failedTurns: Number.isFinite(counters?.failedTurns)
      ? Math.max(0, Number(counters?.failedTurns))
      : 0,
    ...(normalizedModel ? { lastModel: normalizedModel } : {}),
    ...(normalizedProvider ? { lastProvider: normalizedProvider } : {}),
    ...(normalizedWorkspacePath ? { lastWorkspacePath: normalizedWorkspacePath } : {}),
  }
}

export function getForgeWebBaseUrl(): string {
  const importMetaWithEnv = import.meta as ViteImportMeta
  const configured =
    importMetaWithEnv.env?.VITE_FORGE_WEB_BASE_URL ||
    importMetaWithEnv.env?.NEXT_PUBLIC_BASE_URL

  return normalizeBaseUrl(configured || DEFAULT_FORGE_WEB_BASE_URL)
}

export async function getBootstrapPayload(): Promise<BootstrapPayload> {
  if (hasTauriRuntime()) {
    try {
      return await invoke<BootstrapPayload>('bootstrap')
    } catch {
      return {
        appName: 'Forge Desktop',
        appVersion: '0.1.0',
        platform: 'unknown',
      }
    }
  }

  return {
    appName: 'Forge Desktop',
    appVersion: 'dev',
    platform: 'browser',
  }
}

export async function beginAuthFlow(
  baseUrl: string,
  deviceName = 'Forge Desktop',
): Promise<AuthLaunchPayload> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)

  if (hasTauriRuntime()) {
    return invoke<AuthLaunchPayload>('begin_auth_flow', {
      baseUrl: normalizedBaseUrl,
      deviceName,
    })
  }

  return {
    loginUrl: `${normalizedBaseUrl}/desktop`,
    callbackUrl: '',
    deviceId: 'browser-preview',
    authState: '',
  }
}

export async function getAuthStatus(): Promise<AuthStatusPayload> {
  if (!hasTauriRuntime()) {
    return { status: 'idle', error: null, hasToken: false }
  }

  return invoke<AuthStatusPayload>('auth_status')
}

export async function consumeAuthToken(): Promise<string | null> {
  if (!hasTauriRuntime()) {
    return null
  }

  const token = await invoke<string | null>('consume_auth_token')
  return token || null
}

export async function saveSessionToken(token: string): Promise<void> {
  if (hasTauriRuntime()) {
    await invoke('save_session_token', { token })
    return
  }

  localStorage.setItem('forge-desktop-session-token', token)
}

export async function loadSessionToken(): Promise<string | null> {
  if (hasTauriRuntime()) {
    const token = await invoke<string | null>('load_session_token')
    return token || null
  }

  return localStorage.getItem('forge-desktop-session-token')
}

export async function clearSessionToken(): Promise<void> {
  if (hasTauriRuntime()) {
    await invoke('clear_session_token')
    return
  }

  localStorage.removeItem('forge-desktop-session-token')
}

export async function fetchDesktopKeys(
  token: string,
  baseUrl: string,
  device: DesktopDeviceContext,
): Promise<FetchDesktopKeysResult> {
  const trimmedToken = token.trim()
  if (!trimmedToken) {
    return { ok: false, status: 401, error: 'Missing session token.' }
  }

  const context = normalizeDeviceContext(device)
  const correlationId = createCorrelationId()
  const params = new URLSearchParams({
    deviceId: context.deviceId,
    deviceName: context.deviceName,
    os: context.os,
    deviceType: 'desktop_app',
    appVersion: context.appVersion,
    platform: context.platform,
  })

  let result: JsonTransportResult
  try {
    result = await performJsonRequest(
      `${normalizeBaseUrl(baseUrl)}/api/desktop/keys?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmedToken}`,
          'X-Correlation-Id': correlationId,
          'X-Device-Id': context.deviceId,
        },
      },
    )
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: `Network error while syncing keys: ${String(error)}`,
      requestId: correlationId,
    }
  }

  const payload = result.payload
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: readApiError(payload, `Key sync failed with status ${result.status}.`),
      requestId:
        asString((payload as { requestId?: unknown } | null)?.requestId) || correlationId,
    }
  }

  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      status: 500,
      error: 'Invalid key payload returned by Forge API.',
      requestId: correlationId,
    }
  }

  const body = payload as { keys?: unknown; warning?: unknown }
  if (!body.keys || typeof body.keys !== 'object') {
    return {
      ok: false,
      status: 500,
      error: 'Key payload is missing required fields.',
      requestId: correlationId,
    }
  }

  const rawKeys = body.keys as Partial<CliKeys>
  const keys: CliKeys = {
    GEMINI_API_KEY: asNullableString(rawKeys.GEMINI_API_KEY),
    GITHUB_TOKEN: asNullableString(rawKeys.GITHUB_TOKEN),
    GEMINI_MODEL: asString(rawKeys.GEMINI_MODEL) || 'gemma-4-31b-it',
    GITHUB_MODEL: asString(rawKeys.GITHUB_MODEL) || 'gemini-3.1-pro-preview',
  }

  return {
    ok: true,
    keys,
    warning: asString(body.warning),
    requestId: asString((payload as { requestId?: unknown }).requestId) || correlationId,
  }
}

export async function postDesktopTelemetry(
  token: string,
  baseUrl: string,
  device: DesktopDeviceContext,
  counters?: Partial<TelemetryCounters>,
): Promise<TelemetryResult> {
  const trimmedToken = token.trim()
  if (!trimmedToken) {
    return { ok: false, warning: 'Missing session token for telemetry.' }
  }

  const context = normalizeDeviceContext(device)
  const safeCounters = defaultTelemetryCounters(counters)

  let result: JsonTransportResult
  try {
    result = await performJsonRequest(
      `${normalizeBaseUrl(baseUrl)}/api/desktop/telemetry`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${trimmedToken}`,
        },
        body: JSON.stringify({
          deviceId: context.deviceId,
          deviceName: context.deviceName,
          os: context.os,
          deviceType: 'desktop_app',
          appVersion: context.appVersion,
          platform: context.platform,
          commandsExecuted: safeCounters.commandsExecuted,
          filesEdited: safeCounters.filesEdited,
          activeSwarms: safeCounters.activeSwarms,
          messagesSent: safeCounters.messagesSent,
          assistantResponses: safeCounters.assistantResponses,
          searchQueries: safeCounters.searchQueries,
          toolCalls: safeCounters.toolCalls,
          sessionsStarted: safeCounters.sessionsStarted,
          failedTurns: safeCounters.failedTurns,
          lastModel: safeCounters.lastModel,
          lastProvider: safeCounters.lastProvider,
          lastWorkspacePath: safeCounters.lastWorkspacePath,
        }),
      },
    )
  } catch (error) {
    return {
      ok: false,
      warning: `Network error while posting telemetry: ${String(error)}`,
    }
  }

  const payload = result.payload
  if (!result.ok) {
    return {
      ok: false,
      warning: readApiError(payload, `Telemetry failed with status ${result.status}.`),
    }
  }

  if (payload && typeof payload === 'object') {
    const warnings = (payload as { warnings?: unknown }).warnings
    if (Array.isArray(warnings)) {
      const filteredWarnings = warnings.filter((value): value is string => typeof value === 'string')
      if (filteredWarnings.length > 0) {
        return { ok: true, warning: filteredWarnings.join(' ') }
      }
    }
  }

  return { ok: true, warning: null }
}

export async function searchDesktopWeb(
  token: string,
  baseUrl: string,
  query: string,
): Promise<DesktopSearchResult> {
  const trimmedToken = token.trim()
  if (!trimmedToken) {
    return { ok: false, status: 401, error: 'Missing session token.' }
  }

  const trimmedQuery = query.trim()
  if (trimmedQuery.length < 2) {
    return { ok: false, status: 400, error: 'Search query must be at least 2 characters.' }
  }

  let result: JsonTransportResult
  try {
    result = await performJsonRequest(`${normalizeBaseUrl(baseUrl)}/api/desktop/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${trimmedToken}`,
      },
      body: JSON.stringify({ query: trimmedQuery, limit: 6 }),
    })
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: `Network error while searching: ${String(error)}`,
    }
  }

  const payload = result.payload
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: readApiError(payload, `Search failed with status ${result.status}.`),
    }
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, status: 500, error: 'Invalid search response.' }
  }

  const maybeResults = (payload as { results?: unknown }).results
  if (!Array.isArray(maybeResults)) {
    return { ok: false, status: 500, error: 'Search response did not include results.' }
  }

  const results: DesktopSearchHit[] = maybeResults
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const raw = entry as Record<string, unknown>
      const title = asString(raw.title) || 'Untitled source'
      const url = asString(raw.url) || ''
      const snippet = asString(raw.snippet) || 'No snippet available.'
      const source = asString(raw.source) || 'web'

      if (!url) {
        return null
      }

      return { title, url, snippet, source }
    })
    .filter((entry): entry is DesktopSearchHit => Boolean(entry))

  return { ok: true, results }
}

export async function fetchDesktopHealth(
  token: string,
  baseUrl: string,
): Promise<DesktopHealthResult> {
  const trimmedToken = token.trim()
  if (!trimmedToken) {
    return { ok: false, status: 401, error: 'Missing session token.' }
  }

  const correlationId = createCorrelationId()
  let result: JsonTransportResult

  try {
    result = await performJsonRequest(`${normalizeBaseUrl(baseUrl)}/api/desktop/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${trimmedToken}`,
        'X-Correlation-Id': correlationId,
      },
    })
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: `Network error while checking desktop health: ${String(error)}`,
      requestId: correlationId,
    }
  }

  const payload = result.payload
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: readApiError(payload, `Desktop health check failed with status ${result.status}.`),
      errorCode: asString((payload as { errorCode?: unknown } | null)?.errorCode) || undefined,
      requestId:
        asString((payload as { requestId?: unknown } | null)?.requestId) || correlationId,
    }
  }

  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      status: 500,
      error: 'Desktop health endpoint returned an invalid payload.',
      requestId: correlationId,
    }
  }

  const body = payload as {
    status?: unknown
    auth?: unknown
    gemini?: unknown
    runtime?: unknown
    guidance?: unknown
    requestId?: unknown
  }

  const auth = body.auth && typeof body.auth === 'object' ? (body.auth as Record<string, unknown>) : {}
  const gemini = body.gemini && typeof body.gemini === 'object' ? (body.gemini as Record<string, unknown>) : {}
  const runtime = body.runtime && typeof body.runtime === 'object' ? (body.runtime as Record<string, unknown>) : {}
  const guidance = Array.isArray(body.guidance)
    ? body.guidance.filter((entry): entry is string => typeof entry === 'string')
    : []

  const snapshot: DesktopHealthSnapshot = {
    status: body.status === 'ready' ? 'ready' : 'degraded',
    authVerified: auth.verified === true,
    geminiKeyReady: gemini.keyReady === true,
    geminiModel: asString(gemini.model) || 'unknown',
    geminiCliReady: gemini.cliReady === true,
    cliCommandSource: asString(gemini.commandSource) || undefined,
    cliCommand: asString(gemini.command) || undefined,
    runtimeNodeVersion: asString(runtime.nodeVersion) || 'unknown',
    runtimePlatform: asString(runtime.platform) || 'unknown',
    guidance,
  }

  return {
    ok: true,
    snapshot,
    requestId: asString(body.requestId) || correlationId,
  }
}

export async function runDesktopAgentChat(
  token: string | null,
  baseUrl: string,
  payload: DesktopAgentChatPayload,
): Promise<DesktopAgentChatResult> {
  const correlationId = createCorrelationId()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Correlation-Id': correlationId,
  }

  if (token && token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`
  }

  let result: JsonTransportResult | null = null
  let lastTransportError: unknown = null

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      result = await performJsonRequest(
        `${normalizeBaseUrl(baseUrl)}/api/desktop/agent`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        },
        DESKTOP_AGENT_REQUEST_TIMEOUT_MS,
      )
      lastTransportError = null
      break
    } catch (error) {
      lastTransportError = error

      if (attempt < 2 && isRetryableTransportError(error)) {
        await waitMs(350)
        continue
      }

      break
    }
  }

  if (!result) {
    return {
      ok: false,
      status: 0,
      error: `Network error while contacting agent API: ${String(lastTransportError)}`,
      requestId: correlationId,
    }
  }

  const body = result.payload
  const parseModelToolEvents = (value: unknown): DesktopModelToolEvent[] => {
    if (!Array.isArray(value)) {
      return []
    }

    return value
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null
        }

        const record = entry as Record<string, unknown>
        const name = asString(record.name)
        const detail = asString(record.detail)
        const statusCandidate = asString(record.status)
        const status: DesktopModelToolEvent['status'] =
          statusCandidate === 'running' ||
          statusCandidate === 'done' ||
          statusCandidate === 'error'
            ? statusCandidate
            : 'done'

        if (!name || !detail) {
          return null
        }

        return {
          name,
          status,
          detail,
        } satisfies DesktopModelToolEvent
      })
      .filter((entry): entry is DesktopModelToolEvent => Boolean(entry))
  }

  if (!result.ok) {
    const toolEvents = parseModelToolEvents((body as { toolEvents?: unknown } | null)?.toolEvents)
    const engine = asString((body as { engine?: unknown } | null)?.engine) || undefined
    const executionMode = asExecutionMode((body as { executionMode?: unknown } | null)?.executionMode)

    return {
      ok: false,
      status: result.status,
      error: readApiError(body, `Agent chat failed with status ${result.status}.`),
      errorCode: asString((body as { errorCode?: unknown } | null)?.errorCode) || undefined,
      ...(toolEvents.length > 0 ? { toolEvents } : {}),
      ...(engine ? { engine } : {}),
      ...(executionMode ? { executionMode } : {}),
      requestId:
        asString((body as { requestId?: unknown } | null)?.requestId) || correlationId,
    }
  }

  if (!body || typeof body !== 'object') {
    return {
      ok: false,
      status: 500,
      error: 'Agent chat returned an invalid response payload.',
      requestId: correlationId,
    }
  }

  const rawReply = asString((body as { reply?: unknown }).reply)
  const thinkingArray = (body as { thinking?: unknown }).thinking
  const thinking = Array.isArray(thinkingArray)
    ? thinkingArray.filter((entry): entry is string => typeof entry === 'string')
    : []

  const toolEvents = parseModelToolEvents((body as { toolEvents?: unknown }).toolEvents)

  const engine = asString((body as { engine?: unknown }).engine) || undefined
  const warning = asString((body as { warning?: unknown }).warning) || undefined
  const executionMode = asExecutionMode((body as { executionMode?: unknown }).executionMode)

  return {
    ok: true,
    reply:
      rawReply ||
      'I was not able to generate a response from the model for this turn. Please try again.',
    thinking,
    toolEvents,
    ...(engine ? { engine } : {}),
    ...(warning ? { warning } : {}),
    ...(executionMode ? { executionMode } : {}),
    requestId: asString((body as { requestId?: unknown }).requestId) || correlationId,
  }
}

export async function listWorkspaceFiles(
  basePath?: string,
  depth = 3,
): Promise<string[]> {
  if (!hasTauriRuntime()) {
    return []
  }

  const result = await invoke<string[]>('list_workspace_files', {
    basePath,
    depth,
  })

  return Array.isArray(result) ? result : []
}

export async function readWorkspaceFile(
  path: string,
  maxBytes = 50000,
): Promise<string> {
  if (!hasTauriRuntime()) {
    return 'Workspace file reading is available in desktop runtime only.'
  }

  const content = await invoke<string>('read_workspace_file', {
    path,
    maxBytes,
  })

  return content
}

export async function pickWorkspaceFolder(): Promise<string | null> {
  const promptForManualPath = (): string | null => {
    const entered = window.prompt('Enter the full workspace folder path:')
    const trimmed = entered?.trim()
    return trimmed || null
  }

  if (!hasTauriRuntime()) {
    return promptForManualPath()
  }

  try {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: 'Select Workspace Folder',
    })

    if (typeof selected === 'string') {
      const trimmed = selected.trim()
      return trimmed || null
    }

    return null
  } catch (error) {
    console.error('Native folder picker failed, falling back to manual input.', error)
    return promptForManualPath()
  }
}
