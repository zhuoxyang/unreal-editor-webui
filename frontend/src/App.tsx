import { useMemo, useState } from 'react'
import './App.css'

type CommandSchema = {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

type CommandMetadata = {
  name: string
  description: string
  permission: 'read' | 'write' | 'destructive' | string
  schema: CommandSchema
}

type BridgeResponse<T> =
  | {
      id: string | null
      ok: true
      result: T
    }
  | {
      id: string | null
      ok: false
      error: {
        code: string
        message: string
        details?: string[]
        traceback?: string
      }
    }

type TaskResult = {
  taskId: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  responseJson?: string
}

type WebUISettings = {
  useDevServer: boolean
  devServerUrl: string
  startupUrl: string
  resolvedUrl: string
}

declare global {
  interface Window {
    ue?: {
      editorwebui?: {
        executecommand(requestJson: string): Promise<string>
        startcommand(requestJson: string): Promise<string>
        gettask(taskId: string): Promise<string>
        removetask(taskId: string): Promise<string>
        getwebuisettings(): Promise<string>
        setwebuisettings(settingsJson: string): Promise<string>
      }
    }
  }
}

function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function App() {
  const [commands, setCommands] = useState<CommandMetadata[]>([])
  const [settings, setSettings] = useState<WebUISettings | null>(null)
  const [logLines, setLogLines] = useState<string[]>([
    'Open this app inside the Unreal Editor WebUI tab to enable the bridge.',
  ])

  const bridge = window.ue?.editorwebui
  const bridgeReady = Boolean(bridge)

  const commandGroups = useMemo(() => {
    return commands.reduce<Record<string, CommandMetadata[]>>((groups, command) => {
      const [groupName] = command.name.split('.')
      groups[groupName] = groups[groupName] || []
      groups[groupName].push(command)
      return groups
    }, {})
  }, [commands])

  function log(message: string) {
    const time = new Date().toLocaleTimeString()
    setLogLines((lines) => [`[${time}] ${message}`, ...lines].slice(0, 80))
  }

  async function callBridge<T>(methodName: keyof NonNullable<typeof bridge>, ...args: string[]) {
    if (!bridge || typeof bridge[methodName] !== 'function') {
      throw new Error(`Bridge method unavailable: ${methodName}`)
    }

    const method = bridge[methodName] as (...methodArgs: string[]) => Promise<string>
    const responseJson = await method(...args)
    const response = JSON.parse(responseJson) as BridgeResponse<T>
    log(`${methodName} -> ${JSON.stringify(response, null, 2)}`)

    if (!response.ok) {
      throw new Error(response.error.message)
    }

    return response.result
  }

  async function runCommand<T>(command: string, payload: Record<string, unknown> = {}) {
    const request = {
      id: createRequestId(),
      command,
      payload,
    }

    return callBridge<T>('executecommand', JSON.stringify(request))
  }

  async function startCommand(command: string, payload: Record<string, unknown> = {}) {
    const request = {
      id: createRequestId(),
      command,
      payload,
    }

    const task = await callBridge<TaskResult>('startcommand', JSON.stringify(request))
    return task.taskId
  }

  async function pollTask(taskId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const task = await callBridge<TaskResult>('gettask', taskId)
      if (task.status === 'completed' || task.status === 'failed') {
        return task
      }

      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    throw new Error(`Timed out waiting for task: ${taskId}`)
  }

  async function loadCommands() {
    try {
      const result = await runCommand<{ commands: CommandMetadata[] }>('system.commands')
      setCommands(result.commands)
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    }
  }

  async function loadSettings() {
    try {
      const result = await callBridge<WebUISettings>('getwebuisettings')
      setSettings(result)
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    }
  }

  async function runAsyncDemo() {
    try {
      const taskId = await startCommand('demo.run')
      const task = await pollTask(taskId)
      await callBridge<{ removed: boolean }>('removetask', taskId)
      log(`async demo final response -> ${task.responseJson || 'no response'}`)
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Unreal Editor WebUI</p>
          <h1>React command console for UE editor tools</h1>
          <p className="lede">
            Discover Python registry commands, run typed JSON requests, poll task state,
            and inspect Web UI startup settings from a Vite frontend.
          </p>
        </div>
        <span className={bridgeReady ? 'status ready' : 'status'}>
          {bridgeReady ? 'Bridge ready' : 'Bridge unavailable'}
        </span>
      </section>

      <section className="toolbar">
        <button onClick={loadCommands} disabled={!bridgeReady}>
          Load command metadata
        </button>
        <button onClick={loadSettings} disabled={!bridgeReady}>
          Read Web UI settings
        </button>
        <button
          onClick={() =>
            runCommand('editor.log', { message: 'Hello from the React WebUI command console' }).catch((error) =>
              log(error instanceof Error ? error.message : String(error)),
            )
          }
          disabled={!bridgeReady}
        >
          Write UE log
        </button>
        <button onClick={runAsyncDemo} disabled={!bridgeReady}>
          Run async demo
        </button>
      </section>

      <section className="grid">
        <div className="panel">
          <h2>Commands</h2>
          {Object.keys(commandGroups).length === 0 ? (
            <p className="muted">Load metadata from <code>system.commands</code>.</p>
          ) : (
            Object.entries(commandGroups).map(([groupName, groupCommands]) => (
              <div className="command-group" key={groupName}>
                <h3>{groupName}</h3>
                {groupCommands.map((command) => (
                  <article className="command-card" key={command.name}>
                    <div>
                      <strong>{command.name}</strong>
                      <span className={`badge ${command.permission}`}>{command.permission}</span>
                    </div>
                    <p>{command.description || 'No description provided.'}</p>
                    <details>
                      <summary>Schema</summary>
                      <pre>{JSON.stringify(command.schema, null, 2)}</pre>
                    </details>
                  </article>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="panel">
          <h2>Startup Settings</h2>
          {settings ? (
            <dl className="settings">
              <div>
                <dt>Use dev server</dt>
                <dd>{String(settings.useDevServer)}</dd>
              </div>
              <div>
                <dt>Dev server URL</dt>
                <dd>{settings.devServerUrl || '-'}</dd>
              </div>
              <div>
                <dt>Startup URL</dt>
                <dd>{settings.startupUrl || '-'}</dd>
              </div>
              <div>
                <dt>Resolved URL</dt>
                <dd>{settings.resolvedUrl || '-'}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">Read settings from the bridge.</p>
          )}
        </div>

        <div className="panel log-panel">
          <h2>Bridge Log</h2>
          <pre>{logLines.join('\n')}</pre>
        </div>
      </section>
    </main>
  )
}

export default App
