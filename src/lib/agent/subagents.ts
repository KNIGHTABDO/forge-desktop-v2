// src/lib/agent/subagents.ts
// Subagent spawning, coordination, and result aggregation

import type {
  SubagentInstance,
  SubagentTask,
  SubagentStatus,
  AgentConfig,
  AgentEvent,
  AgentEventHandler,
  AgentTurn,
} from './types'
import { AgentLoop } from './core'

function makeId(prefix: string): string {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

// ── Subagent Manager ─────────────────────────────────────────────────

export interface SubagentConfig {
  maxConcurrent: number
  defaultMaxSteps: number
  isolationLevel: 'shared_memory' | 'isolated' // shared = can see parent memory
  resultMergeStrategy: 'concat' | 'summarize' | 'structured'
}

export class SubagentManager {
  private subagents: Map<string, SubagentInstance> = new Map()
  private runningLoops: Map<string, AgentLoop> = new Map()
  private config: SubagentConfig
  private parentConfig: AgentConfig
  private onEvent: AgentEventHandler
  private completionCallbacks: Map<string, (result: string, error?: string) => void> = new Map()

  constructor(
    parentConfig: AgentConfig,
    onEvent: AgentEventHandler,
    config?: Partial<SubagentConfig>
  ) {
    this.parentConfig = parentConfig
    this.onEvent = onEvent
    this.config = {
      maxConcurrent: 3,
      defaultMaxSteps: 15,
      isolationLevel: 'isolated',
      resultMergeStrategy: 'summarize',
      ...config,
    }
  }

  // Spawn a new subagent for a specific task
  spawn(task: SubagentTask): SubagentInstance {
    const runningCount = Array.from(this.subagents.values()).filter(
      (s) => s.status === 'running'
    ).length

    if (runningCount >= this.config.maxConcurrent) {
      throw new Error(
        `Max concurrent subagents (${this.config.maxConcurrent}) reached. Wait for one to complete.`
      )
    }

    const instance: SubagentInstance = {
      id: makeId('sub'),
      task,
      status: 'pending',
      turns: [],
      stepsCompleted: 0,
    }

    this.subagents.set(instance.id, instance)

    this.onEvent({
      type: 'subagent_spawned',
      timestamp: Date.now(),
      data: { subagentId: instance.id, goal: task.goal },
    })

    return instance
  }

  // Run a subagent asynchronously
  async runSubagent(
    subagentId: string,
    systemPrompt?: string
  ): Promise<{ result: string; error?: string }> {
    const instance = this.subagents.get(subagentId)
    if (!instance) throw new Error(`Subagent not found: ${subagentId}`)

    // Check dependencies
    for (const depId of instance.task.dependencies) {
      const dep = this.subagents.get(depId)
      if (!dep) {
        return { result: '', error: `Dependency not found: ${depId}` }
      }
      if (dep.status === 'pending' || dep.status === 'running') {
        return { result: '', error: `Dependency not complete: ${depId}` }
      }
      if (dep.status === 'failed') {
        return { result: '', error: `Dependency failed: ${depId}` }
      }
    }

    instance.status = 'running'
    instance.startedAt = Date.now()

    const subagentConfig: AgentConfig = {
      ...this.parentConfig,
      maxSteps: this.config.defaultMaxSteps,
      autoApprove: false, // subagents always require approval for dangerous ops
    }

    const turns: AgentTurn[] = []
    let finalResult = ''
    let finalError: string | undefined

    // Build subagent system prompt
    const fullSystemPrompt = systemPrompt || this.buildSubagentPrompt(instance.task)

    try {
      const loop = new AgentLoop(subagentConfig, (event: AgentEvent) => {
        // Forward events with subagent context
        this.onEvent({
          ...event,
          data: { ...event.data, subagentId, subagentGoal: instance.task.goal },
        })

        // Track turns
        if (event.type === 'message' && event.data.turn) {
          turns.push(event.data.turn as AgentTurn)
        }
      })

      this.runningLoops.set(subagentId, loop)

      const result = await loop.run(instance.task.goal, fullSystemPrompt)

      finalResult = result.content
      instance.stepsCompleted = result.stepsExecuted

      if (result.error) {
        finalError = result.error
        instance.status = 'failed'
        instance.error = finalError
      } else {
        instance.status = 'done'
        instance.result = finalResult
      }
    } catch (error: unknown) {
      finalError = error instanceof Error ? error.message : String(error)
      instance.status = 'failed'
      instance.error = finalError
    } finally {
      instance.turns = turns
      instance.finishedAt = Date.now()
      this.runningLoops.delete(subagentId)
    }

    this.onEvent({
      type: 'subagent_complete',
      timestamp: Date.now(),
      data: {
        subagentId,
        goal: instance.task.goal,
        status: instance.status,
        result: finalResult.slice(0, 500),
        error: finalError,
        durationMs: instance.finishedAt - (instance.startedAt ?? Date.now()),
      },
    })

    // Notify completion callback
    const callback = this.completionCallbacks.get(subagentId)
    if (callback) {
      callback(finalResult, finalError)
      this.completionCallbacks.delete(subagentId)
    }

    return { result: finalResult, error: finalError }
  }

  // Run multiple subagents, respecting dependencies
  async runParallel(
    tasks: SubagentTask[],
    systemPrompt?: string
  ): Promise<Map<string, { result: string; error?: string }>> {
    const results = new Map<string, { result: string; error?: string }>()

    // Spawn all
    const instances = tasks.map((task) => this.spawn(task))

    // Build dependency graph
    const ready = new Set<string>()
    const blocked = new Map<string, Set<string>>() // taskId -> remaining deps

    for (const instance of instances) {
      const unsatisfiedDeps = new Set(
        instance.task.dependencies.filter((depId) =>
          tasks.some((t) => t.id === depId)
        )
      )
      if (unsatisfiedDeps.size === 0) {
        ready.add(instance.id)
      } else {
        blocked.set(instance.id, unsatisfiedDeps)
      }
    }

    // Execute in waves
    while (ready.size > 0) {
      const batch = Array.from(ready)
      ready.clear()

      const batchResults = await Promise.allSettled(
        batch.map((id) =>
          this.runSubagent(id, systemPrompt).then((r) => ({ id, ...r }))
        )
      )

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.set(result.value.id, {
            result: result.value.result,
            error: result.value.error,
          })
        }
      }

      // Unblock dependents
      for (const [blockedId, deps] of blocked) {
        for (const completedId of batch) {
          deps.delete(completedId)
        }
        if (deps.size === 0) {
          ready.add(blockedId)
          blocked.delete(blockedId)
        }
      }
    }

    return results
  }

  // Cancel a running subagent
  cancel(subagentId: string): boolean {
    const loop = this.runningLoops.get(subagentId)
    if (loop) {
      loop.cancel()
      const instance = this.subagents.get(subagentId)
      if (instance) {
        instance.status = 'cancelled'
        instance.finishedAt = Date.now()
      }
      return true
    }
    return false
  }

  // Cancel all running subagents
  cancelAll(): void {
    for (const [id] of this.runningLoops) {
      this.cancel(id)
    }
  }

  // Get a specific subagent
  get(subagentId: string): SubagentInstance | undefined {
    return this.subagents.get(subagentId)
  }

  // List all subagents
  list(filter?: { status?: SubagentStatus }): SubagentInstance[] {
    let results = Array.from(this.subagents.values())
    if (filter?.status) {
      results = results.filter((s) => s.status === filter.status)
    }
    return results
  }

  // Aggregate results from completed subagents
  aggregateResults(subagentIds: string[]): string {
    const parts: string[] = []
    for (const id of subagentIds) {
      const instance = this.subagents.get(id)
      if (!instance) continue

      const status = instance.status
      const goal = instance.task.goal

      if (status === 'done' && instance.result) {
        parts.push(`### Task: ${goal}\nStatus: ✅ Completed\n\n${instance.result}`)
      } else if (status === 'failed') {
        parts.push(`### Task: ${goal}\nStatus: ❌ Failed\nError: ${instance.error || 'Unknown'}`)
      } else {
        parts.push(`### Task: ${goal}\nStatus: ${status}`)
      }
    }
    return parts.join('\n\n---\n\n')
  }

  // Build system prompt for subagent
  private buildSubagentPrompt(task: SubagentTask): string {
    return [
      `You are a subagent working on a specific task within a larger Forge Desktop workflow.`,
      ``,
      `## Your Task`,
      task.goal,
      ``,
      task.context ? `## Context\n${task.context}\n` : '',
      `## Guidelines`,
      `- Focus ONLY on your assigned task. Do not explore beyond its scope.`,
      `- Be thorough but efficient. Complete the task in as few steps as possible.`,
      `- If you encounter an error you cannot resolve, report it clearly rather than retrying endlessly.`,
      `- When complete, provide a clear summary of what was accomplished.`,
      `- Use tools to interact with the workspace. Read files before modifying them.`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  // Stats
  getStats(): {
    total: number
    pending: number
    running: number
    done: number
    failed: number
    cancelled: number
  } {
    const all = Array.from(this.subagents.values())
    return {
      total: all.length,
      pending: all.filter((s) => s.status === 'pending').length,
      running: all.filter((s) => s.status === 'running').length,
      done: all.filter((s) => s.status === 'done').length,
      failed: all.filter((s) => s.status === 'failed').length,
      cancelled: all.filter((s) => s.status === 'cancelled').length,
    }
  }

  // Cleanup completed subagents
  cleanup(keepRecent: number = 20): void {
    const sorted = Array.from(this.subagents.values())
      .filter((s) => s.status === 'done' || s.status === 'failed' || s.status === 'cancelled')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))

    const toRemove = sorted.slice(keepRecent)
    for (const instance of toRemove) {
      this.subagents.delete(instance.id)
    }
  }
}
