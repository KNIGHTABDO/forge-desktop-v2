// src/lib/skills.ts
// Skill registry — persistent, hot-loadable agent workflows

export interface SkillParameter {
  name: string
  type: 'string' | 'number' | 'boolean'
  description: string
  required: boolean
  default?: unknown
}

export interface Skill {
  id: string
  name: string
  description: string
  category: string
  version: string
  steps: SkillStep[]
  parameters: SkillParameter[]
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  usageCount: number
  tags: string[]
}

export interface SkillStep {
  id: string
  description: string
  toolName: string
  parameters: Record<string, unknown>
  condition?: string // optional condition expression
  onError?: 'continue' | 'retry' | 'abort'
  maxRetries?: number
}

export interface SkillExecutionResult {
  skillId: string
  success: boolean
  stepsCompleted: number
  totalSteps: number
  output: string
  error?: string
  durationMs: number
}

// ── Storage Keys ─────────────────────────────────────────────────────

const SKILLS_STORAGE_KEY = 'forge-desktop-skills-v1'

// ── Skill Registry ───────────────────────────────────────────────────

class SkillRegistryClass {
  private skills: Map<string, Skill> = new Map()
  private loaded = false

  // Load skills from localStorage
  loadSkills(): Skill[] {
    if (!this.loaded) {
      this.loadFromStorage()
      this.loaded = true
    }
    return Array.from(this.skills.values())
  }

  getSkill(id: string): Skill | undefined {
    this.loadSkills()
    return this.skills.get(id)
  }

  getSkillsByCategory(category: string): Skill[] {
    return this.loadSkills().filter((s) => s.category === category)
  }

  getSkillsByTag(tag: string): Skill[] {
    return this.loadSkills().filter((s) => s.tags.includes(tag))
  }

  searchSkills(query: string): Skill[] {
    const queryLower = query.toLowerCase()
    return this.loadSkills().filter((s) => {
      return (
        s.name.toLowerCase().includes(queryLower) ||
        s.description.toLowerCase().includes(queryLower) ||
        s.tags.some((t) => t.toLowerCase().includes(queryLower))
      )
    })
  }

  saveSkill(skill: Omit<Skill, 'id' | 'createdAt' | 'updatedAt' | 'usageCount'>): Skill {
    this.loadSkills()
    const now = Date.now()

    const existing = this.skills.get(skill.name)
    const id = existing?.id || `skill-${skill.name.toLowerCase().replace(/\s+/g, '-')}`
    const usageCount = existing?.usageCount || 0
    const createdAt = existing?.createdAt || now

    const fullSkill: Skill = {
      ...skill,
      id,
      createdAt,
      updatedAt: now,
      usageCount,
    }

    this.skills.set(id, fullSkill)
    this.saveToStorage()
    return fullSkill
  }

  deleteSkill(id: string): boolean {
    this.loadSkills()
    const deleted = this.skills.delete(id)
    if (deleted) {
      this.saveToStorage()
    }
    return deleted
  }

