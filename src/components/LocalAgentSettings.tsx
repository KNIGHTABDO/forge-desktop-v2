// src/components/LocalAgentSettings.tsx
// Settings panel for configuring local agent (Nous API key, model, etc.)

import { useState, useEffect } from 'react'
import {
  loadProviderConfig,
  saveProviderConfig,
  type LocalProviderConfig,
} from '../lib/agent/useLocalAgent'

interface LocalAgentSettingsProps {
  isOpen: boolean
  onClose: () => void
  onConfigSaved: (config: LocalProviderConfig) => void
}

const KNOWN_PROVIDERS = [
  {
    id: 'nous',
    name: 'Nous Research',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    models: ['xiaomi/mimo-v2-pro', 'nousresearch/hermes-4-70b', 'nousresearch/hermes-4-405b'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4', 'google/gemini-3-flash-preview', 'deepseek/deepseek-r1'],
  },
  {
    id: 'custom',
    name: 'Custom Endpoint',
    baseUrl: '',
    models: [],
  },
]

export function LocalAgentSettings({ isOpen, onClose, onConfigSaved }: LocalAgentSettingsProps) {
  const [config, setConfig] = useState<LocalProviderConfig>(loadProviderConfig())
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testMessage, setTestMessage] = useState('')

  useEffect(() => {
    if (isOpen) {
      setConfig(loadProviderConfig())
      setTestStatus('idle')
      setTestMessage('')
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleProviderChange = (providerId: string) => {
    const provider = KNOWN_PROVIDERS.find((p) => p.id === providerId)
    if (provider) {
      setConfig((prev) => ({
        ...prev,
        provider: providerId,
        baseUrl: provider.baseUrl,
        model: provider.models[0] || prev.model,
      }))
    }
  }

  const handleTestConnection = async () => {
    setTestStatus('testing')
    setTestMessage('')

    try {
      const response = await fetch(`${config.baseUrl}/models`, {
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      })

      if (response.ok) {
        const data = await response.json()
        const modelCount = data.data?.length || 0
        setTestStatus('success')
        setTestMessage(`Connected! ${modelCount} models available.`)
      } else {
        setTestStatus('error')
        setTestMessage(`HTTP ${response.status}: ${response.statusText}`)
      }
    } catch (e) {
      setTestStatus('error')
      setTestMessage(e instanceof Error ? e.message : 'Connection failed')
    }
  }

  const handleSave = () => {
    saveProviderConfig(config)
    onConfigSaved(config)
    onClose()
  }

  const selectedProvider = KNOWN_PROVIDERS.find((p) => p.id === config.provider)

  return (
    <div className="local-agent-overlay" onClick={onClose}>
      <div className="local-agent-settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>⚡ Local Agent Settings</h3>
          <button className="settings-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="settings-body">
          <p className="settings-desc">
            Configure a direct LLM connection for the local agent loop.
            This bypasses the remote Forge API and runs autonomously on your machine.
          </p>

          {/* Provider Selection */}
          <div className="settings-field">
            <label>Provider</label>
            <div className="provider-buttons">
              {KNOWN_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  className={`provider-btn ${config.provider === p.id ? 'active' : ''}`}
                  onClick={() => handleProviderChange(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {/* Base URL */}
          <div className="settings-field">
            <label>API Base URL</label>
            <input
              type="text"
              value={config.baseUrl}
              onChange={(e) => setConfig((prev) => ({ ...prev, baseUrl: e.target.value }))}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
            />
          </div>

          {/* API Key */}
          <div className="settings-field">
            <label>API Key</label>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => setConfig((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder="sk-..."
              spellCheck={false}
            />
            <span className="field-hint">Stored locally in your browser. Never sent to Forge servers.</span>
          </div>

          {/* Model */}
          <div className="settings-field">
            <label>Model</label>
            {selectedProvider && selectedProvider.models.length > 0 ? (
              <select
                value={config.model}
                onChange={(e) => setConfig((prev) => ({ ...prev, model: e.target.value }))}
              >
                {selectedProvider.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={config.model}
                onChange={(e) => setConfig((prev) => ({ ...prev, model: e.target.value }))}
                placeholder="model-name"
                spellCheck={false}
              />
            )}
          </div>

          {/* Test Connection */}
          <div className="settings-field">
            <button
              className="test-btn"
              onClick={handleTestConnection}
              disabled={testStatus === 'testing' || !config.baseUrl}
            >
              {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
            </button>
            {testMessage && (
              <span className={`test-result ${testStatus}`}>
                {testStatus === 'success' ? '✅' : testStatus === 'error' ? '❌' : ''}{' '}
                {testMessage}
              </span>
            )}
          </div>
        </div>

        <div className="settings-footer">
          <button className="settings-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="settings-save"
            onClick={handleSave}
            disabled={!config.baseUrl || !config.model}
          >
            Save & Activate
          </button>
        </div>
      </div>
    </div>
  )
}
