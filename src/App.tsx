import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openUrl } from '@tauri-apps/plugin-opener'
import { FileCard, FileMetadata } from './components/FileCard';
import { LocalAgentSettings } from './components/LocalAgentSettings';
import { SkillPanel } from './components/SkillPanel';
import { VectorPanel } from './components/VectorPanel';
import { SubagentPanel } from './components/SubagentPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { useLocalAgent, loadProviderConfig, type LocalProviderConfig } from './lib/agent/useLocalAgent';

  clearSessionToken,
  consumeAuthToken,
  fetchDesktopHealth,
  fetchDesktopKeys,
  getAuthStatus,
  getBootstrapPayload,
  getForgeWebBaseUrl,
  listWorkspaceFiles,
  loadSessionToken,
  pickWorkspaceFolder,
  postDesktopTelemetry,
  readWorkspaceFile,
  runDesktopAgentChat,
  saveSessionToken,
  searchDesktopWeb,
  type BootstrapPayload,
  type CliKeys,
  type DesktopAgentMessage,
  type DesktopExecutionMode,
  type DesktopAgentToolResult,
  type DesktopDeviceContext,
  type DesktopHealthSnapshot,
} from './lib/tauri'

type ThemeMode = 'light' | 'dark'
type StartupStep = 'onboarding' | 'chat'
type ChatRole = 'user' | 'assistant'
type ChatDirection = 'ltr' | 'rtl'
type AgentTurnMode = 'normal' | 'regenerate'

type ToolEvent = {
  name: string
  status: 'running' | 'done' | 'error'
  detail: string
}

type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  executionMode?: DesktopExecutionMode
  thinking?: string[]
  tools?: ToolEvent[]
}

type SessionRevision = {
  id: string
  label: string
  messages: ChatMessage[]
  indexedFiles: string[]
  createdAt: number
}

type SessionTimeline = {
  past: SessionRevision[]
  future: SessionRevision[]
}

type ChatSession = {
  id: string
  title: string
  workspacePath: string
  messages: ChatMessage[]
  draft: string
  indexedFiles: string[]
  searchEnabled: boolean
  createdAt: number
  updatedAt: number
}

type RemoteKeySummary = {
  geminiReady: boolean
  githubReady: boolean
  geminiModel: string
  githubModel: string
}

const DEVICE_ID_STORAGE_KEY = 'forge-desktop-device-id'
const THEME_STORAGE_KEY = 'forge-desktop-theme'
const DIRECTION_MODE_STORAGE_KEY = 'forge-desktop-direction-mode'
const EXECUTION_MODE_STORAGE_KEY = 'forge-desktop-execution-mode'
const SESSION_STORAGE_KEY = 'forge-desktop-chat-sessions-v3'
const ACTIVE_SESSION_STORAGE_KEY = 'forge-desktop-active-session-v3'
const DEFAULT_SESSION_TITLE = 'New Session'
const MAX_SESSIONS = 80
const MAX_MESSAGES_PER_SESSION = 180
const MAX_INDEXED_FILES_PER_SESSION = 2000
const MAX_DRAFT_CHARS = 8000
const MAX_SESSION_REVISIONS = 90
const ARABIC_TEXT_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/
const DESKTOP_DEFAULT_MODEL = 'gemma-4-31b-it'
const DESKTOP_MODEL_PRESETS = [DESKTOP_DEFAULT_MODEL, 'gemini-3.1-flash-lite-preview']
const EXECUTION_MODE_OPTIONS: Array<{ value: DesktopExecutionMode; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan' },
  { value: 'auto_edit', label: 'Auto Edit' },
  { value: 'yolo', label: 'YOLO' },
]

function makeId(prefix: string): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }

  const randomSuffix = Math.floor(Math.random() * 1_000_000)
  return `${prefix}-${Date.now()}-${randomSuffix}`
}

function nextTheme(current: ThemeMode): ThemeMode {
  return current === 'light' ? 'dark' : 'light'
}

function summarizeRemoteKeys(keys: CliKeys): RemoteKeySummary {
  return {
    geminiReady: Boolean(keys.GEMINI_API_KEY),
    githubReady: Boolean(keys.GITHUB_TOKEN),
    geminiModel: keys.GEMINI_MODEL,
    githubModel: keys.GITHUB_MODEL,
  }
}

function readStoredDesktopDeviceId(): string | null {
  const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY)
  if (!existing) return null
  const trimmed = existing.trim()
  return trimmed || null
}

function createDesktopDeviceId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return `desktop-${globalThis.crypto.randomUUID()}`
  }

  const randomSuffix = Math.floor(Math.random() * 1_000_000)
  return `desktop-${Date.now()}-${randomSuffix}`
}

function persistDesktopDeviceId(deviceId: string): void {
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId)
}

function getOrCreateDesktopDeviceId(): string {
  const existing = readStoredDesktopDeviceId()
  if (existing) {
    return existing
  }

  const created = createDesktopDeviceId()
  persistDesktopDeviceId(created)
  return created
}

function toSessionTitleFromPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  if (!compact) return DEFAULT_SESSION_TITLE
  if (compact.length <= 46) return compact
  return `${compact.slice(0, 46)}...`
}

function createSession(workspacePath: string, title = DEFAULT_SESSION_TITLE): ChatSession {
  const now = Date.now()
  return {
    id: makeId('session'),
    title,
    workspacePath,
    messages: [],
    draft: '',
    indexedFiles: [],
    searchEnabled: true,
    createdAt: now,
    updatedAt: now,
  }
}

function clampSessionForStorage(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: session.messages.slice(-MAX_MESSAGES_PER_SESSION),
    indexedFiles: session.indexedFiles.slice(0, MAX_INDEXED_FILES_PER_SESSION),
    draft: session.draft.slice(0, MAX_DRAFT_CHARS),
  }
}

function sanitizeSessionCollectionForStorage(sessions: ChatSession[]): ChatSession[] {
  return [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS)
    .map(clampSessionForStorage)
}

function isAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path)
}

function joinPath(basePath: string, childPath: string): string {
  const base = basePath.trim()
  const child = childPath.trim()

  if (!base) return child
  if (!child) return base
  if (isAbsolutePath(child)) return child

  const separator = base.includes('\\') ? '\\' : '/'
  if (base.endsWith('\\') || base.endsWith('/')) {
    return `${base}${child}`
  }

  return `${base}${separator}${child}`
}

