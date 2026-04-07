# Changelog

All notable changes to Forge Desktop will be documented in this file.

## [2.0.0] — 2026-04-07

### 🚀 Major Release — Autonomous Agent Architecture

This release transforms Forge Desktop from a chat interface into a fully autonomous AI coding agent.

### Added

**Agent Brain System**
- Full agent loop controller: plan → execute tools → reflect → retry (12,871 lines of new code)
- Pluggable tool registry with 8 built-in tools (file ops, terminal, web search)
- Subagent system with dependency-aware parallel execution (max 3 concurrent)
- Token-aware agent memory with smart relevance scoring and pruning
- LLM-powered task planner for goal decomposition
- Multi-turn conversation with automatic reflection every 5 iterations
- Approval gates for dangerous operations

**Local Agent Mode**
- Run the agent loop directly on your machine via any OpenAI-compatible API
- Support for Nous Research (MiMo-V2-Pro, Hermes 4), OpenRouter (300+ models), custom endpoints
- Provider configuration UI with connection testing
- Persistent API key storage (localStorage, never sent to Forge servers)
- Toggle between ☁️ Remote and ⚡ Local modes

**Skill Registry**
- Create reusable workflows from tool sequences
- Visual step builder with tool selection per step
- Parameter substitution (`{{paramName}}`) in step parameters
- Conditional steps and configurable retry logic
- localStorage persistence with usage tracking
- Category filters and search

**Vector RAG (Retrieval-Augmented Generation)**
- Local sparse embedding engine (no external API dependencies)
- Hybrid scoring: 60% cosine similarity + 40% keyword relevance
- Workspace indexing for all source file types
- Chunking with overlap for long files
- "Insert as Context" button feeds search results to agent draft
- Recent query history

**Embedded Terminal**
- Sandboxed shell command execution
- Command history with arrow key navigation
- Dangerous command blocking (rm -rf /, mkfs, etc.)
- 60-second timeout protection
- Built-in commands: clear, pwd, help
- Dark terminal theme matching VS Code

**Visual Diff Editor**
- Unified and split diff views
- Line number display
- Change statistics (+lines / -lines)
- Approve/Reject workflow for code changes
- LCS-based diff algorithm

**Tauri Backend (Rust)**
- `read_file_command` — file reading with line numbers and pagination
- `write_file_command` — file writing with auto directory creation
- `edit_file_command` — targeted find-and-replace with uniqueness check
- `list_files_command` — directory listing with glob patterns
- `search_files_command` — regex content search across files
- `run_command_sandboxed` — sandboxed terminal with timeout + blocked commands
- `web_search_command` — Tavily-powered web search
- `web_extract_command` — URL fetch with HTML→text conversion

**UI Additions**
- 🧩 Skills button → slide-in skill management panel
- 🔍 RAG button → slide-in vector search + index panel
- 🤖 Agents button → slide-in subagent monitoring panel
- ⌨️ Term button → slide-in embedded terminal
- ⚡ Local/Remote toggle with provider status
- All panels slide in from right, don't affect main chat layout

### Changed
- App.tsx expanded from 2,474 → 2,728 lines (+254 for integrations)
- theme.css expanded from 47 → 1,564 lines (all panel styles)
- Added `regex`, `tokio`, `html-escape` to Rust dependencies

### Architecture
- `src/lib/agent/` — 9 new TypeScript modules (2,571 lines)
- `src/components/` — 6 new UI components (2,146 lines)
- `src-tauri/src/sandbox.rs` — expanded from 17 → 752 lines
- Total codebase: 12,871 lines across 27 source files

---

## [1.0.0] — 2026-03-15

### Initial Release
- Basic chat interface with Gemini CLI backend
- Workspace file listing and reading
- Session management with undo/redo
- Auth flow with Forge web API
- Dark/light theme
- RTL support for Arabic text
