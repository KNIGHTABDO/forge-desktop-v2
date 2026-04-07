// src/lib/agent/planner.ts
// Goal decomposition and task planning for autonomous agent execution

import type { AgentConfig, AgentEvent, AgentEventHandler, AgentPlan, AgentStep, ToolCall } from './types'
import { AgentLoop } from './core'
import { ToolRegistry } from './tools'

function makeId(prefix: string): string {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

// ── Planner ──────────────────────────────────────────────────────────

export interface PlanStep {
  id: string
  description: string
  toolHints: string[] // suggested tools for this step
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'skipped'
  result?: string
  error?: string
}

export interface TaskPlan {
  id: string
  goal: string
  steps: PlanStep[]
  currentStepIndex: number
  status: 'planning' | 'executing' | 'completed' | 'failed'
  createdAt: number
  updatedAt: number
}

export class Planner {
  private config: AgentConfig
  private onEvent: AgentEventHandler

  constructor(config: AgentConfig, onEvent: AgentEventHandler) {
    this.config = config
    this.onEvent = onEvent
  }

  // Decompose a goal into concrete steps using the LLM
  async plan(goal: string, context?: string): Promise<TaskPlan> {
    const plan: TaskPlan = {
      id: makeId('plan'),
      goal,
      steps: [],
      currentStepIndex: 0,
      status: 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const availableTools = ToolRegistry.listTools()
    const toolNames = availableTools.map((t) => t.name).join(', ')

    const planningPrompt = [
      `You are a task planner. Break the following goal into concrete, sequential steps.`,
      `Each step should use one or more of the available tools.`,
      ``,
      `## Goal`,
      goal,
      ``,
      context ? `## Context\n${context}\n` : '',
      `## Available Tools`,
      toolNames,
      ``,
      `## Instructions`,
      `Respond with a numbered list of steps. Each step should:`,
      `1. Describe what needs to be done`,
      `2. Mention which tools to use`,
      `3. Be specific enough to execute without ambiguity`,
      ``,
      `Format each step as:`,
      `STEP: <description> | TOOLS: <tool1>, <tool2>`,
      ``,
      `Example:`,
      `STEP: Read package.json to understand dependencies | TOOLS: read_file`,
      `STEP: Install missing dependencies | TOOLS: run_terminal`,
    ]
      .filter(Boolean)
      .join('\n')

    // Use a single LLM call for planning
    const agent = new AgentLoop(
      { ...this.config, maxSteps: 1, autoApprove: true },
      this.onEvent
    )

    const result = await agent.run(planningPrompt)

    // Parse steps from response
    const steps = this.parseSteps(result.content)
    plan.steps = steps
    plan.status = steps.length > 0 ? 'executing' : 'failed'
    plan.updatedAt = Date.now()

    this.onEvent({
      type: 'plan_created',
      timestamp: Date.now(),
      data: { plan },
    })

    return plan
  }

  // Execute a plan step by step
  async executePlan(plan: TaskPlan): Promise<{ plan: TaskPlan; result: string }> {
    plan.status = 'executing'
    const results: string[] = []

    for (let i = 0; i < plan.steps.length; i++) {
      plan.currentStepIndex = i
      const step = plan.steps[i]
      step.status = 'executing'

      this.onEvent({
        type: 'step_start',
        timestamp: Date.now(),
        data: { stepIndex: i, step: step.description },
      })

      try {
        // Build context from previous step results
        const priorResults = results
          .slice(0, i)
          .map((r, idx) => `Step ${idx + 1} result: ${r}`)
          .join('\n')

        const stepPrompt = [
          `Execute the following step as part of a larger plan.`,
          ``,
          `## Overall Goal`,
          plan.goal,
          ``,
          `## Current Step (${i + 1}/${plan.steps.length})`,
          step.description,
          ``,
          step.toolHints.length > 0
            ? `## Suggested Tools\n${step.toolHints.join(', ')}\n`
            : '',
          priorResults ? `## Previous Results\n${priorResults}\n` : '',
          ``,
          `Execute this step and report the result.`,
        ]
          .filter(Boolean)
          .join('\n')

        const agent = new AgentLoop(
          { ...this.config, maxSteps: 10 },
          this.onEvent
        )

        const stepResult = await agent.run(stepPrompt)

        if (stepResult.error) {
          step.status = 'failed'
          step.error = stepResult.error
        } else {
          step.status = 'completed'
          step.result = stepResult.content
          results.push(stepResult.content)
        }
      } catch (error: unknown) {
        step.status = 'failed'
        step.error = error instanceof Error ? error.message : String(error)
      }

      plan.updatedAt = Date.now()

      this.onEvent({
        type: 'step_complete',
        timestamp: Date.now(),
        data: {
          stepIndex: i,
          status: step.status,
          result: step.result?.slice(0, 200),
        },
      })

      // Stop on failure unless step is optional
      if (step.status === 'failed') {
        plan.status = 'failed'
        break
      }
    }

    if (plan.status !== 'failed') {
      plan.status = 'completed'
    }

    const finalResult = results.join('\n\n')
    return { plan, result: finalResult }
  }

  // Parse LLM response into plan steps
  private parseSteps(content: string): PlanStep[] {
    const steps: PlanStep[] = []
    const lines = content.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()

      // Match "STEP: ... | TOOLS: ..." format
      const stepMatch = trimmed.match(
        /(?:STEP|Step|^\d+[.)])\s*:?\s*(.+?)(?:\s*\|\s*TOOLS?\s*:\s*(.+))?$/i
      )

      if (stepMatch) {
        const description = stepMatch[1].trim()
        const toolHints = stepMatch[2]
          ? stepMatch[2].split(',').map((t) => t.trim()).filter(Boolean)
          : []

        if (description) {
          steps.push({
            id: makeId('step'),
            description,
            toolHints,
            status: 'pending',
          })
        }
        continue
      }

      // Match numbered list "1. Description" or "1) Description"
      const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)/)
      if (numberedMatch) {
        steps.push({
          id: makeId('step'),
          description: numberedMatch[1].trim(),
          toolHints: [],
          status: 'pending',
        })
      }
    }

    return steps
  }
}
