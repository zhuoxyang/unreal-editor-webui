import { useEffect, useState, type ChangeEvent } from 'react'
import type { BridgeCaller } from '../bridge'
import type { WebUISettings } from '../types/bridge'

type SettingsPanelProps = {
  bridgeReady: boolean
  callBridge: BridgeCaller
  callBridgeQuiet: BridgeCaller
  log: (message: string) => void
}

export function SettingsPanel({ bridgeReady, callBridge, callBridgeQuiet, log }: SettingsPanelProps) {
  const [settings, setSettings] = useState<WebUISettings | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<WebUISettings | null>(null)
  const [settingsMessage, setSettingsMessage] = useState('')

  async function loadSettings() {
    try {
      const result = await callBridge<WebUISettings>('getwebuisettings')
      setSettings(result)
      setSettingsDraft(result)
      setSettingsMessage('')
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    if (!bridgeReady) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void callBridgeQuiet<WebUISettings>('getwebuisettings')
        .then((result) => {
          setSettings(result)
          setSettingsDraft(result)
          setSettingsMessage('')
        })
        .catch((error) => log(error instanceof Error ? error.message : String(error)))
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [bridgeReady, callBridgeQuiet, log])

  async function saveSettings() {
    if (!settingsDraft) {
      return
    }

    try {
      const result = await callBridge<WebUISettings>('setwebuisettings', JSON.stringify({
        useDevServer: settingsDraft.useDevServer,
        devServerUrl: settingsDraft.devServerUrl,
        startupUrl: settingsDraft.startupUrl,
      }))
      setSettings(result)
      setSettingsDraft(result)
      setSettingsMessage('Settings saved.')
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : String(error))
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

  const draft = settingsDraft || settings

  return (
    <div className="panel">
      <h2>Startup Settings</h2>
      {!draft ? (
        <p className="muted">Read settings from the bridge.</p>
      ) : (
        <div className="settings-editor">
          <label className="schema-field checkbox" htmlFor="use-dev-server">
            <input
              id="use-dev-server"
              type="checkbox"
              checked={draft.useDevServer}
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
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                updateSettingsDraft('startupUrl', event.target.value)
              }
            />
          </label>
          <div className="settings-resolved">
            <span>Resolved URL</span>
            <code>{settings?.resolvedUrl || '-'}</code>
          </div>
          {settingsMessage ? <p className="settings-message">{settingsMessage}</p> : null}
          <div className="command-actions">
            <button type="button" onClick={() => void saveSettings()} disabled={!bridgeReady}>
              Save settings
            </button>
            <button type="button" onClick={() => void loadSettings()} disabled={!bridgeReady}>
              Reload
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

