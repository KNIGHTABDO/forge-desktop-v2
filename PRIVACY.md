# Privacy Policy — Forge Desktop

**Last updated: April 7, 2026**

## Overview

Forge Desktop is designed with privacy as a core principle. This policy explains what data is collected, how it's used, and your rights.

## What We Collect

### Data Processed Locally (On Your Machine)
- **Chat messages and sessions** — stored in your browser's localStorage
- **API keys** — stored in your browser's localStorage, never transmitted to Forge servers
- **Vector search index** — built and stored locally, never uploaded
- **Skill definitions** — stored in your browser's localStorage
- **Workspace file contents** — read and processed locally by the agent

### Data Sent to Third-Party APIs (Your Choice)
When you configure a provider (Nous Research, OpenRouter, etc.):
- Your prompts and conversation history are sent to the LLM API you selected
- File contents may be included in prompts when the agent reads files
- Each provider has their own privacy policy — review them before use

### Data Sent to Forge Servers
- **Authentication tokens** — when you sign in to sync with Forge web
- **Health check pings** — to verify your desktop connection
- **Telemetry** — anonymous usage counters (commands executed, files edited)

## What We Don't Collect
- ❌ Your code or file contents
- ❌ Your API keys (stored locally only)
- ❌ Your conversation content
- ❌ Your workspace file paths
- ❌ Your search queries

## Data Storage

| Data | Storage Location | Retention |
|------|-----------------|-----------|
| Chat sessions | Browser localStorage | Until you clear it |
| API keys | Browser localStorage | Until you clear it |
| Vector index | Browser localStorage | Until you clear it |
| Skills | Browser localStorage | Until you clear it |
| Auth token | OS app data dir | Until you sign out |

## Third-Party Services

| Service | Purpose | Data Shared |
|---------|---------|-------------|
| LLM Provider (your choice) | AI inference | Prompts, context |
| Tavily (optional) | Web search | Search queries |
| Forge Web API | Auth, health | Auth tokens, status |

## Your Rights
- **Clear data** — Clear localStorage at any time via browser or app settings
- **Sign out** — Remove auth token from OS storage
- **No lock-in** — All data is standard JSON, easily exported
- **Local-first** — Everything works offline except LLM calls

## Changes
This policy may be updated. Check the [CHANGELOG](./CHANGELOG.md) for updates.

## Contact
Open an issue on [GitHub](https://github.com/KNIGHTABDO/forge-desktop-v2) for privacy concerns.