function resolveWorkspaceFilePath(workspacePath: string, requestedPath: string): string {
  const target = requestedPath.trim().replace(/^['"]|['"]$/g, '')
  if (!target) return ''
  if (isAbsolutePath(target)) return target
  if (!workspacePath.trim()) return ''
  return joinPath(workspacePath, target)
}

function getWorkspaceLabel(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return 'No folder selected'
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

function extractReadTarget(prompt: string): string | null {
  const slashRead = prompt.match(/^\s*\/read\s+(.+)$/i)
  if (slashRead?.[1]) {
    return slashRead[1].trim().replace(/^['"]|['"]$/g, '')
  }

  const naturalRead = prompt.match(/(?:read|open|cat)\s+(?:the\s+)?(?:file\s+)?([^\n]+)/i)
  if (naturalRead?.[1]) {
    const candidate = naturalRead[1].trim().replace(/^['"]|['"]$/g, '')
    if (!candidate) {
      return null
    }

    if (/\breadme\b/i.test(candidate)) {
      return 'README.md'
    }

    const lowered = candidate.toLowerCase()
    const readsLikeReference = /^(it|this|that|the\s+project|the\s+repo|project|repo)\b/.test(
      lowered,
    )
    const readsLikeFollowup = /\b(and|then)\s+(tell|summarize|explain|describe)\b/.test(
      lowered,
    )

    if (readsLikeReference || readsLikeFollowup) {
      return null
    }

    return candidate
  }

  return null
}

function trimToolOutput(value: string, maxChars = 5000): string {
  const normalized = value.trim()
  if (normalized.length <= maxChars) {
    return normalized
  }

  return `${normalized.slice(0, maxChars)}\n\n[...truncated...]`
}

function normalizeExecutionMode(value: unknown): DesktopExecutionMode | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'default' ||
    normalized === 'plan' ||
    normalized === 'auto_edit' ||
    normalized === 'yolo'
  ) {
    return normalized
  }

  return undefined
}

function looksLikePlanResponse(content: string): boolean {
  const normalized = content.toLowerCase()
  return (
    normalized.includes('### plan') ||
    normalized.includes('implementation steps') ||
    normalized.includes('objective:') ||
    normalized.includes('request your approval to proceed') ||
    normalized.includes('currently in plan mode')
  )
}

function cloneToolEvents(tools: ToolEvent[] | undefined): ToolEvent[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  return tools.map((tool) => ({ ...tool }))
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    thinking: message.thinking ? [...message.thinking] : undefined,
    tools: cloneToolEvents(message.tools),
  }))
}

function detectTextDirection(value: string): ChatDirection {
  return ARABIC_TEXT_REGEX.test(value) ? 'rtl' : 'ltr'
}

function getLastUserPrompt(messages: ChatMessage[]): string {
  const latestUser = [...messages].reverse().find((message) => message.role === 'user')
  return latestUser?.content?.trim() || ''
}

function isSafeExternalUrl(href: string): boolean {
  const normalized = href.trim().toLowerCase()
  return (
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('mailto:') ||
    normalized.startsWith('tel:')
  )
}

function loadStoredSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return []

    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    const normalized = parsed
      .map((candidate) => {
        if (!candidate || typeof candidate !== 'object') {
          return null
        }

        const item = candidate as Partial<ChatSession>
        if (typeof item.id !== 'string') {
          return null
        }

        const rawMessages = Array.isArray(item.messages) ? item.messages : []
        let messages: ChatMessage[] = rawMessages
          .reduce<ChatMessage[]>((acc, message) => {
            if (!message || typeof message !== 'object') {
              return acc
            }

            const record = message as Record<string, unknown>
            const role = record.role === 'user' ? 'user' : 'assistant'
            const content = typeof record.content === 'string' ? record.content : ''
            if (!content.trim()) {
              return acc
            }

            const thinking = Array.isArray(record.thinking)
              ? record.thinking
                  .filter((entry): entry is string => typeof entry === 'string')
                  .slice(0, 12)
              : []

            const tools = Array.isArray(record.tools)
              ? record.tools
                  .map((entry) => {
                    if (!entry || typeof entry !== 'object') return null
                    const toolRecord = entry as Record<string, unknown>
                    const name = typeof toolRecord.name === 'string' ? toolRecord.name : ''
                    const status =
                      toolRecord.status === 'running' ||
                      toolRecord.status === 'done' ||
                      toolRecord.status === 'error'
                        ? toolRecord.status
                        : 'running'
                    const detail =
                      typeof toolRecord.detail === 'string' ? toolRecord.detail : ''
                    if (!name || !detail) return null
                    return { name, status, detail } satisfies ToolEvent
                  })
                  .filter((entry): entry is ToolEvent => Boolean(entry))
                  .slice(0, 20)
              : []

            const normalizedMessage: ChatMessage = {
              id:
                typeof record.id === 'string' && record.id.trim()
                  ? record.id
                  : makeId('msg'),
              role,
              content,
              createdAt:
                typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
              executionMode: normalizeExecutionMode(record.executionMode),
            }

            if (thinking.length > 0) {
              normalizedMessage.thinking = thinking
            }

            if (tools.length > 0) {
              normalizedMessage.tools = tools
            }

            acc.push(normalizedMessage)
            return acc
          }, [])
          .slice(-MAX_MESSAGES_PER_SESSION)

        if (
          messages.length === 1 &&
          messages[0]?.role === 'assistant' &&
          messages[0].content.includes('Forge Desktop session ready')
        ) {
          messages = []
        }

        return {
          id: item.id,
          title:
            typeof item.title === 'string' && item.title.trim()
              ? item.title
              : DEFAULT_SESSION_TITLE,
          workspacePath:
            typeof item.workspacePath === 'string' ? item.workspacePath : '',
          messages,
          draft: typeof item.draft === 'string' ? item.draft : '',
          indexedFiles: Array.isArray(item.indexedFiles)
            ? item.indexedFiles
                .filter((entry): entry is string => typeof entry === 'string')
                .slice(0, MAX_INDEXED_FILES_PER_SESSION)
            : [],
          searchEnabled: item.searchEnabled !== false,
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
        } satisfies ChatSession
      })
      .filter((session): session is ChatSession => Boolean(session))

    return normalized
  } catch {
    return []
  }
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>('light')
  const [startupStep, setStartupStep] = useState<StartupStep>('onboarding')

  const [statusText, setStatusText] = useState('Desktop bridge ready.')
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [isPollingAuth, setIsPollingAuth] = useState(false)
  const [isSyncingSession, setIsSyncingSession] = useState(false)
  const [hasSavedSession, setHasSavedSession] = useState(false)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [remoteKeySummary, setRemoteKeySummary] = useState<RemoteKeySummary | null>(null)
  const [remoteKeys, setRemoteKeys] = useState<CliKeys | null>(null)
  const [lastKeySyncRequestId, setLastKeySyncRequestId] = useState<string>('')
  const [lastHealthRequestId, setLastHealthRequestId] = useState<string>('')
  const [lastAgentRequestId, setLastAgentRequestId] = useState<string>('')
  const [lastAgentEngine, setLastAgentEngine] = useState<string>('')
  const [desktopHealth, setDesktopHealth] = useState<DesktopHealthSnapshot | null>(null)
  const [isCheckingHealth, setIsCheckingHealth] = useState(false)
  const [selectedModel, setSelectedModel] = useState(DESKTOP_DEFAULT_MODEL)
  const [selectedExecutionMode, setSelectedExecutionMode] = useState<DesktopExecutionMode>('default')

  const [bootstrap, setBootstrap] = useState<BootstrapPayload>({
    appName: 'Forge Desktop',
    appVersion: 'loading',
    platform: 'loading',
  })
  const [deviceId, setDeviceId] = useState('unassigned')

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null)

