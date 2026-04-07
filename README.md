# Forge Desktop v2

**The autonomous AI coding agent that runs entirely on your machine.**

Forge Desktop is a Tauri-based desktop application that gives an AI agent full access to your local workspace — filesystem, terminal, web search, and code editing — with a beautiful UI built for developers who want more than a chatbot.

![Forge Desktop](https://img.shields.io/badge/version-2.0.0-blue) ![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131) ![React](https://img.shields.io/badge/React-19-61DAFB) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

### 🧠 Local Agent Loop
Run the full agent loop directly on your machine. No data leaves your computer unless you choose a cloud provider. Supports any OpenAI-compatible API:
- **Nous Research** (MiMo-V2-Pro, Hermes 4)
- **OpenRouter** (Claude, Gemini, DeepSeek, 300+ models)
- **Custom endpoints** (Ollama, vLLM, local models)

### 🔧 Tool System
Eight built-in tools the agent can use autonomously:
| Tool | Description |
|------|-------------|
| `read_file` | Read files with line numbers and pagination |
| `write_file` | Create/overwrite files with directory creation |
| `edit_file` | Targeted find-and-replace with uniqueness validation |
| `list_files` | Browse workspace with glob patterns |
| `search_files` | Regex search across all source files |
| `run_terminal` | Sandboxed shell commands with timeout protection |
| `web_search` | Tavily-powered web search |
| `web_extract` | Fetch and parse any URL to markdown |

### 🤖 Subagent System
Complex tasks get decomposed and delegated to parallel subagents:
- Dependency-aware execution order
- Isolated memory per subagent
- Status tracking with real-time updates
- Max 3 concurrent subagents (configurable)

### 🧩 Skill Registry
Create reusable workflows from tool sequences:
- Visual step builder
- Parameter substitution (`{{param}}`)
- Conditional steps and retry logic
- localStorage persistence
- Usage tracking

### 🔍 Vector RAG
Semantic search across your entire workspace:
- Local sparse embeddings (no external API needed)
- Hybrid scoring: cosine similarity + keyword relevance
- Index any source file (.ts, .js, .py, .rs, .md, etc.)
- "Insert as Context" button feeds results to the agent
- Recent query history

### ⌨️ Embedded Terminal
Full sandboxed terminal inside the app:
- Command history (arrow keys)
- Dangerous command blocking
- 60-second timeout protection
- Built-in commands: `clear`, `pwd`, `help`

### 📝 Visual Diff Editor
Review code changes before applying:
- Unified and split diff views
- Line numbers and syntax-aware coloring
- Approve/Reject workflow
- Change statistics (+lines, -lines)

### 🧠 Agent Memory
Token-aware working memory that persists across the conversation:
- Automatic relevance scoring
- Recency decay
- Smart pruning when over budget
- Search by content or tags

## Architecture

```
forge-desktop-v2/
├── src/
│   ├── lib/
│   │   ├── agent/
│   │   │   ├── core.ts         # Agent loop (plan → execute → reflect)
│   │   │   ├── tools.ts        # Tool registry + definitions
│   │   │   ├── executor.ts     # Tool implementations (Tauri bridge)
│   │   │   ├── memory.ts       # Token-aware agent memory
│   │   │   ├── subagents.ts    # Subagent spawning + coordination
│   │   │   ├── planner.ts      # Goal decomposition
│   │   │   ├── browser.ts      # Web search/extract wrappers
│   │   │   ├── types.ts        # Full type system
│   │   │   └── useLocalAgent.ts # React hook for agent loop
│   │   ├── skills.ts           # Skill registry (localStorage)
│   │   └── vector.ts           # Vector search engine
│   ├── components/
│   │   ├── DiffEditor.tsx      # Visual diff viewer
│   │   ├── SkillPanel.tsx      # Skill management UI
│   │   ├── VectorPanel.tsx     # RAG search + index UI
│   │   ├── SubagentPanel.tsx   # Subagent monitoring
│   │   ├── TerminalPanel.tsx   # Embedded terminal
│   │   └── LocalAgentSettings.tsx # Provider config
│   └── App.tsx                 # Main app (chat + sessions)
└── src-tauri/
    └── src/
        ├── lib.rs              # Tauri commands + auth
        └── sandbox.rs          # Sandboxed file ops + terminal
```

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (for Tauri)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Install
```bash
git clone https://github.com/KNIGHTABDO/forge-desktop-v2.git
cd forge-desktop-v2
npm install
```

### Development
```bash
npm run tauri:dev
```

### Build
```bash
npm run tauri:build
```

### Configure Local Agent
1. Click the ⚡ **Local** button in the header
2. Click ⚡ again to open settings
3. Enter your API key (Nous Research, OpenRouter, or custom endpoint)
4. Select a model
5. Click "Test Connection" to verify
6. Click "Save & Activate"

## API Providers

| Provider | Free Tier | Models | Notes |
|----------|-----------|--------|-------|
| **Nous Research** | 2 weeks free | MiMo-V2-Pro, Hermes 4 | 800 RPM, 8M TPM |
| **OpenRouter** | Pay-per-use | 300+ models | Best model selection |
| **Custom** | Self-hosted | Any OpenAI-compatible | Ollama, vLLM, etc. |

## Privacy

Forge Desktop processes everything locally:
- **No telemetry** — zero data sent to Forge servers
- **No account required** — works in guest mode
- **API keys stored locally** — in your browser's localStorage
- **Vector index local** — never uploaded anywhere
- **Terminal sandboxed** — dangerous commands blocked

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite 7
- **Backend:** Rust, Tauri 2
- **Agent:** OpenAI-compatible API (any provider)
- **Search:** Tavily API (optional)
- **Vector:** Custom sparse embeddings (no external deps)

## License

MIT License — see [LICENSE](./LICENSE) for details.

## Credits

Built with 🖤 by the Forge team.
