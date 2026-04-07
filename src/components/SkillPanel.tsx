// src/components/SkillPanel.tsx
// Panel for browsing, creating, and executing skills

import { useState, useEffect, useCallback } from 'react'
import { SkillRegistry } from '../lib/skills'
import type { Skill, SkillStep } from '../lib/skills'

interface SkillPanelProps {
  isOpen: boolean
  onClose: () => void
  onExecute?: (skillId: string, params: Record<string, unknown>) => void
  workspacePath?: string
}

type PanelView = 'list' | 'create' | 'edit' | 'execute'

export function SkillPanel({ isOpen, onClose, onExecute, workspacePath }: SkillPanelProps) {
  const [view, setView] = useState<PanelView>('list')
  const [skills, setSkills] = useState<Skill[]>([])
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterCategory, setFilterCategory] = useState<string>('all')

  // Create form state
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newCategory, setNewCategory] = useState('coding')
  const [newTags, setNewTags] = useState('')
  const [newSteps, setNewSteps] = useState<Array<{ description: string; toolName: string; params: string }>>([
    { description: '', toolName: 'read_file', params: '{}' },
  ])

  // Execute form state
  const [execParams, setExecParams] = useState<Record<string, string>>({})
  const [execResult, setExecResult] = useState<string | null>(null)
  const [execRunning, setExecRunning] = useState(false)

  const refreshSkills = useCallback(() => {
    const all = SkillRegistry.loadSkills()
    setSkills(all)
  }, [])

  useEffect(() => {
    if (isOpen) refreshSkills()
  }, [isOpen, refreshSkills])

  if (!isOpen) return null

  const categories = ['all', ...new Set(skills.map((s) => s.category))]

  const filteredSkills = skills.filter((s) => {
    if (filterCategory !== 'all' && s.category !== filterCategory) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.includes(q))
      )
    }
    return true
  })

  const handleCreate = () => {
    if (!newName.trim()) return

    const steps: SkillStep[] = newSteps
      .filter((s) => s.description.trim())
      .map((s, i) => ({
        id: `step-${i}`,
        description: s.description,
        toolName: s.toolName,
        parameters: JSON.parse(s.params || '{}'),
        onError: 'abort' as const,
      }))

    SkillRegistry.saveSkill({
      name: newName,
      description: newDescription,
      category: newCategory,
      version: '1.0.0',
      steps,
      parameters: [],
      metadata: {},
      tags: newTags.split(',').map((t) => t.trim()).filter(Boolean),
    })

    setNewName('')
    setNewDescription('')
    setNewTags('')
    setNewSteps([{ description: '', toolName: 'read_file', params: '{}' }])
    setView('list')
    refreshSkills()
  }

  const handleDelete = (id: string) => {
    SkillRegistry.deleteSkill(id)
    if (selectedSkill?.id === id) setSelectedSkill(null)
    refreshSkills()
  }

  const handleExecute = (skill: Skill) => {
    setSelectedSkill(skill)
    const params: Record<string, string> = {}
    for (const p of skill.parameters) {
      params[p.name] = String(p.default || '')
    }
    setExecParams(params)
    setExecResult(null)
    setView('execute')
  }

  const runExecution = async () => {
    if (!selectedSkill) return
    setExecRunning(true)
    setExecResult(null)

    try {
      // Execute via callback to parent or just show the skill would run
      onExecute?.(selectedSkill.id, execParams)
      setExecResult(`Skill "${selectedSkill.name}" submitted for execution.`)
    } catch (e) {
      setExecResult(`Error: ${String(e)}`)
    } finally {
      setExecRunning(false)
    }
  }

  const addStep = () => {
    setNewSteps([...newSteps, { description: '', toolName: 'read_file', params: '{}' }])
  }

  const removeStep = (idx: number) => {
    setNewSteps(newSteps.filter((_, i) => i !== idx))
  }

  return (
    <div className="skill-panel-overlay" onClick={onClose}>
      <div className="skill-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="skill-panel-header">
          <div className="skill-panel-title">
            <h3>🧩 Skills</h3>
            <span className="skill-count">{skills.length} skills</span>
          </div>
          <div className="skill-panel-actions">
            <button
              className="skill-btn-small"
              onClick={() => setView('create')}
              title="Create new skill"
            >
              + New
            </button>
            <button className="skill-btn-close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        {/* List View */}
        {view === 'list' && (
          <>
            <div className="skill-filters">
              <input
                type="text"
                placeholder="Search skills..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="skill-search"
              />
              <div className="skill-categories">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    className={`skill-cat-btn ${filterCategory === cat ? 'active' : ''}`}
                    onClick={() => setFilterCategory(cat)}
                  >
                    {cat === 'all' ? 'All' : cat}
                  </button>
                ))}
              </div>
            </div>

            <div className="skill-list">
              {filteredSkills.length === 0 ? (
                <div className="skill-empty">
                  <p>No skills yet. Create one to automate repetitive tasks.</p>
                  <button className="skill-btn-primary" onClick={() => setView('create')}>
                    Create First Skill
                  </button>
                </div>
              ) : (
                filteredSkills.map((skill) => (
                  <div
                    key={skill.id}
                    className={`skill-card ${selectedSkill?.id === skill.id ? 'selected' : ''}`}
                    onClick={() => setSelectedSkill(skill)}
                  >
                    <div className="skill-card-header">
                      <span className="skill-name">{skill.name}</span>
                      <span className="skill-badge">{skill.category}</span>
                    </div>
                    <p className="skill-desc">{skill.description}</p>
                    <div className="skill-meta">
                      <span>{skill.steps.length} steps</span>
                      <span>Used {skill.usageCount}×</span>
                      {skill.tags.length > 0 && (
                        <div className="skill-tags">
                          {skill.tags.slice(0, 3).map((t) => (
                            <span key={t} className="skill-tag">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="skill-card-actions">
                      <button
                        className="skill-btn-small primary"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleExecute(skill)
                        }}
                      >
                        ▶ Run
                      </button>
                      <button
                        className="skill-btn-small danger"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(skill.id)
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* Create View */}
        {view === 'create' && (
          <div className="skill-create">
            <h4>Create New Skill</h4>

            <div className="skill-field">
              <label>Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Fix Lint Errors"
              />
            </div>

            <div className="skill-field">
              <label>Description</label>
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="What does this skill do?"
                rows={2}
              />
            </div>

            <div className="skill-field-row">
              <div className="skill-field">
                <label>Category</label>
                <select value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
                  <option value="coding">Coding</option>
                  <option value="testing">Testing</option>
                  <option value="devops">DevOps</option>
                  <option value="research">Research</option>
                  <option value="utility">Utility</option>
                </select>
              </div>
              <div className="skill-field">
                <label>Tags (comma-separated)</label>
                <input
                  type="text"
                  value={newTags}
                  onChange={(e) => setNewTags(e.target.value)}
                  placeholder="lint, fix, auto"
                />
              </div>
            </div>

            <div className="skill-field">
              <label>Steps</label>
              <div className="skill-steps-builder">
                {newSteps.map((step, idx) => (
                  <div key={idx} className="skill-step-row">
                    <span className="step-num">{idx + 1}</span>
                    <input
                      type="text"
                      placeholder="Step description"
                      value={step.description}
                      onChange={(e) => {
                        const updated = [...newSteps]
                        updated[idx] = { ...updated[idx], description: e.target.value }
                        setNewSteps(updated)
                      }}
                    />
                    <select
                      value={step.toolName}
                      onChange={(e) => {
                        const updated = [...newSteps]
                        updated[idx] = { ...updated[idx], toolName: e.target.value }
                        setNewSteps(updated)
                      }}
                    >
                      <option value="read_file">read_file</option>
                      <option value="write_file">write_file</option>
                      <option value="edit_file">edit_file</option>
                      <option value="list_files">list_files</option>
                      <option value="search_files">search_files</option>
                      <option value="run_terminal">run_terminal</option>
                      <option value="web_search">web_search</option>
                      <option value="web_extract">web_extract</option>
                    </select>
                    <button
                      className="skill-btn-small danger"
                      onClick={() => removeStep(idx)}
                      disabled={newSteps.length <= 1}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button className="skill-btn-small" onClick={addStep}>
                  + Add Step
                </button>
              </div>
            </div>

            <div className="skill-form-actions">
              <button className="skill-btn-secondary" onClick={() => setView('list')}>
                Cancel
              </button>
              <button
                className="skill-btn-primary"
                onClick={handleCreate}
                disabled={!newName.trim() || !newSteps.some((s) => s.description.trim())}
              >
                Create Skill
              </button>
            </div>
          </div>
        )}

        {/* Execute View */}
        {view === 'execute' && selectedSkill && (
          <div className="skill-execute">
            <h4>Run: {selectedSkill.name}</h4>
            <p className="skill-desc">{selectedSkill.description}</p>

            {selectedSkill.parameters.length > 0 && (
              <div className="skill-params">
                <h5>Parameters</h5>
                {selectedSkill.parameters.map((param) => (
                  <div key={param.name} className="skill-field">
                    <label>
                      {param.name}
                      {param.required && <span className="required">*</span>}
                    </label>
                    <input
                      type={param.type === 'number' ? 'number' : 'text'}
                      value={execParams[param.name] || ''}
                      onChange={(e) =>
                        setExecParams((prev) => ({ ...prev, [param.name]: e.target.value }))
                      }
                      placeholder={param.description}
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="skill-steps-preview">
              <h5>Steps ({selectedSkill.steps.length})</h5>
              {selectedSkill.steps.map((step, i) => (
                <div key={step.id} className="step-preview">
                  <span className="step-num">{i + 1}</span>
                  <span>{step.description}</span>
                  <span className="step-tool">{step.toolName}</span>
                </div>
              ))}
            </div>

            {execResult && (
              <div className={`skill-result ${execResult.startsWith('Error') ? 'error' : 'success'}`}>
                {execResult}
              </div>
            )}

            <div className="skill-form-actions">
              <button className="skill-btn-secondary" onClick={() => setView('list')}>
                Back
              </button>
              <button
                className="skill-btn-primary"
                onClick={runExecution}
                disabled={execRunning}
              >
                {execRunning ? 'Running...' : '▶ Execute'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
