import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { formatBridgeError, type BridgeCaller } from '../bridge'
import { decodeWebUISettings } from '../bridge-decoders'
import type { WebUISettings } from '../types/bridge'

type SettingsPanelProps = {
  bridgeReady: boolean
  callBridge: BridgeCaller
  callBridgeQuiet: BridgeCaller
  log: (message: string) => void
  onClearLocalData: () => void
  persistenceEnabled: boolean
  projectContextReady: boolean
  projectName: string
}

export function SettingsPanel({
  bridgeReady,
  callBridge,
  callBridgeQuiet,
  log,
  onClearLocalData,
  persistenceEnabled,
  projectContextReady,
  projectName,
}: SettingsPanelProps) {
  const [settings, setSettings] = useState<WebUISettings | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<WebUISettings | null>(null)
  const [settingsMessage, setSettingsMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const requestSequenceRef = useRef(0)
  const loadingRef = useRef(false)
  const savingRef = useRef(false)

  const loadSettings = useCallback(async (quiet = false) => {
    if (!bridgeReady || loadingRef.current || savingRef.current) {
      return
    }

    requestSequenceRef.current += 1
    const requestSequence = requestSequenceRef.current
    loadingRef.current = true
    setLoading(true)
    setSettingsMessage('')
    try {
      const raw = quiet
        ? await callBridgeQuiet<unknown>('getwebuisettings')
        : await callBridge<unknown>('getwebuisettings')
      const result = decodeWebUISettings('getwebuisettings', raw)
      if (requestSequenceRef.current === requestSequence) {
        setSettings(result)
        setSettingsDraft(result)
      }
    } catch (error) {
      if (requestSequenceRef.current === requestSequence) {
        const message = formatBridgeError(error)
        setSettingsMessage(message)
        log(message)
      }
    } finally {
      if (requestSequenceRef.current === requestSequence) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }, [bridgeReady, callBridge, callBridgeQuiet, log])

  useEffect(() => {
    if (!bridgeReady) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void loadSettings(true)
    }, 0)
    return () => window.clearTimeout(timeoutId)
  }, [bridgeReady, loadSettings])

  async function saveSettings() {
    if (!settingsDraft || savingRef.current || loadingRef.current) {
      return
    }

    requestSequenceRef.current += 1
    const requestSequence = requestSequenceRef.current
    savingRef.current = true
    setSaving(true)
    setSettingsMessage('')
    try {
      const raw = await callBridge<unknown>('setwebuisettings', JSON.stringify({
        useDevServer: settingsDraft.useDevServer,
        devServerUrl: settingsDraft.devServerUrl,
        startupUrl: settingsDraft.startupUrl,
      }))
      const result = decodeWebUISettings('setwebuisettings', raw)
      if (requestSequenceRef.current === requestSequence) {
        setSettings(result)
        setSettingsDraft(result)
        setSettingsMessage('Settings saved.')
      }
    } catch (error) {
      if (requestSequenceRef.current === requestSequence) {
        setSettingsMessage(formatBridgeError(error))
      }
    } finally {
      if (requestSequenceRef.current === requestSequence) {
        savingRef.current = false
        setSaving(false)
      }
    }
  }

  function updateSettingsDraft<K extends keyof WebUISettings>(key: K, value: WebUISettings[K]) {
    setSettingsDraft((draft) => {
      const current = draft || settings || {
        useDevServer: false,
        devServerUrl: 'http://localhost:5173',
        startupUrl: '',
        resolvedUrl: '',
      }

      return {
        ...current,
        [key]: value,
      }
    })
  }

  function clearLocalData() {
    onClearLocalData()
    setSettingsMessage('Local command history and workspace preferences cleared.')
  }

  const draft = settingsDraft || settings
  const busy = loading || saving

  return (
    <div className="panel">
      <h2>Startup Settings</h2>
      {!draft ? (
        <div className={settingsMessage ? 'inline-error' : undefined}>
          <p className={settingsMessage ? undefined : 'muted'} role={settingsMessage ? 'alert' : 'status'}>
            {settingsMessage || (loading ? 'Reading settings from the bridge…' : 'Settings have not been loaded.')}
          </p>
          <button type="button" onClick={() => void loadSettings()} disabled={!bridgeReady || busy}>
            {loading ? 'Loading…' : 'Retry loading settings'}
          </button>
        </div>
      ) : (
        <div className="settings-editor">
          <label className="schema-field checkbox" htmlFor="use-dev-server">
            <input
              id="use-dev-server"
              type="checkbox"
              checked={draft.useDevServer}
              disabled={busy}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                updateSettingsDraft('useDevServer', event.target.checked)
              }
            />
            <span>Use dev server</span>
          </label>
          <label className="schema-field" htmlFor="dev-server-url">
            <span>Dev server URL</span>
            <input
              id="dev-server-url"
              value={draft.devServerUrl}
              disabled={busy}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                updateSettingsDraft('devServerUrl', event.target.value)
              }
            />
          </label>
          <label className="schema-field" htmlFor="startup-url">
            <span>Startup URL</span>
            <input
              id="startup-url"
              value={draft.startupUrl}
              disabled={busy}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                updateSettingsDraft('startupUrl', event.target.value)
              }
            />
          </label>
          <div className="settings-resolved">
            <span>Resolved URL</span>
            <code>{settings?.resolvedUrl || '-'}</code>
          </div>
          {settingsMessage ? (
            <p className={settingsMessage === 'Settings saved.' ? 'settings-message' : 'settings-message error'} role="status">
              {settingsMessage}
            </p>
          ) : null}
          <div className="command-actions">
            <button type="button" onClick={() => void saveSettings()} disabled={!bridgeReady || busy}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
            <button type="button" onClick={() => void loadSettings()} disabled={!bridgeReady || busy}>
              {loading ? 'Loading…' : 'Reload'}
            </button>
          </div>
        </div>
      )}
      <div className="local-data-actions">
        <span>
          {persistenceEnabled
            ? `Stored only for ${projectName}.`
            : projectContextReady
              ? 'Project context unavailable; persistence is disabled for this session.'
              : 'Resolving project context; persistence is disabled until it is verified.'}
        </span>
        <button type="button" onClick={clearLocalData}>Clear local UI data</button>
      </div>
    </div>
  )
}
