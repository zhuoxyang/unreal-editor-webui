import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import './App.css'

type DraftValue = string | boolean

type SchemaProperty = {
  type?: 'string' | 'number' | 'integer' | 'boolean'
  description?: string
  enum?: Array<string | number | boolean>
  default?: string | number | boolean
  maxLength?: number
}

type CommandSchema = {
  type?: string
  properties?: Record<string, SchemaProperty>
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

type AssetSelectionResult = {
  count: number
  assets: Array<{
    name: string
    path: string
    className: string
  }>
}

type AssetListResult = {
  path: string
  recursive: boolean
  count: number
  truncated: boolean
  assets: Array<{
    assetName: string
    packageName: string
    packagePath: string
    objectPath: string
    assetClass: string
  }>
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
  const [payloadDrafts, setPayloadDrafts] = useState<Record<string, Record<string, DraftValue>>>({})
  const [commandResults, setCommandResults] = useState<Record<string, unknown>>({})
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

  function confirmCommand(command: CommandMetadata) {
    if (command.permission !== 'write' && command.permission !== 'destructive') {
      return true
    }

    const label = command.permission === 'destructive' ? 'destructive' : 'write'
    return window.confirm(`Run ${label} command "${command.name}"?`)
  }

  function getDefaultValue(property: SchemaProperty): DraftValue {
    if (property.default !== undefined) {
      return typeof property.default === 'boolean' ? property.default : String(property.default)
    }

    return property.type === 'boolean' ? false : ''
  }

  function getFieldValue(command: CommandMetadata, fieldName: string, property: SchemaProperty) {
    return payloadDrafts[command.name]?.[fieldName] ?? getDefaultValue(property)
  }

  function updateField(commandName: string, fieldName: string, value: DraftValue) {
    setPayloadDrafts((drafts) => ({
      ...drafts,
      [commandName]: {
        ...(drafts[commandName] || {}),
        [fieldName]: value,
      },
    }))
  }

  function buildPayload(command: CommandMetadata) {
    const payload: Record<string, unknown> = {}
    const properties = Object.entries(command.schema.properties || {})
    const required = new Set(command.schema.required || [])

    for (const [fieldName, property] of properties) {
      const rawValue = getFieldValue(command, fieldName, property)

      if (property.type === 'boolean') {
        payload[fieldName] = Boolean(rawValue)
        continue
      }

      if (property.type === 'number' || property.type === 'integer') {
        if (rawValue === '' && !required.has(fieldName)) {
          continue
        }

        const numericValue = Number(rawValue)
        if (Number.isNaN(numericValue)) {
          throw new Error(`${command.name}.${fieldName} must be a number`)
        }

        payload[fieldName] = property.type === 'integer' ? Math.trunc(numericValue) : numericValue
        continue
      }

      const stringValue = String(rawValue)
      if (stringValue === '' && !required.has(fieldName)) {
        continue
      }

      payload[fieldName] = stringValue
    }

    return payload
  }

  async function runCommandFromMetadata(command: CommandMetadata) {
    try {
      if (!confirmCommand(command)) {
        log(`Cancelled ${command.name}`)
        return
      }

      const result = await runCommand<unknown>(command.name, buildPayload(command))
      setCommandResults((results) => ({
        ...results,
        [command.name]: result,
      }))
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    }
  }

  async function startTaskFromMetadata(command: CommandMetadata) {
    try {
      if (!confirmCommand(command)) {
        log(`Cancelled ${command.name}`)
        return
      }

      const taskId = await startCommand(command.name, buildPayload(command))
      const task = await pollTask(taskId)
      await callBridge<{ removed: boolean }>('removetask', taskId)
      log(`${command.name} task final response -> ${task.responseJson || 'no response'}`)

      if (task.responseJson) {
        const response = JSON.parse(task.responseJson) as BridgeResponse<unknown>
        if (response.ok) {
          setCommandResults((results) => ({
            ...results,
            [command.name]: response.result,
          }))
        }
      }
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    }
  }

  function renderField(command: CommandMetadata, fieldName: string, property: SchemaProperty) {
    const value = getFieldValue(command, fieldName, property)
    const required = command.schema.required?.includes(fieldName)
    const inputId = `${command.name}-${fieldName}`

    if (property.enum && property.enum.length > 0) {
      return (
        <label className="schema-field" key={fieldName} htmlFor={inputId}>
          <span>
            {fieldName}
            {required ? <em>*</em> : null}
          </span>
          <select
            id={inputId}
            value={String(value)}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              updateField(command.name, fieldName, event.target.value)
            }
          >
            {property.enum.map((option) => (
              <option key={String(option)} value={String(option)}>
                {String(option)}
              </option>
            ))}
          </select>
          {property.description ? <small>{property.description}</small> : null}
        </label>
      )
    }

    if (property.type === 'boolean') {
      return (
        <label className="schema-field checkbox" key={fieldName} htmlFor={inputId}>
          <input
            id={inputId}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              updateField(command.name, fieldName, event.target.checked)
            }
          />
          <span>
            {fieldName}
            {required ? <em>*</em> : null}
          </span>
          {property.description ? <small>{property.description}</small> : null}
        </label>
      )
    }

    return (
      <label className="schema-field" key={fieldName} htmlFor={inputId}>
        <span>
          {fieldName}
          {required ? <em>*</em> : null}
        </span>
        <input
          id={inputId}
          type={property.type === 'number' || property.type === 'integer' ? 'number' : 'text'}
          value={String(value)}
          maxLength={property.maxLength}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            updateField(command.name, fieldName, event.target.value)
          }
        />
        {property.description ? <small>{property.description}</small> : null}
      </label>
    )
  }

  function renderAssetSelection(result: AssetSelectionResult) {
    return (
      <div className="result-view">
        <div className="result-summary">Selected assets: {result.count}</div>
        {result.assets.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Class</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {result.assets.map((asset) => (
                <tr key={asset.path || asset.name}>
                  <td>{asset.name}</td>
                  <td>{asset.className || '-'}</td>
                  <td>
                    <code>{asset.path || '-'}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No selected assets.</p>
        )}
      </div>
    )
  }

  function renderAssetList(result: AssetListResult) {
    return (
      <div className="result-view">
        <div className="result-summary">
          {result.count} assets under <code>{result.path}</code>
          {result.truncated ? ' (truncated)' : ''}
        </div>
        {result.assets.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Class</th>
                <th>Package Path</th>
                <th>Object Path</th>
              </tr>
            </thead>
            <tbody>
              {result.assets.map((asset) => (
                <tr key={asset.objectPath || asset.packageName || asset.assetName}>
                  <td>{asset.assetName}</td>
                  <td>{asset.assetClass || '-'}</td>
                  <td>
                    <code>{asset.packagePath || '-'}</code>
                  </td>
                  <td>
                    <code>{asset.objectPath || '-'}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No assets found.</p>
        )}
      </div>
    )
  }

  function renderCommandResult(commandName: string) {
    const result = commandResults[commandName]
    if (!result) {
      return null
    }

    if (commandName === 'editor.selectedAssets') {
      return renderAssetSelection(result as AssetSelectionResult)
    }

    if (commandName === 'asset.listByPath') {
      return renderAssetList(result as AssetListResult)
    }

    return (
      <div className="result-view">
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </div>
    )
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
                    <div className="schema-form">
                      {Object.entries(command.schema.properties || {}).length > 0 ? (
                        Object.entries(command.schema.properties || {}).map(([fieldName, property]) =>
                          renderField(command, fieldName, property),
                        )
                      ) : (
                        <p className="muted">No payload fields.</p>
                      )}
                    </div>
                    <div className="command-actions">
                      <button type="button" onClick={() => runCommandFromMetadata(command)} disabled={!bridgeReady}>
                        Run
                      </button>
                      <button type="button" onClick={() => startTaskFromMetadata(command)} disabled={!bridgeReady}>
                        Start task
                      </button>
                    </div>
                    {renderCommandResult(command.name)}
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