// V2 FEATURE - Persistent Skill Registry
// V2 FEATURE - Local Vector Store Integration (RAG)
// V2 FEATURE - Diff/Patch View Interface

  const [showAuthDialog, setShowAuthDialog] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const [textDirectionMode, setTextDirectionMode] = useState<'auto' | 'ltr' | 'rtl'>('auto')
  const [uploadedFiles, setUploadedFiles] = useState<FileMetadata[]>([]);

  // ── Local Agent State ────────────────────────────────────────────
  const [useLocalMode, setUseLocalMode] = useState(() => {
    return localStorage.getItem('forge-agent-mode') === 'local'
  })
  const [showLocalSettings, setShowLocalSettings] = useState(false)
  const [localProviderConfig, setLocalProviderConfig] = useState<LocalProviderConfig>(loadProviderConfig)

  const localAgent = useLocalAgent({
    model: localProviderConfig.model,
    provider: localProviderConfig.provider,
    baseUrl: localProviderConfig.baseUrl,
    apiKey: localProviderConfig.apiKey,
  })

  const toggleAgentMode = useCallback(() => {
    setUseLocalMode((prev) => {
      const next = !prev
      localStorage.setItem('forge-agent-mode', next ? 'local' : 'remote')
      return next
    })
  }, [])

  const handleLocalConfigSaved = useCallback((config: LocalProviderConfig) => {
    setLocalProviderConfig(config)
  }, [])

  // ── Panel State ────────────────────────────────────────────────────
  const [showSkillPanel, setShowSkillPanel] = useState(false)
  const [showVectorPanel, setShowVectorPanel] = useState(false)
  const [showSubagentPanel, setShowSubagentPanel] = useState(false)
  const [showTerminalPanel, setShowTerminalPanel] = useState(false)

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    // Logic for processing files and creating FileMetadata
    console.log("Files uploaded:", event.target.files);
  };


  const messageScrollRef = useRef<HTMLDivElement | null>(null)
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const authPollingStartedAtRef = useRef<number | null>(null)
  const forgeWebBase = useMemo(() => getForgeWebBaseUrl(), [])

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions])

  const availableModels = useMemo(() => {
    if (!remoteKeySummary) return []

    const unique = new Set<string>()
    unique.add(DESKTOP_DEFAULT_MODEL)

    const remoteModel = remoteKeySummary.geminiModel.trim()
    if (remoteModel) {
      unique.add(remoteModel)
    }

    for (const preset of DESKTOP_MODEL_PRESETS) {
      unique.add(preset)
    }

    return [...unique]
  }, [remoteKeySummary])

  const activeSession = useMemo(() => {
    if (!sessions.length) return null
    return sessions.find((session) => session.id === activeSessionId) || sessions[0] || null
  }, [activeSessionId, sessions])

  const isActiveSessionRunning = Boolean(
    activeSession && runningSessionId === activeSession.id,
  )

  const activeTimeline = useMemo(() => {
    if (!activeSession) {
      return null
    }

    return sessionTimelines[activeSession.id] || null
  }, [activeSession, sessionTimelines])

  const canUndo = Boolean(activeTimeline && activeTimeline.past.length > 0)
  const canRedo = Boolean(activeTimeline && activeTimeline.future.length > 0)

  const draftDirection =
    textDirectionMode === 'auto'
      ? detectTextDirection(activeSession?.draft || '')
      : textDirectionMode

  const directionModeLabel =
    textDirectionMode === 'auto'
      ? 'Dir: Auto'
      : textDirectionMode === 'rtl'
        ? 'Dir: RTL'
        : 'Dir: LTR'

  const executionModeLabel =
    EXECUTION_MODE_OPTIONS.find((option) => option.value === selectedExecutionMode)?.label ||
    'Default'

  const resolveDirectionForText = useCallback(
    (text: string): ChatDirection => {
      if (textDirectionMode === 'auto') {
        return detectTextDirection(text)
      }

      return textDirectionMode
    },
    [textDirectionMode],
  )

  const latestAssistantMessageId = useMemo(() => {
    if (!activeSession) {
      return ''
    }

    const latestAssistant = [...activeSession.messages]
      .reverse()
      .find((message) => message.role === 'assistant')

    return latestAssistant?.id || ''
  }, [activeSession])

  const openExternalUrl = useCallback(async (url: string): Promise<boolean> => {
    try {
      await openUrl(url)
      return true
    } catch {
      try {
        const opened = window.open(url, '_blank', 'noopener,noreferrer')
        return Boolean(opened)
      } catch {
        return false
      }
    }
  }, [])

  const cycleDirectionMode = useCallback(() => {
    setTextDirectionMode((previous) => {
      if (previous === 'auto') return 'rtl'
      if (previous === 'rtl') return 'ltr'
      return 'auto'
    })
  }, [])

  const cycleExecutionMode = useCallback(() => {
    setSelectedExecutionMode((previous) => {
      const order: DesktopExecutionMode[] = ['default', 'plan', 'auto_edit', 'yolo']
      const currentIndex = order.indexOf(previous)
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % order.length
      return order[nextIndex]!
    })
  }, [])

  const updateSession = useCallback(
    (sessionId: string, updater: (session: ChatSession) => ChatSession) => {
      setSessions((previous) =>
        previous.map((session) =>
          session.id === sessionId ? clampSessionForStorage(updater(session)) : session,
        ),
      )
    },
    [],
  )

  const pushSessionRevision = useCallback(
    (
      sessionId: string,
      label: string,
      messages: ChatMessage[],
      indexedFiles: string[],
    ) => {
      setSessionTimelines((previous) => {
        const existing = previous[sessionId] || { past: [], future: [] }
        const revision: SessionRevision = {
          id: makeId('rev'),
          label,
          messages: cloneMessages(messages),
          indexedFiles: [...indexedFiles],
          createdAt: Date.now(),
        }

        const past = [...existing.past, revision]
        if (past.length > MAX_SESSION_REVISIONS) {
          past.splice(0, past.length - MAX_SESSION_REVISIONS)
        }

        return {
          ...previous,
          [sessionId]: {
            past,
            future: [],
          },
        }
      })
    },
    [],
  )

  const copyTextToClipboard = useCallback(async (value: string, successLabel: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setStatusText(successLabel)
    } catch {
      setStatusText('Copy failed. Clipboard access is unavailable right now.')
    }
  }, [])

  const undoLastSessionChange = useCallback(() => {
    if (!activeSession || isActiveSessionRunning) {
      return
    }

    const timeline = sessionTimelines[activeSession.id]
    if (!timeline || timeline.past.length === 0) {
      setStatusText('Nothing to undo yet.')
      return
    }

    const revision = timeline.past[timeline.past.length - 1]!

    setSessionTimelines((previous) => {
      const currentTimeline = previous[activeSession.id]
      if (!currentTimeline || currentTimeline.past.length === 0) {
        return previous
      }

      const currentMessages = cloneMessages(activeSession.messages)
      const currentIndexedFiles = [...activeSession.indexedFiles]

      const futureEntry: SessionRevision = {
        id: makeId('redo'),
        label: `Redo ${revision.label}`,
        messages: currentMessages,
        indexedFiles: currentIndexedFiles,
        createdAt: Date.now(),
      }

      const nextFuture = [futureEntry, ...currentTimeline.future]
      if (nextFuture.length > MAX_SESSION_REVISIONS) {
        nextFuture.splice(MAX_SESSION_REVISIONS)
      }

      return {
        ...previous,
        [activeSession.id]: {
          past: currentTimeline.past.slice(0, -1),
          future: nextFuture,
        },
      }
    })

    updateSession(activeSession.id, (session) => ({
      ...session,
      messages: cloneMessages(revision.messages),
      indexedFiles: [...revision.indexedFiles],
      updatedAt: Date.now(),
    }))

    setStatusText(`Undo applied: ${revision.label}.`)
  }, [activeSession, isActiveSessionRunning, sessionTimelines, updateSession])

  const redoLastSessionChange = useCallback(() => {
    if (!activeSession || isActiveSessionRunning) {
      return
    }

    const timeline = sessionTimelines[activeSession.id]
    if (!timeline || timeline.future.length === 0) {
      setStatusText('Nothing to redo yet.')
      return
    }

    const revision = timeline.future[0]!

    setSessionTimelines((previous) => {
      const currentTimeline = previous[activeSession.id]
      if (!currentTimeline || currentTimeline.future.length === 0) {
        return previous
      }

      const currentMessages = cloneMessages(activeSession.messages)
      const currentIndexedFiles = [...activeSession.indexedFiles]

      const pastEntry: SessionRevision = {
        id: makeId('rev'),
        label: `Undo ${revision.label}`,
        messages: currentMessages,
        indexedFiles: currentIndexedFiles,
        createdAt: Date.now(),
      }

      const nextPast = [...currentTimeline.past, pastEntry]
      if (nextPast.length > MAX_SESSION_REVISIONS) {
        nextPast.splice(0, nextPast.length - MAX_SESSION_REVISIONS)
      }

      return {
        ...previous,
        [activeSession.id]: {
          past: nextPast,
          future: currentTimeline.future.slice(1),
        },
      }
    })

    updateSession(activeSession.id, (session) => ({
      ...session,
      messages: cloneMessages(revision.messages),
      indexedFiles: [...revision.indexedFiles],
      updatedAt: Date.now(),
    }))

    setStatusText(`Redo applied: ${revision.label}.`)
  }, [activeSession, isActiveSessionRunning, sessionTimelines, updateSession])

  const prependSession = useCallback((session: ChatSession) => {
    setSessions((previous) =>
      sanitizeSessionCollectionForStorage([clampSessionForStorage(session), ...previous]),
    )
  }, [])

  const chooseWorkspaceFolder = useCallback(async (): Promise<string | null> => {
    setIsPickingFolder(true)
    try {
      const selected = await pickWorkspaceFolder()
      return selected?.trim() || null
    } finally {
      setIsPickingFolder(false)
    }
  }, [])

  const normalizeServerWarning = useCallback((warning: string): string => {
    if (/NOT_FOUND/i.test(warning)) {
      return 'Usage registry is unavailable on server (Firestore not initialized or unreachable). Login remains valid.'
    }

    return warning
  }, [])

  const refreshDesktopHealth = useCallback(
    async (tokenOverride?: string): Promise<void> => {
      const effectiveToken = (tokenOverride ?? sessionToken ?? '').trim()
      if (!effectiveToken) {
        setDesktopHealth(null)
        setLastHealthRequestId('')
        return
      }

      setIsCheckingHealth(true)
      try {
        const healthResult = await fetchDesktopHealth(effectiveToken, forgeWebBase)
        setLastHealthRequestId(healthResult.requestId || '')

        if (!healthResult.ok) {
          setDesktopHealth(null)
          setStatusText(
            healthResult.requestId
              ? `Desktop health check failed: ${healthResult.error} (request ${healthResult.requestId})`
              : `Desktop health check failed: ${healthResult.error}`,
          )
          return
        }

        setDesktopHealth(healthResult.snapshot)

        if (healthResult.snapshot.status === 'degraded') {
          const firstGuidance = healthResult.snapshot.guidance[0] || 'Backend runtime is not fully ready.'
          setStatusText(
            `Authenticated, but backend runtime is degraded. ${firstGuidance}${
              healthResult.requestId ? ` (request ${healthResult.requestId})` : ''
            }`,
          )
        }
      } catch (error) {
        setDesktopHealth(null)
        setStatusText(`Desktop health check error: ${String(error)}`)
      } finally {
        setIsCheckingHealth(false)
      }
    },
    [forgeWebBase, sessionToken],
  )

  const sendUsageTelemetry = useCallback(
    async (delta: {
      commandsExecuted?: number
      filesEdited?: number
      activeSwarms?: number
      messagesSent?: number
      assistantResponses?: number
      searchQueries?: number
      toolCalls?: number
      sessionsStarted?: number
      failedTurns?: number
      lastModel?: string
      lastProvider?: string
      lastWorkspacePath?: string
    }) => {
      if (!sessionToken) {
        return
      }

      const context: DesktopDeviceContext = {
        deviceId: (deviceId || getOrCreateDesktopDeviceId()).trim(),
        deviceName: 'Forge Desktop',
        os: bootstrap.platform,
        platform: bootstrap.platform,
        appVersion: bootstrap.appVersion,
        deviceType: 'desktop_app',
      }

      const result = await postDesktopTelemetry(sessionToken, forgeWebBase, context, {
        commandsExecuted: delta.commandsExecuted ?? 0,
        filesEdited: delta.filesEdited ?? 0,
        activeSwarms: delta.activeSwarms ?? 0,
        messagesSent: delta.messagesSent ?? 0,
        assistantResponses: delta.assistantResponses ?? 0,
        searchQueries: delta.searchQueries ?? 0,
        toolCalls: delta.toolCalls ?? 0,
        sessionsStarted: delta.sessionsStarted ?? 0,
        failedTurns: delta.failedTurns ?? 0,
        ...(delta.lastModel ? { lastModel: delta.lastModel } : {}),
        ...(delta.lastProvider ? { lastProvider: delta.lastProvider } : {}),
        ...(delta.lastWorkspacePath ? { lastWorkspacePath: delta.lastWorkspacePath } : {}),
      })

      if (result.warning) {
        console.warn('Desktop telemetry warning:', result.warning)
      }
    },
    [bootstrap.appVersion, bootstrap.platform, deviceId, forgeWebBase, sessionToken],
  )

  const syncSessionWithForge = useCallback(
    async (
      token: string,
      runtime: BootstrapPayload,
      preferredDeviceId?: string,
    ): Promise<void> => {
      const resolvedDeviceId = (preferredDeviceId || getOrCreateDesktopDeviceId()).trim()
      persistDesktopDeviceId(resolvedDeviceId)
      setDeviceId(resolvedDeviceId)
      setIsSyncingSession(true)

      const context: DesktopDeviceContext = {
        deviceId: resolvedDeviceId,
        deviceName: 'Forge Desktop',
        os: runtime.platform,
        platform: runtime.platform,
        appVersion: runtime.appVersion,
        deviceType: 'desktop_app',
      }

      try {
        const keyResult = await fetchDesktopKeys(token, forgeWebBase, context)
        setLastKeySyncRequestId(keyResult.requestId || '')

        if (!keyResult.ok) {
          if (keyResult.status === 401 || keyResult.status === 403) {
            await clearSessionToken()
            setSessionToken(null)
            setHasSavedSession(false)
            setRemoteKeySummary(null)
            setRemoteKeys(null)
            setDesktopHealth(null)
            setLastHealthRequestId('')
            setStatusText('Session expired or revoked. Please sign in again.')
            return
          }

          setRemoteKeys(null)
          setDesktopHealth(null)
          setLastHealthRequestId('')
          setStatusText(
            keyResult.requestId
              ? `Session saved, but key sync failed: ${keyResult.error} (request ${keyResult.requestId})`
              : `Session saved, but key sync failed: ${keyResult.error}`,
          )
          return
        }

        const keySummary = summarizeRemoteKeys(keyResult.keys)
        setRemoteKeySummary(keySummary)
        setRemoteKeys(keyResult.keys)
        setSelectedModel((previous) => previous.trim() || DESKTOP_DEFAULT_MODEL)

        const keyReadinessMessage =
          keySummary.geminiReady
            ? 'Authenticated and synced. Gemini backend key is available.'
            : 'Authenticated, but Gemini backend key is missing on the server.'

        if (keyResult.warning) {
          setStatusText(
            `${keyReadinessMessage} Warning: ${normalizeServerWarning(keyResult.warning)}${
              keyResult.requestId ? ` (request ${keyResult.requestId})` : ''
            }`,
          )
        } else {
          setStatusText(
            `${keyReadinessMessage}${keyResult.requestId ? ` (request ${keyResult.requestId})` : ''}`,
          )
        }

        const telemetryResult = await postDesktopTelemetry(token, forgeWebBase, context, {
          commandsExecuted: 0,
          filesEdited: 0,
          activeSwarms: 0,
          messagesSent: 0,
          assistantResponses: 0,
          searchQueries: 0,
          toolCalls: 0,
          sessionsStarted: 0,
          lastModel: keySummary.geminiModel,
          lastProvider: 'gemini',
        })

        if (telemetryResult.warning) {
          const normalizedWarning = normalizeServerWarning(
            telemetryResult.warning || 'Unknown telemetry warning.',
          )
          setStatusText((previous) => `${previous} Telemetry: ${normalizedWarning}`)
        }

        await refreshDesktopHealth(token)
      } catch (error) {
        setDesktopHealth(null)
        setStatusText(`Session sync failed: ${String(error)}`)
      } finally {
        setIsSyncingSession(false)
      }
    },
    [forgeWebBase, normalizeServerWarning, refreshDesktopHealth],
  )

  const startSignIn = useCallback(async (options?: { openDialog?: boolean }) => {
    try {
      if (options?.openDialog) {
        setShowAuthDialog(true)
      }
      setCopyStatus('')
      setStatusText('Generating secure Forge sign-in link...')

      const flow = await beginAuthFlow(forgeWebBase, 'Forge Desktop')
      setAuthUrl(flow.loginUrl)
      persistDesktopDeviceId(flow.deviceId)
      setDeviceId(flow.deviceId)
      setIsPollingAuth(true)
      authPollingStartedAtRef.current = Date.now()

      const opened = await openExternalUrl(flow.loginUrl)
      if (opened) {
        setStatusText('Login page opened. Complete sign-in and return to desktop.')
      } else {
        setShowAuthDialog(true)
        setStatusText('Login link ready. Browser did not open automatically, copy the link below.')
      }
    } catch (error) {
      setIsPollingAuth(false)
      authPollingStartedAtRef.current = null
      setStatusText(`Unable to start sign-in flow: ${String(error)}`)
    }
  }, [forgeWebBase, openExternalUrl])

  const copyLoginLink = useCallback(async () => {
    if (!authUrl) {
      setCopyStatus('No login link available yet.')
      return
    }

    try {
      await navigator.clipboard.writeText(authUrl)
      setCopyStatus('Login link copied to clipboard.')
      setStatusText('Login link copied. Paste it in your browser if opening fails.')
    } catch {
      setCopyStatus('Copy failed. Select and copy the URL manually.')
    }
  }, [authUrl])

  const copyDiagnosticsSnapshot = useCallback(() => {
    const lines = [
      `Device: ${deviceId}`,
      `Session: ${sessionToken ? 'Authenticated' : 'Guest'}`,
      `Key sync request: ${lastKeySyncRequestId || 'No key sync request yet'}`,
      `Health request: ${lastHealthRequestId || 'No health request yet'}`,
      `Agent request: ${lastAgentRequestId || 'No agent request yet'}`,
      `Agent engine: ${lastAgentEngine || 'No engine activity yet'}`,
      `Backend health: ${desktopHealth ? desktopHealth.status : 'Not checked'}`,
      `CLI runtime: ${
        desktopHealth
          ? desktopHealth.geminiCliReady
            ? 'Ready'
            : 'Unavailable'
          : 'Unknown'
      }`,
      `Backend key: ${
        desktopHealth
          ? desktopHealth.geminiKeyReady
            ? 'Configured'
            : 'Missing'
          : 'Unknown'
      }`,
      `Backend model: ${desktopHealth?.geminiModel || 'Unknown'}`,
      `CLI command source: ${desktopHealth?.cliCommandSource || 'Unknown'}`,
      `Backend runtime: ${
        desktopHealth
          ? `${desktopHealth.runtimePlatform} / ${desktopHealth.runtimeNodeVersion}`
          : 'Unknown'
      }`,
    ]

    if (desktopHealth && desktopHealth.guidance.length > 0) {
      lines.push('Guidance:')
      for (const entry of desktopHealth.guidance) {
        lines.push(`- ${entry}`)
      }
    }

    void copyTextToClipboard(lines.join('\n'), 'Diagnostics copied to clipboard.')
  }, [
    copyTextToClipboard,
    desktopHealth,
    deviceId,
    lastAgentEngine,
    lastAgentRequestId,
    lastHealthRequestId,
    lastKeySyncRequestId,
    sessionToken,
  ])

  const resetSessionToken = useCallback(async () => {
    await clearSessionToken()
    setSessionToken(null)
    setHasSavedSession(false)
    setRemoteKeySummary(null)
    setRemoteKeys(null)
    setDesktopHealth(null)
    setLastHealthRequestId('')
    setStatusText('Stored desktop session cleared.')
  }, [])

  const beginNewWorkspaceSession = useCallback(async () => {
    const selectedFolder = await chooseWorkspaceFolder()
    if (!selectedFolder) {
      setStatusText('Folder selection cancelled.')
      return
    }

    const session = createSession(selectedFolder)
    prependSession(session)
    setActiveSessionId(session.id)
    setSidebarOpen(true)
    setStartupStep('chat')
    setStatusText(`Workspace selected: ${selectedFolder}`)
    void sendUsageTelemetry({ sessionsStarted: 1, lastWorkspacePath: selectedFolder })
  }, [chooseWorkspaceFolder, prependSession, sendUsageTelemetry])

  const continueWithSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    setStartupStep('chat')
    setSidebarOpen(true)
    setStatusText('Session loaded.')
  }, [])

  const continueLatestSession = useCallback(() => {
    if (!sortedSessions.length) return
    continueWithSession(sortedSessions[0]!.id)
  }, [continueWithSession, sortedSessions])

  const createSiblingSession = useCallback(async () => {
    const baseWorkspace = activeSession?.workspacePath.trim() || ''

    if (!baseWorkspace) {
      const selectedFolder = await chooseWorkspaceFolder()
      if (!selectedFolder) {
        setStatusText('No workspace selected for new session.')
        return
      }

      const session = createSession(selectedFolder)
      prependSession(session)
      setActiveSessionId(session.id)
      setStartupStep('chat')
      setStatusText(`New empty session created for ${selectedFolder}`)
      void sendUsageTelemetry({ sessionsStarted: 1, lastWorkspacePath: selectedFolder })
      return
    }

    const session = createSession(baseWorkspace)
    prependSession(session)
    setActiveSessionId(session.id)
    setStartupStep('chat')
    setStatusText(`New empty session created in ${baseWorkspace}`)
    void sendUsageTelemetry({ sessionsStarted: 1, lastWorkspacePath: baseWorkspace })
  }, [activeSession, chooseWorkspaceFolder, prependSession, sendUsageTelemetry])

  const closeSession = useCallback(
    (sessionId: string) => {
      setSessions((previous) => {
        const remaining = previous.filter((session) => session.id !== sessionId)

        if (remaining.length === 0) {
          setActiveSessionId('')
          setStartupStep('onboarding')
          return []
        }

        if (activeSessionId === sessionId) {
          setActiveSessionId(remaining[0]!.id)
        }

        return remaining
      })
    },
    [activeSessionId],
  )

  const changeWorkspaceFolder = useCallback(async () => {
    if (!activeSession) return

    const selectedFolder = await chooseWorkspaceFolder()
    if (!selectedFolder) {
      setStatusText('Folder selection cancelled.')
      return
    }

    updateSession(activeSession.id, (session) => ({
      ...session,
      workspacePath: selectedFolder,
      indexedFiles: [],
      updatedAt: Date.now(),
    }))

    setStatusText(`Workspace switched to ${selectedFolder}`)
  }, [activeSession, chooseWorkspaceFolder, updateSession])

  const runAgentTurn = useCallback(
    async (options?: { overridePrompt?: string; mode?: AgentTurnMode } | string) => {
      if (!activeSession || runningSessionId) {
        return
      }

      const mode: AgentTurnMode =
        typeof options === 'string' ? 'normal' : options?.mode || 'normal'
      const overridePrompt = typeof options === 'string' ? options : options?.overridePrompt

      const fallbackPrompt =
        mode === 'regenerate' ? getLastUserPrompt(activeSession.messages) : activeSession.draft

      const prompt = (overridePrompt ?? fallbackPrompt).trim()
      if (!prompt) {
        if (mode === 'regenerate') {
          setStatusText('No earlier user prompt found to regenerate.')
        }
        return
      }

      const sessionId = activeSession.id
      const workspacePath = activeSession.workspacePath.trim()
      const baseMessages = cloneMessages(activeSession.messages)
      const lastBaseMessage =
        baseMessages.length > 0 ? baseMessages[baseMessages.length - 1] : undefined
      const historySeedMessages =
        mode === 'regenerate' && lastBaseMessage?.role === 'assistant'
          ? baseMessages.slice(0, -1)
          : baseMessages

      pushSessionRevision(
        sessionId,
        mode === 'regenerate' ? 'Regenerate agent response' : 'Run prompt',
        activeSession.messages,
        activeSession.indexedFiles,
      )

      let userMessage: ChatMessage | null = null

      if (mode === 'normal') {
        const nextUserMessage: ChatMessage = {
          id: makeId('msg'),
          role: 'user',
          content: prompt,
          createdAt: Date.now(),
        }

        userMessage = nextUserMessage

        updateSession(sessionId, (session) => ({
          ...session,
          messages: [...session.messages, nextUserMessage],
          draft: '',
          updatedAt: Date.now(),
          title:
            session.title === DEFAULT_SESSION_TITLE
              ? toSessionTitleFromPrompt(prompt)
              : session.title,
        }))
      } else {
        updateSession(sessionId, (session) => {
          const lastSessionMessage =
            session.messages.length > 0
              ? session.messages[session.messages.length - 1]
              : undefined
          const trimmedMessages =
            lastSessionMessage?.role === 'assistant'
              ? session.messages.slice(0, -1)
              : session.messages

          return {
            ...session,
            messages: trimmedMessages,
            updatedAt: Date.now(),
          }
        })
      }

      setRunningSessionId(sessionId)
      setStatusText('Agent is working...')

      // Let the UI paint the pending state before heavier context collection starts.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))

      // ── Local Agent Mode ──────────────────────────────────────────
      if (useLocalMode) {
        setStatusText('Local agent is working...')

        const history = activeSession.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-8)
          .map((m) => ({ role: m.role, content: m.content }))

        try {
          const result = await localAgent.runAgent(prompt, {
            workspacePath,
            history,
            systemPrompt: `You are Forge Desktop, an autonomous AI coding agent. You have access to the local filesystem and terminal through the workspace. Be thorough but efficient.`,
            onToolEvent: (evt) => {
              // Live-update tool events in session
            },
          })

          const assistantMessage: ChatMessage = {
            id: makeId('msg'),
            role: 'assistant',
            content: result.ok ? result.reply : `Agent error: ${result.error || 'Unknown failure'}`,
            createdAt: Date.now(),
            executionMode: selectedExecutionMode,
            thinking: result.thinking.length > 0 ? result.thinking : undefined,
            tools: result.toolEvents.length > 0
              ? result.toolEvents.map((evt) => ({
                  name: evt.name,
                  status: evt.status,
                  detail: evt.detail,
                }))
              : undefined,
          }

          updateSession(sessionId, (session) => ({
            ...session,
            messages: [...session.messages, assistantMessage],
            updatedAt: Date.now(),
          }))

          setStatusText(
            result.ok
              ? `Local agent complete. ${result.stepsExecuted} steps, ${result.toolsUsed.length} tools used.`
              : `Local agent error: ${result.error || 'Unknown'}`,
          )
        } catch (error) {
          const failureMessage: ChatMessage = {
            id: makeId('msg'),
            role: 'assistant',
            content: `Local agent failed: ${String(error)}`,
            createdAt: Date.now(),
          }

          updateSession(sessionId, (session) => ({
            ...session,
            messages: [...session.messages, failureMessage],
            updatedAt: Date.now(),
          }))

          setStatusText(`Local agent failed: ${String(error)}`)
        } finally {
          setRunningSessionId(null)
        }
        return
      }
      // ── End Local Agent Mode ───────────────────────────────────────

      const toolEvents: ToolEvent[] = []
      const toolResults: DesktopAgentToolResult[] = []
      const thinking: string[] = [
        'Interpreting your request.',
        'Selecting relevant local tools and context.',
      ]

      let indexedFiles: string[] | null = null

      const pushTool = (
        name: string,
        status: ToolEvent['status'],
        detail: string,
      ): void => {
        toolEvents.push({ name, status, detail })
      }

      toolResults.push({
        name: 'desktop_workspace_context',
        output: trimToolOutput(
          [
            `Workspace path: ${workspacePath || '[not selected]'}`,
            'Runtime contract: local workspace data is provided through desktop tool outputs only.',
            'Do not assume direct backend filesystem access to the user path.',
          ].join('\n'),
          1400,
        ),
      })

      try {
        const normalizedPrompt = prompt.toLowerCase()
        const explicitIndexCommand = /^\s*\/index\b/i.test(prompt)

        const lastAssistantMessage = [...activeSession.messages]
          .filter((message) => message.role === 'assistant')
          .slice(-1)[0]?.content
          .toLowerCase() || ''

        const isSimpleConfirmation =
          /^(yes|yes please|sure|go ahead|ok|okay|do it|yep|yeah)\b/.test(
            normalizedPrompt,
          )

        const lastAssistantAskedForWorkspaceScan =
          /(list|show|explore|scan).*(files|workspace|directory|project|readme)/i.test(
            lastAssistantMessage,
          )

        const wantsProjectOverview =
          /(what\s+is\s+this|what\s+is\s+it\s+about|tell\s+me\s+about\s+(this|it)|project\s+overview|project\s+summary|repo\s+overview|read\s+files\s+from\s+it)/i.test(
            prompt,
          )

        const wantsIndex =
          explicitIndexCommand ||
          /(list|show).*(files|workspace|project|tree|folders|directories)/i.test(prompt) ||
          wantsProjectOverview ||
          (isSimpleConfirmation && lastAssistantAskedForWorkspaceScan)

        const wantsDirs =
          /^\s*\/dirs\b/i.test(prompt) ||
          /(list|show).*(dirs|directories|folders)/i.test(prompt)

        if (wantsIndex || wantsDirs) {
          if (!workspacePath) {
            pushTool(
              'list_workspace_files',
              'error',
              'No workspace selected. Use Select Folder first.',
            )
          } else {
            pushTool('list_workspace_files', 'running', workspacePath)

            try {
              const indexingDepth = explicitIndexCommand || wantsDirs ? 4 : 2
              const files = await listWorkspaceFiles(workspacePath, indexingDepth)
              indexedFiles = files
              const displayed = (
                wantsDirs
                  ? files.filter((entry) => entry.endsWith('/'))
                  : files
              ).slice(0, 500)

              toolResults.push({
                name: 'list_workspace_files',
                output: trimToolOutput(displayed.join('\n') || 'No entries found.'),
              })

              pushTool(
                'list_workspace_files',
                'done',
                `Returned ${displayed.length} entries.`,
              )
              thinking.push(`Indexed ${displayed.length} entries from workspace.`)
            } catch (error) {
              pushTool('list_workspace_files', 'error', String(error))
            }
          }
        }

        const readTarget = extractReadTarget(prompt)
        const shouldAutoReadReadme =
          !readTarget &&
          (wantsProjectOverview ||
            (isSimpleConfirmation && lastAssistantAskedForWorkspaceScan) ||
            /\breadme\b|project\s+overview|repo\s+overview|project\s+summary|\bread\s+it\b/i.test(
              prompt,
            ))

        if (readTarget) {
          const resolvedPath = resolveWorkspaceFilePath(workspacePath, readTarget)

          if (!resolvedPath) {
            pushTool(
              'read_workspace_file',
              'error',
              'Unable to resolve file path. Choose a workspace first or use absolute path.',
            )
          } else {
            pushTool('read_workspace_file', 'running', resolvedPath)

            try {
              const fileContent = await readWorkspaceFile(resolvedPath, 80000)
              toolResults.push({
                name: 'read_workspace_file',
                output: trimToolOutput(`Path: ${resolvedPath}\n\n${fileContent}`, 7000),
              })

              pushTool('read_workspace_file', 'done', `Loaded ${resolvedPath}.`)
              thinking.push(`Read file context from ${resolvedPath}.`)
            } catch (error) {
              pushTool('read_workspace_file', 'error', String(error))
            }
          }
        } else if (shouldAutoReadReadme && workspacePath) {
          const candidates = ['README.md', 'readme.md', 'README.MD']
          let readmeLoaded = false

          for (const candidate of candidates) {
            const resolvedPath = resolveWorkspaceFilePath(workspacePath, candidate)
            if (!resolvedPath) {
              continue
            }

            pushTool('read_workspace_file', 'running', resolvedPath)
            try {
              const fileContent = await readWorkspaceFile(resolvedPath, 80000)
              toolResults.push({
                name: 'read_workspace_file',
                output: trimToolOutput(`Path: ${resolvedPath}\n\n${fileContent}`, 7000),
              })
              pushTool('read_workspace_file', 'done', `Loaded ${resolvedPath}.`)
              thinking.push(`Read project README from ${resolvedPath}.`)
              readmeLoaded = true
              break
            } catch {
              pushTool('read_workspace_file', 'error', `Could not open ${resolvedPath}.`)
            }
          }

          if (!readmeLoaded) {
            pushTool(
              'read_workspace_file',
              'error',
              'README was not found in the selected workspace root.',
            )
          }
        }

        const slashSearch = prompt.match(/^\s*\/search\s+(.+)$/i)
        const searchQuery = slashSearch?.[1]?.trim() || prompt
        const shouldSearch =
          activeSession.searchEnabled &&
          (Boolean(slashSearch) ||
            /(search|research|look up|lookup|latest|news|docs|documentation)/i.test(
              prompt,
            ))

        if (shouldSearch) {
          if (!sessionToken) {
            pushTool('searchDesktopWeb', 'error', 'Sign in required for web search.')
          } else {
            pushTool('searchDesktopWeb', 'running', searchQuery.slice(0, 160))
            const searchResult = await searchDesktopWeb(
              sessionToken,
              forgeWebBase,
              searchQuery,
            )

            if (!searchResult.ok) {
              if (searchResult.status === 401 || searchResult.status === 403) {
                await clearSessionToken()
                setSessionToken(null)
                setHasSavedSession(false)
                setRemoteKeySummary(null)
                setRemoteKeys(null)
              }

              pushTool('searchDesktopWeb', 'error', searchResult.error)
            } else {
              toolResults.push({
                name: 'searchDesktopWeb',
                output: trimToolOutput(
                  searchResult.results
                    .map(
                      (entry, index) =>
                        `${index + 1}. ${entry.title}\nURL: ${entry.url}\nSnippet: ${entry.snippet}`,
                    )
                    .join('\n\n') || 'No web sources found.',
                ),
              })

              pushTool(
                'searchDesktopWeb',
                'done',
                `Collected ${searchResult.results.length} web sources.`,
              )
            }
          }
        }

        thinking.push('Preparing final response.')

        const historySource = userMessage
          ? [...historySeedMessages, userMessage]
          : historySeedMessages

        const history: DesktopAgentMessage[] = historySource
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .slice(-12)
          .map((message) => ({
            role: message.role,
            content: message.content,
          }))

        const chatResult = await runDesktopAgentChat(sessionToken, forgeWebBase, {
          message: prompt,
          history,
          toolResults,
          thinkingHints: thinking,
          workspacePath,
          workspaceLabel: getWorkspaceLabel(workspacePath),
          workspaceFiles: activeSession.indexedFiles.slice(0, 120),
          modelPreference: selectedModel || undefined,
          providerPreference: 'gemini-cli',
          executionMode: selectedExecutionMode,
          sessionId,
        })
        setLastAgentRequestId(chatResult.requestId || '')
        setLastAgentEngine(chatResult.engine || '')

        if (chatResult.ok && chatResult.toolEvents.length > 0) {
          for (const modelTool of chatResult.toolEvents) {
            pushTool(`model:${modelTool.name}`, modelTool.status, modelTool.detail)
          }
        }

        if (!chatResult.ok && chatResult.toolEvents && chatResult.toolEvents.length > 0) {
          for (const modelTool of chatResult.toolEvents) {
            pushTool(`model:${modelTool.name}`, modelTool.status, modelTool.detail)
          }
        }

        if (chatResult.ok && chatResult.warning) {
          thinking.push(`Model runtime warning: ${chatResult.warning}`)
        }

        if (!chatResult.ok && (chatResult.status === 401 || chatResult.status === 403)) {
          await clearSessionToken()
          setSessionToken(null)
          setHasSavedSession(false)
          setRemoteKeySummary(null)
          setRemoteKeys(null)
          setDesktopHealth(null)
          setLastHealthRequestId('')
        }

        const assistantContent = chatResult.ok
          ? chatResult.reply
          : `Gemini CLI execution failed.${
              chatResult.errorCode ? ` [${chatResult.errorCode}]` : ''
            } ${chatResult.error}${
              chatResult.requestId ? ` (request ${chatResult.requestId})` : ''
            }`

        const resolvedExecutionMode: DesktopExecutionMode =
          chatResult.executionMode ||
          (looksLikePlanResponse(assistantContent) ? 'plan' : selectedExecutionMode)

        const assistantMessage: ChatMessage = {
          id: makeId('msg'),
          role: 'assistant',
          content: assistantContent,
          createdAt: Date.now(),
          executionMode: resolvedExecutionMode,
          thinking:
            chatResult.ok && chatResult.thinking.length > 0
              ? chatResult.thinking
              : thinking,
          tools: toolEvents,
        }

        updateSession(sessionId, (session) => ({
          ...session,
          messages: [...session.messages, assistantMessage],
          indexedFiles: indexedFiles || session.indexedFiles,
          updatedAt: Date.now(),
        }))

        if (chatResult.ok) {
          const engineSuffix = chatResult.engine ? ` via ${chatResult.engine}` : ''
          const warningSuffix = chatResult.warning ? ` Warning: ${chatResult.warning}` : ''
          setStatusText(
            `Agent response complete${engineSuffix} [mode ${resolvedExecutionMode}].${chatResult.requestId ? ` (request ${chatResult.requestId})` : ''}${warningSuffix}`,
          )
        } else {
          const compactError = chatResult.error.replace(/\s+/g, ' ').trim()
          setStatusText(
            `Gemini CLI execution failed.${chatResult.errorCode ? ` [${chatResult.errorCode}]` : ''}${
              chatResult.requestId ? ` (request ${chatResult.requestId})` : ''
            } ${compactError}`,
          )
        }
      } catch (error) {
        const failureMessage: ChatMessage = {
          id: makeId('msg'),
          role: 'assistant',
          content: `Agent execution failed: ${String(error)}`,
          createdAt: Date.now(),
          thinking,
          tools: toolEvents,
        }

        updateSession(sessionId, (session) => ({
          ...session,
          messages: [...session.messages, failureMessage],
          updatedAt: Date.now(),
        }))

        setStatusText(`Agent execution failed: ${String(error)}`)
      } finally {
        setRunningSessionId(null)
      }
    },
    [
      activeSession,
      forgeWebBase,
      pushSessionRevision,
      runningSessionId,
      selectedExecutionMode,
      selectedModel,
      sessionToken,
      updateSession,
      useLocalMode,
      localAgent,
    ],
  )

  const regenerateLastResponse = useCallback(() => {
    if (!activeSession || isActiveSessionRunning) {
      return
    }

    const prompt = getLastUserPrompt(activeSession.messages)
    if (!prompt) {
      setStatusText('No user prompt found to regenerate from.')
      return
    }

    void runAgentTurn({
      mode: 'regenerate',
      overridePrompt: prompt,
    })
  }, [activeSession, isActiveSessionRunning, runAgentTurn])

  useEffect(() => {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY)
    const initialTheme = savedTheme === 'dark' ? 'dark' : 'light'
    setTheme(initialTheme)

    const savedDirection = localStorage.getItem(DIRECTION_MODE_STORAGE_KEY)
    if (savedDirection === 'auto' || savedDirection === 'ltr' || savedDirection === 'rtl') {
      setTextDirectionMode(savedDirection)
    }

    const savedExecutionMode = localStorage.getItem(EXECUTION_MODE_STORAGE_KEY)
    const normalizedExecutionMode = normalizeExecutionMode(savedExecutionMode)
    if (normalizedExecutionMode) {
      setSelectedExecutionMode(normalizedExecutionMode)
    }

    const storedSessions = loadStoredSessions()
    setSessions(storedSessions)

    if (storedSessions.length > 0) {
      const storedActiveId = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)
      const hasStoredActive =
        Boolean(storedActiveId) &&
        storedSessions.some((session) => session.id === storedActiveId)

      setActiveSessionId(hasStoredActive ? (storedActiveId as string) : storedSessions[0]!.id)
      setStartupStep('onboarding')
    } else {
      setActiveSessionId('')
      setStartupStep('onboarding')
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(DIRECTION_MODE_STORAGE_KEY, textDirectionMode)
  }, [textDirectionMode])

  useEffect(() => {
    localStorage.setItem(EXECUTION_MODE_STORAGE_KEY, selectedExecutionMode)
  }, [selectedExecutionMode])

  useEffect(() => {
    if (sessions.length === 0) {
      localStorage.removeItem(SESSION_STORAGE_KEY)
      return
    }

    const sanitizedSessions = sanitizeSessionCollectionForStorage(sessions)
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sanitizedSessions))
  }, [sessions])

  useEffect(() => {
    if (!activeSessionId) {
      localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
      return
    }

    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, activeSessionId)
  }, [activeSessionId])

  useEffect(() => {
    if (sessions.length === 0) return
    if (sessions.some((session) => session.id === activeSessionId)) return
    setActiveSessionId(sessions[0]!.id)
  }, [activeSessionId, sessions])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const payload = await getBootstrapPayload()
      if (cancelled) return

      setBootstrap(payload)

      const resolvedDeviceId = getOrCreateDesktopDeviceId()
      setDeviceId(resolvedDeviceId)

      const token = await loadSessionToken()
      if (cancelled) return

      if (token) {
        setSessionToken(token)
        setHasSavedSession(true)
        setStatusText(`Runtime online on ${payload.platform}. Restoring authenticated session...`)
        await syncSessionWithForge(token, payload, resolvedDeviceId)
      } else {
        setSessionToken(null)
        setStatusText(`Runtime online on ${payload.platform}. Sign in to continue.`)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [syncSessionWithForge])

  useEffect(() => {
    if (!isPollingAuth) return

    const intervalId = window.setInterval(() => {
      void (async () => {
        const pollStartedAt = authPollingStartedAtRef.current
        if (pollStartedAt && Date.now() - pollStartedAt > 5 * 60 * 1000) {
          setIsPollingAuth(false)
          authPollingStartedAtRef.current = null
          setStatusText('Sign-in callback timed out. Start sign-in again from Account.')
          return
        }

        const status = await getAuthStatus()

        if (status.status === 'success' && status.hasToken) {
          const token = await consumeAuthToken()
          if (!token) return

          await saveSessionToken(token)
          setSessionToken(token)

          const callbackDeviceId = readStoredDesktopDeviceId() || getOrCreateDesktopDeviceId()
          setDeviceId(callbackDeviceId)

          setHasSavedSession(true)
          setIsPollingAuth(false)
          authPollingStartedAtRef.current = null
          setStatusText('Authenticated. Syncing keys and device state...')
          await syncSessionWithForge(token, bootstrap, callbackDeviceId)
          return
        }

        if (status.status === 'error') {
          setIsPollingAuth(false)
          authPollingStartedAtRef.current = null
          setStatusText(status.error || 'Desktop callback failed. Please retry sign-in.')
        }
      })().catch((error) => {
        setIsPollingAuth(false)
        authPollingStartedAtRef.current = null
        setStatusText(`Auth polling failed: ${String(error)}`)
      })
    }, 1200)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [bootstrap, isPollingAuth, syncSessionWithForge])

  useEffect(() => {
    if (!messageScrollRef.current || startupStep !== 'chat') return
    messageScrollRef.current.scrollTop = messageScrollRef.current.scrollHeight
  }, [
    activeSession?.id,
    activeSession?.messages.length,
    isActiveSessionRunning,
    startupStep,
  ])

  useEffect(() => {
    if (!composerTextareaRef.current || !activeSession || startupStep !== 'chat') {
      return
    }

    const textarea = composerTextareaRef.current
    textarea.style.height = '0px'
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 54), 190)
    textarea.style.height = `${nextHeight}px`
  }, [activeSession?.draft, activeSession?.id, startupStep])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMeta = event.ctrlKey || event.metaKey
      if (!isMeta) {
        return
      }

      const target = event.target as HTMLElement | null
      const isEditable = Boolean(
        target &&
          (target.tagName === 'TEXTAREA' ||
            target.tagName === 'INPUT' ||
            target.isContentEditable),
      )

      if (isEditable) {
        return
      }

      const key = event.key.toLowerCase()
      const wantsUndo = key === 'z' && !event.shiftKey
      const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey)

      if (wantsUndo) {
        event.preventDefault()
        undoLastSessionChange()
        return
      }

      if (wantsRedo) {
        event.preventDefault()
        redoLastSessionChange()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [redoLastSessionChange, undoLastSessionChange])

  const shellClass = startupStep === 'chat' && sidebarOpen ? 'sidebar-open' : 'sidebar-closed'

  return (
    <div className={`chat-shell ${shellClass}`}>
      {startupStep === 'chat' && activeSession && (
        <aside className="session-sidebar">
          <div className="sidebar-head">
            <h2>Sessions</h2>
            <div className="sidebar-head-actions">
              <button type="button" className="secondary-btn" onClick={() => void createSiblingSession()}>
                New
              </button>
              <button type="button" className="secondary-btn" onClick={() => setSidebarOpen(false)}>
                Hide
              </button>
            </div>
          </div>

          <div className="session-list">
            {sortedSessions.map((session) => (
              <div key={session.id} className={`session-row ${session.id === activeSession.id ? 'active' : ''}`}>
                <button type="button" className="session-switch" onClick={() => setActiveSessionId(session.id)}>
                  <span className="session-title">{session.title}</span>
                  <span className="session-subtitle">{getWorkspaceLabel(session.workspacePath)}</span>
                  <span className="session-time">{new Date(session.updatedAt).toLocaleTimeString()}</span>
                </button>
                <button
                  type="button"
                  className="session-close"
                  onClick={() => closeSession(session.id)}
                  aria-label={`Close ${session.title}`}
                >
                  x
                </button>
              </div>
            ))}
          </div>
        </aside>
      )}

      <section className="chat-main">
        <header className="chat-topbar">
          <div className="topbar-left">
            {startupStep === 'chat' && !sidebarOpen && (
              <button type="button" className="secondary-btn" onClick={() => setSidebarOpen(true)}>
                Sessions
              </button>
            )}
            <div className="brand-block">
              <strong>Forge Desktop</strong>
              <span>{activeSession ? getWorkspaceLabel(activeSession.workspacePath) : 'No folder selected'}</span>
            </div>
          </div>

          <div className="topbar-right">
            <span className="top-pill">{bootstrap.platform}</span>
            <span className="top-pill">{bootstrap.appVersion}</span>
            <span className="top-pill">
              {isSyncingSession ? 'Syncing' : sessionToken ? 'Signed In' : 'Guest'}
            </span>
            {remoteKeySummary && <span className="top-pill">provider: gemini-cli</span>}
            {remoteKeySummary && (
              <span className="top-pill">{selectedModel || remoteKeySummary.geminiModel}</span>
            )}
            <span className="top-pill">mode: {executionModeLabel}</span>

            {/* Agent Mode Toggle */}
            <div className="agent-mode-toggle">
              <button
                className={!useLocalMode ? 'active' : ''}
                onClick={() => !useLocalMode || toggleAgentMode()}
                title="Remote agent via Forge API"
              >
                ☁️ Remote
              </button>
              <button
                className={useLocalMode ? 'active' : ''}
                onClick={() => useLocalMode ? setShowLocalSettings(true) : toggleAgentMode()}
                title={useLocalMode ? 'Configure local agent' : 'Switch to local agent loop'}
              >
                ⚡ Local
              </button>
              {useLocalMode && (
                <span className="mode-status">
                  {localProviderConfig.model} via {localProviderConfig.provider}
                </span>
              )}
            </div>

            {startupStep === 'chat' && (
              <button type="button" className="secondary-btn" onClick={() => void changeWorkspaceFolder()}>
                Select Folder
              </button>
            )}

            <button
              type="button"
              className="secondary-btn"
              onClick={() => {
                if (sessionToken) {
                  setShowAuthDialog(true)
                } else {
                  void startSignIn()
                }
              }}
              disabled={isPollingAuth}
            >
              {sessionToken ? 'Account' : isPollingAuth ? 'Opening...' : 'Sign In'}
            </button>

            <button type="button" className="secondary-btn" onClick={() => setTheme((previous) => nextTheme(previous))}>
              {theme === 'light' ? 'Dark' : 'Light'}
            </button>

            <button
              type="button"
              className="secondary-btn"
              onClick={() => setShowSkillPanel(true)}
              title="Manage agent skills"
            >
              🧩 Skills
            </button>

            <button
              type="button"
              className="secondary-btn"
              onClick={() => setShowVectorPanel(true)}
              title="Vector search & RAG"
            >
              🔍 RAG
            </button>

            <button
              type="button"
              className="secondary-btn"
              onClick={() => setShowSubagentPanel(true)}
              title="View subagent activity"
            >
              🤖 Agents
            </button>

            <button
              type="button"
              className="secondary-btn"
              onClick={() => setShowTerminalPanel(true)}
              title="Sandboxed terminal"
            >
              ⌨️ Term
            </button>
          </div>
        </header>

        <div className="chat-status">{statusText}</div>

        {startupStep === 'chat' && activeSession ? (
          <>
            <div className="message-scroller" ref={messageScrollRef}>
              {activeSession.messages.length === 0 && (
                <div className="empty-chat-state">
                  <h3>Empty chat</h3>
                  <p>
                    Start by describing the task for this workspace. You can also use
                    commands like /index, /dirs, /read path/to/file, and /search query.
                  </p>
                </div>
              )}

              {activeSession.messages.map((message) => {
                const messageDirection = resolveDirectionForText(message.content)
                const isLatestAssistant =
                  message.role === 'assistant' && message.id === latestAssistantMessageId
                const isPlanModeMessage =
                  message.role === 'assistant' &&
                  (message.executionMode === 'plan' || looksLikePlanResponse(message.content))

                return (
                  <article
                    key={message.id}
                    className={`chat-message ${message.role} ${
                      messageDirection === 'rtl' ? 'rtl-message' : ''
                    } ${isPlanModeMessage ? 'plan-message' : ''}`}
                  >
                    <div className="message-role">{message.role === 'assistant' ? 'Forge Agent' : 'You'}</div>
                    {isPlanModeMessage && (
                      <div className="plan-mode-banner">
                        Plan Mode: Proposed steps only. Confirm before execution.
                      </div>
                    )}
                    <div className="message-body markdown-body">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          a: ({ href, children, ...props }) => (
                            <a
                              {...props}
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(event) => {
                                if (!href) {
                                  return
                                }

                                if (!isSafeExternalUrl(href)) {
                                  event.preventDefault()
                                  setStatusText('Blocked unsafe link scheme from agent response.')
                                  return
                                }

                                event.preventDefault()
                                void openExternalUrl(href)
                              }}
                            >
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>

                    {message.role === 'assistant' && (
                      <div className="message-actions-row">
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() =>
                            void copyTextToClipboard(
                              message.content,
                              'Agent response copied to clipboard.',
                            )
                          }
                        >
                          Copy
                        </button>
                        {isLatestAssistant && (
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={regenerateLastResponse}
                            disabled={isActiveSessionRunning}
                          >
                            Regenerate
                          </button>
                        )}
                      </div>
                    )}

                    {message.thinking && message.thinking.length > 0 && (
                      <details className="message-meta">
                        <summary>Thinking ({message.thinking.length})</summary>
                        <ul>
                          {message.thinking.map((item, index) => (
                            <li key={`${item}-${index}`}>{item}</li>
                          ))}
                        </ul>
                      </details>
                    )}

                    {message.tools && message.tools.length > 0 && (
                      <details className="message-meta">
                        <summary>Tool Calls ({message.tools.length})</summary>
                        <ul className="tool-meta-list">
                          {message.tools.map((tool, index) => (
                            <li key={`${tool.name}-${index}`}>
                              <span className={`tool-badge ${tool.status}`}>{tool.status}</span>
                              <strong>{tool.name}</strong>
                              <p>{tool.detail}</p>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </article>
                )
              })}

              {isActiveSessionRunning && (
                <article className="chat-message assistant running-message">
                  <div className="message-role">Forge Agent</div>
                  <div className="message-body markdown-body">
                    <p>Working on your request...</p>
                  </div>
                </article>
              )}
            </div>

            <form
              className="chat-composer"
              onSubmit={(event) => {
                event.preventDefault()
                void runAgentTurn()
              }}
            >
              <textarea
                ref={composerTextareaRef}
                value={activeSession.draft}
                placeholder="Message Forge Agent... (Shift+Enter for newline, Enter to send)"
                dir={draftDirection}
                lang={draftDirection === 'rtl' ? 'ar' : 'en'}
                onChange={(event) => {
                  updateSession(activeSession.id, (session) => ({
                    ...session,
                    draft: event.target.value,
                    updatedAt: Date.now(),
                  }))
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    if (!isActiveSessionRunning) {
                      void runAgentTurn()
                    }
                  }
                }}
                rows={3}
              />

              <div className="composer-actions">
                <div className="composer-actions-left">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={undoLastSessionChange}
                    disabled={!canUndo || isActiveSessionRunning}
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={redoLastSessionChange}
                    disabled={!canRedo || isActiveSessionRunning}
                  >
                    Redo
                  </button>
                  <button type="button" className="secondary-btn" onClick={cycleDirectionMode}>
                    {directionModeLabel}
                  </button>
                  <button type="button" className="secondary-btn" onClick={cycleExecutionMode}>
                    Mode: {executionModeLabel}
                  </button>
                </div>

                <div className="composer-actions-right">
                  <button type="button" className="secondary-btn" onClick={() => void runAgentTurn('/index')}>
                    /index
                  </button>
                  <button type="button" className="secondary-btn" onClick={() => void runAgentTurn('/dirs')}>
                    /dirs
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={regenerateLastResponse}
                    disabled={!latestAssistantMessageId || isActiveSessionRunning}
                  >
                    Regenerate
                  </button>
                  <button
                    type="submit"
                    className="primary-btn"
                    disabled={isActiveSessionRunning || !activeSession.draft.trim()}
                  >
                    {isActiveSessionRunning ? 'Running...' : 'Send'}
                  </button>
                </div>
              </div>
            </form>
          </>
        ) : (
          <div className="onboarding-main-placeholder" />
        )}
      </section>

      {startupStep === 'onboarding' && (
        <div className="overlay-shell">
          <div className="onboarding-card">
            <p className="eyebrow">Forge Desktop</p>
            {!sessionToken ? (
              <>
                <h1>Sign in first</h1>
                <p>
                  Authentication comes first. After sign-in, you will choose the folder or directory to work on.
                </p>

                <div className="onboarding-actions">
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => void startSignIn()}
                    disabled={isPollingAuth}
                  >
                    {isPollingAuth ? 'Opening Browser...' : 'Sign In'}
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setShowAuthDialog(true)}
                  >
                    Account Details
                  </button>
                </div>
              </>
            ) : (
              <>
                <h1>Select a workspace to begin</h1>
                <p>
                  Choose a project folder, or continue one of your recent authenticated sessions.
                </p>

                <div className="onboarding-actions">
                  <button type="button" className="primary-btn" onClick={() => void beginNewWorkspaceSession()} disabled={isPickingFolder}>
                    {isPickingFolder ? 'Selecting...' : 'Select Folder'}
                  </button>
                  {sortedSessions.length > 0 && (
                    <button type="button" className="secondary-btn" onClick={continueLatestSession}>
                      Continue Last Session
                    </button>
                  )}
                </div>

                {sortedSessions.length > 0 && (
                  <div className="recent-list">
                    <h2>Recent Sessions</h2>
                    {sortedSessions.slice(0, 8).map((session) => (
                      <button key={session.id} type="button" className="recent-item" onClick={() => continueWithSession(session.id)}>
                        <span>{session.title}</span>
                        <small>{getWorkspaceLabel(session.workspacePath)}</small>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {showAuthDialog && (
        <div className="overlay-shell">
          <div className="auth-card">
            <div className="auth-head">
              <h2>Authentication</h2>
              <button type="button" className="secondary-btn" onClick={() => setShowAuthDialog(false)}>
                Close
              </button>
            </div>

            <p className="muted">API endpoint: {forgeWebBase}</p>
            <p className="muted">
              Session: {sessionToken ? 'Signed in' : 'Guest'}
              {remoteKeySummary
                ? ` | Gemini key ${remoteKeySummary.geminiReady ? 'ready' : 'missing'}`
                : ''}
            </p>

            <div className="auth-actions compact">
              <button
                type="button"
                className="primary-btn"
                disabled={isPollingAuth}
                onClick={() => void startSignIn({ openDialog: true })}
              >
                {isPollingAuth ? 'Waiting Callback...' : sessionToken ? 'Sign In Again' : 'Sign In'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void refreshDesktopHealth()}
                disabled={!sessionToken || isCheckingHealth}
              >
                {isCheckingHealth ? 'Checking...' : 'Refresh Health'}
              </button>
              <button type="button" className="secondary-btn" onClick={copyDiagnosticsSnapshot}>
                Copy Diagnostics
              </button>
              {hasSavedSession && (
                <button type="button" className="secondary-btn danger" onClick={() => void resetSessionToken()}>
                  Clear Local Token
                </button>
              )}
            </div>

            <details className="auth-section" open>
              <summary>Diagnostics</summary>
              <div className="auth-diagnostics">
                <dl>
                  <div>
                    <dt>Device</dt>
                    <dd>{deviceId}</dd>
                  </div>
                  <div>
                    <dt>Session</dt>
                    <dd>{sessionToken ? 'Authenticated' : 'Guest'}</dd>
                  </div>
                  <div>
                    <dt>Key sync request</dt>
                    <dd>{lastKeySyncRequestId || 'No key sync request yet'}</dd>
                  </div>
                  <div>
                    <dt>Health request</dt>
                    <dd>{lastHealthRequestId || 'No health request yet'}</dd>
                  </div>
                  <div>
                    <dt>Agent request</dt>
                    <dd>{lastAgentRequestId || 'No agent request yet'}</dd>
                  </div>
                  <div>
                    <dt>Agent engine</dt>
                    <dd>{lastAgentEngine || 'No engine activity yet'}</dd>
                  </div>
                  <div>
                    <dt>Backend health</dt>
                    <dd>{desktopHealth ? desktopHealth.status : 'Not checked'}</dd>
                  </div>
                  <div>
                    <dt>CLI runtime</dt>
                    <dd>
                      {desktopHealth
                        ? desktopHealth.geminiCliReady
                          ? 'Ready'
                          : 'Unavailable'
                        : 'Unknown'}
                    </dd>
                  </div>
                  <div>
                    <dt>Backend key</dt>
                    <dd>
                      {desktopHealth
                        ? desktopHealth.geminiKeyReady
                          ? 'Configured'
                          : 'Missing'
                        : 'Unknown'}
                    </dd>
                  </div>
                  <div>
                    <dt>Backend model</dt>
                    <dd>{desktopHealth?.geminiModel || 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>CLI command source</dt>
                    <dd>{desktopHealth?.cliCommandSource || 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Backend runtime</dt>
                    <dd>
                      {desktopHealth
                        ? `${desktopHealth.runtimePlatform} / ${desktopHealth.runtimeNodeVersion}`
                        : 'Unknown'}
                    </dd>
                  </div>
                </dl>

                {desktopHealth && desktopHealth.guidance.length > 0 && (
                  <ul className="auth-guidance-list">
                    {desktopHealth.guidance.map((entry, index) => (
                      <li key={`${entry}-${index}`}>{entry}</li>
                    ))}
                  </ul>
                )}
              </div>
            </details>

            <details className="auth-section">
              <summary>Model And Advanced Settings</summary>
              <p className="muted">Active provider: gemini-cli (server-side)</p>
              {!!remoteKeySummary && availableModels.length > 0 && (
                <label className="auth-model-row">
                  <span className="muted">Active model</span>
                  <select
                    value={selectedModel || remoteKeySummary.geminiModel}
                    onChange={(event) => setSelectedModel(event.target.value)}
                  >
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {sessionToken && !remoteKeySummary && (
                <p className="muted">
                  Session token exists, but key sync has not completed yet.
                </p>
              )}
              <label className="auth-model-row">
                <span className="muted">Execution mode</span>
                <select
                  value={selectedExecutionMode}
                  onChange={(event) => {
                    const mode = normalizeExecutionMode(event.target.value)
                    if (mode) {
                      setSelectedExecutionMode(mode)
                    }
                  }}
                >
                  {EXECUTION_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">
                Plan mode returns a plan first. Default mode answers directly. Auto Edit and YOLO are available but backend tool execution is still restricted by policy.
              </p>
            </details>

            <details className="auth-section">
              <summary>Login Troubleshooting</summary>
              <div className="auth-link-row">
                <input
                  readOnly
                  value={authUrl || ''}
                  placeholder="Generate login link to copy manually"
                />
                <button type="button" className="secondary-btn" onClick={() => void copyLoginLink()} disabled={!authUrl}>
                  Copy
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => {
                    if (authUrl) {
                      void openExternalUrl(authUrl)
                    }
                  }}
                  disabled={!authUrl}
                >
                  Open
                </button>
              </div>
              <p className="muted">
                If browser opening fails, copy the login URL above and open it manually.
              </p>
            </details>

            {copyStatus && <p className="copy-status">{copyStatus}</p>}
          </div>
        </div>
      )}

      {/* Skill Panel */}
      <SkillPanel
        isOpen={showSkillPanel}
        onClose={() => setShowSkillPanel(false)}
        workspacePath={activeSession?.workspacePath}
      />

      {/* Vector RAG Panel */}
      <VectorPanel
        isOpen={showVectorPanel}
        onClose={() => setShowVectorPanel(false)}
        workspacePath={activeSession?.workspacePath}
        onInsertContext={(text) => {
          if (activeSession) {
            updateSession(activeSession.id, (session) => ({
              ...session,
              draft: session.draft ? `${session.draft}\n\n${text}` : text,
              updatedAt: Date.now(),
            }))
          }
        }}
      />

      {/* Subagent Panel */}
      <SubagentPanel
        isOpen={showSubagentPanel}
        onClose={() => setShowSubagentPanel(false)}
      />

      {/* Terminal Panel */}
      <TerminalPanel
        isOpen={showTerminalPanel}
        onClose={() => setShowTerminalPanel(false)}
        workspacePath={activeSession?.workspacePath}
      />

      {/* Local Agent Settings Dialog */}
      <LocalAgentSettings
        isOpen={showLocalSettings}
        onClose={() => setShowLocalSettings(false)}
        onConfigSaved={handleLocalConfigSaved}
      />
    </div>
  )
}