  async executeSkill(
    skillId: string,
    params: Record<string, unknown>,
    toolExecutor: (toolName: string, params: Record<string, unknown>) => Promise<{ output: string; error?: string }>
  ): Promise<SkillExecutionResult> {
    const skill = this.getSkill(skillId)
    if (!skill) {
      return {
        skillId,
        success: false,
        stepsCompleted: 0,
        totalSteps: 0,
        output: '',
        error: `Skill not found: ${skillId}`,
        durationMs: 0,
      }
    }

    const start = Date.now()
    let stepsCompleted = 0
    const outputs: string[] = []

    // Validate required parameters
    const missingParams = skill.parameters
      .filter((p) => p.required && !(p.name in params))
      .map((p) => p.name)

    if (missingParams.length > 0) {
      return {
        skillId,
        success: false,
        stepsCompleted: 0,
        totalSteps: skill.steps.length,
        output: '',
        error: `Missing required parameters: ${missingParams.join(', ')}`,
        durationMs: Date.now() - start,
      }
    }

    // Merge defaults
    const mergedParams = { ...params }
    for (const param of skill.parameters) {
      if (!(param.name in mergedParams) && param.default !== undefined) {
        mergedParams[param.name] = param.default
      }
    }

    // Execute steps
    for (let i = 0; i < skill.steps.length; i++) {
      const step = skill.steps[i]

      // Resolve parameter substitutions in step parameters
      const resolvedParams = this.resolveParams(step.parameters, mergedParams)

      // Check condition
      if (step.condition) {
        try {
          const conditionResult = this.evaluateCondition(step.condition, mergedParams, outputs)
          if (!conditionResult) {
            outputs.push(`[Step ${i + 1}] Skipped (condition not met)`)
            stepsCompleted++
            continue
          }
        } catch {
          // If condition evaluation fails, proceed anyway
        }
      }

      const maxRetries = step.maxRetries ?? (step.onError === 'retry' ? 3 : 0)
      let attempts = 0
      let stepSuccess = false

      while (attempts <= maxRetries && !stepSuccess) {
        attempts++
        try {
          const result = await toolExecutor(step.toolName, resolvedParams)
          if (result.error) {
            throw new Error(result.error)
          }
          outputs.push(`[Step ${i + 1}] ${step.description}\n${result.output.slice(0, 2000)}`)
          stepSuccess = true
          stepsCompleted++
        } catch (error: unknown) {
          const errorMsg = error instanceof Error ? error.message : String(error)

          if (attempts > maxRetries) {
            if (step.onError === 'continue') {
              outputs.push(`[Step ${i + 1}] Failed (continuing): ${errorMsg}`)
              stepsCompleted++
              break
            } else {
              // Update usage count
              skill.usageCount++
              this.saveToStorage()

              return {
                skillId,
                success: false,
                stepsCompleted,
                totalSteps: skill.steps.length,
                output: outputs.join('\n\n'),
                error: `Step ${i + 1} failed after ${attempts} attempts: ${errorMsg}`,
                durationMs: Date.now() - start,
              }
            }
          }

          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempts))
        }
      }
    }

    // Update usage count
    skill.usageCount++
    this.saveToStorage()

    return {
      skillId,
      success: true,
      stepsCompleted,
      totalSteps: skill.steps.length,
      output: outputs.join('\n\n'),
      durationMs: Date.now() - start,
    }
  }

  // Resolve {{paramName}} substitutions in step parameters
  private resolveParams(
    stepParams: Record<string, unknown>,
    context: Record<string, unknown>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(stepParams)) {
      if (typeof value === 'string') {
        resolved[key] = value.replace(/\{\{(\w+)\}\}/g, (_, name) => {
          return String(context[name] ?? `{{${name}}}`)
        })
      } else {
        resolved[key] = value
      }
    }

    return resolved
  }

  // Simple condition evaluator
  private evaluateCondition(
    condition: string,
    params: Record<string, unknown>,
    outputs: string[]
  ): boolean {
    // Support simple expressions like "paramName" (truthy check) or "paramName == value"
    const eqMatch = condition.match(/^(\w+)\s*==\s*(.+)$/)
    if (eqMatch) {
      const [, name, expected] = eqMatch
      const actual = String(params[name] ?? '')
      return actual === expected.replace(/^["']|["']$/g, '')
    }

    // Truthy check
    const trimmed = condition.trim()
    return Boolean(params[trimmed])
  }

  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(SKILLS_STORAGE_KEY)
      if (!raw) return

      const parsed = JSON.parse(raw) as Skill[]
      for (const skill of parsed) {
        this.skills.set(skill.id, skill)
      }
    } catch {
      console.warn('[Skills] Failed to load from storage')
    }
  }

  private saveToStorage(): void {
    try {
      const all = Array.from(this.skills.values())
      localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(all))
    } catch {
      console.warn('[Skills] Failed to save to storage')
    }
  }

  getStats(): { total: number; totalUsage: number; byCategory: Record<string, number> } {
    const all = this.loadSkills()
    const byCategory: Record<string, number> = {}
    let totalUsage = 0

    for (const skill of all) {
      byCategory[skill.category] = (byCategory[skill.category] || 0) + 1
      totalUsage += skill.usageCount
    }

    return { total: all.length, totalUsage, byCategory }
  }
}

export const SkillRegistry = new SkillRegistryClass()
