import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import './App.css'

type DraftValue = string | boolean
type PermissionFilter = 'all' | 'read' | 'write' | 'destructive'
type ExecutionMode = 'run' | 'task'
type SchemaPropertyType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

type SchemaProperty = {
  type?: SchemaPropertyType | SchemaPropertyType[]
  description?: string
  enum?: Array<string | number | boolean>
  default?: unknown
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minItems?: number
  maxItems?: number
  items?: SchemaProperty
  properties?: Record<string, SchemaProperty>
  required?: string[]
  additionalProperties?: boolean | SchemaProperty
  xDryRun?: boolean
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
  supportsDryRun?: boolean
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
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress?: number
  logs?: string[]
  responseJson?: string
}

type WebUISettings = {
  useDevServer: boolean
  devServerUrl: string
  startupUrl: string
  resolvedUrl: string
}

type WebUIEvent = {
  type: string
  taskId?: string
  status?: string
  progress?: number
  log?: string
  updatedAt?: string
  responseJson?: string
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

type RecentExecution = {
  id: string
  command: string
  mode: ExecutionMode
  payload: Record<string, unknown>
  ranAt: string
}

const RECENT_EXECUTIONS_STORAGE_KEY = 'unreal-editor-webui.recentExecutions'
const MAX_RECENT_EXECUTIONS = 12

declare global {
  interface Window {
    ue?: {
      editorwebui?: {
        executecommand(requestJson: string): Promise<string>
        startcommand(requestJson: string): Promise<string>
        gettask(taskId: string): Promise<string>
        removetask(taskId: string): Promise<string>
        canceltask(taskId: string): Promise<string>
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

function getPropertyTypes(property: SchemaProperty) {
  if (Array.isArray(property.type)) {
    return property.type
  }

  return property.type ? [property.type] : []
}

function propertyHasType(property: SchemaProperty, type: SchemaPropertyType) {
  return getPropertyTypes(property).includes(type)
}

function isStructuredProperty(property: SchemaProperty) {
  return propertyHasType(property, 'array') || propertyHasType(property, 'object')
}

function commandHasDryRun(command: CommandMetadata) {
  return (
    command.supportsDryRun === true ||
    Object.values(command.schema.properties || {}).some((property) => property.xDryRun === true)
  )
}

function loadStoredRecentExecutions(): RecentExecution[] {
  try {
    const stored = globalThis.localStorage?.getItem(RECENT_EXECUTIONS_STORAGE_KEY)
    if (!stored) {
      return []
    }

    const parsed = JSON.parse(stored) as RecentExecution[]
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((item) => item && typeof item.command === 'string' && typeof item.ranAt === 'string')
  } catch {
    return []
  }
}

function formatSchemaDefault(value: unknown) {
  if (value === undefined) {
    return ''
  }

  return typeof value === 'string' ? value : JSON.stringify(value)
}

function formatRecentTime(value: string) {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) {
    return value
  }

  return timestamp.toLocaleTimeString()
}

function App() {
  const [commands, setCommands] = useState<CommandMetadata[]>([])
  const [settings, setSettings] = useState<WebUISettings | null>(null)
  const [payloadDrafts, setPayloadDrafts] = useState<Record<string, Record<string, DraftValue>>>({})
  const [commandResults, setCommandResults] = useState<Record<string, unknown>>({})
  const [commandSearch, setCommandSearch] = useState('')
  const [permissionFilter, setPermissionFilter] = useState<PermissionFilter>('all')
  const [recentExecutions, setRecentExecutions] = useState<RecentExecution[]>(loadStoredRecentExecutions)
  const [eventLines, setEventLines] = useState<string[]>([])
  const [logLines, setLogLines] = useState<string[]>([
    'Open this app inside the Unreal Editor WebUI tab to enable the bridge.',
  ])

  const bridge = window.ue?.editorwebui
  const bridgeReady = Boolean(bridge)

  const filteredCommands = useMemo(() => {
    const search = commandSearch.trim().toLowerCase()

    return commands.filter((command) => {
      const matchesPermission = permissionFilter === 'all' || command.permission === permissionFilter
      const searchText = `${command.name} ${command.description}`.toLowerCase()
      return matchesPermission && (!search || searchText.includes(search))
    })
  }, [commands, commandSearch, permissionFilter])

  const commandGroups = useMemo(() => {
    return filteredCommands.reduce<Record<string, CommandMetadata[]>>((groups, command) => {
      const [groupName] = command.name.split('.')
      groups[groupName] = groups[groupName] || []
      groups[groupName].push(command)
      return groups
    }, {})
  }, [filteredCommands])

  useEffect(() => {
    function handleWebUIEvent(event: Event) {
      const customEvent = event as CustomEvent<WebUIEvent>
      const detail = customEvent.detail
      if (!detail) {
        return
      }

      const time = new Date().toLocaleTimeString()
      const taskSummary = detail.taskId ? ` ${detail.taskId}` : ''
      const statusSummary = detail.status ? ` ${detail.status}` : ''
      const progressSummary = typeof detail.progress === 'number' ? ` ${detail.progress}%` : ''
      const logSummary = detail.log ? ` ${detail.log}` : ''
      setEventLines((lines) => [
        `[${time}] ${detail.type}${taskSummary}${statusSummary}${progressSummary}${logSummary}`,
        ...lines,
      ].slice(0, 80))
    }

    window.addEventListener('unreal-editor-webui', handleWebUIEvent)
    return () => window.removeEventListener('unreal-editor-webui', handleWebUIEvent)
  }, [])

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(RECENT_EXECUTIONS_STORAGE_KEY, JSON.stringify(recentExecutions))
    } catch {
      // Local storage is optional in embedded browser contexts.
    }
  }, [recentExecutions])

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
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
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
      if (propertyHasType(property, 'boolean')) {
        return property.default === true
      }

      if (isStructuredProperty(property)) {
        return JSON.stringify(property.default, null, 2)
      }

      return String(property.default)
    }

    return propertyHasType(property, 'boolean') ? false : ''
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

  function getDraftFromPayload(command: CommandMetadata, payload: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(command.schema.properties || {}).map(([fieldName, property]) => {
        const payloadValue = payload[fieldName]
        if (payloadValue === undefined) {
          return [fieldName, getDefaultValue(property)]
        }

        if (propertyHasType(property, 'boolean')) {
          return [fieldName, payloadValue === true]
        }

        if (isStructuredProperty(property)) {
          return [fieldName, JSON.stringify(payloadValue, null, 2)]
        }

        return [fieldName, String(payloadValue)]
      }),
    ) as Record<string, DraftValue>
  }

  function loadPayloadDraft(command: CommandMetadata, payload: Record<string, unknown>) {
    setPayloadDrafts((drafts) => ({
      ...drafts,
      [command.name]: getDraftFromPayload(command, payload),
    }))
  }

  function loadSchemaDefaults(command: CommandMetadata) {
    loadPayloadDraft(command, {})
  }

  function clearPayloadDraft(command: CommandMetadata) {
    const cleared = Object.fromEntries(
      Object.entries(command.schema.properties || {}).map(([fieldName, property]) => [
        fieldName,
        propertyHasType(property, 'boolean') ? false : '',
      ]),
    ) as Record<string, DraftValue>

    setPayloadDrafts((drafts) => ({
      ...drafts,
      [command.name]: cleared,
    }))
  }

  function recordRecentExecution(command: CommandMetadata, payload: Record<string, unknown>, mode: ExecutionMode) {
    setRecentExecutions((items) => {
      const payloadKey = JSON.stringify(payload)
      const nextItem: RecentExecution = {
        id: createRequestId(),
        command: command.name,
        mode,
        payload,
        ranAt: new Date().toISOString(),
      }

      return [
        nextItem,
        ...items.filter((item) => item.command !== command.name || JSON.stringify(item.payload) !== payloadKey),
      ].slice(0, MAX_RECENT_EXECUTIONS)
    })
  }

  function buildPayload(command: CommandMetadata) {
    const payload: Record<string, unknown> = {}
    const properties = Object.entries(command.schema.properties || {})
    const required = new Set(command.schema.required || [])

    for (const [fieldName, property] of properties) {
      const rawValue = getFieldValue(command, fieldName, property)

      if (propertyHasType(property, 'boolean')) {
        payload[fieldName] = Boolean(rawValue)
        continue
      }

      if (isStructuredProperty(property)) {
        const jsonText = String(rawValue).trim()
        if (jsonText === '' && !required.has(fieldName)) {
          continue
        }

        let parsedValue: unknown
        try {
          parsedValue = JSON.parse(jsonText)
        } catch {
          throw new Error(`${command.name}.${fieldName} must be valid JSON`)
        }

        const allowsArray = propertyHasType(property, 'array')
        const allowsObject = propertyHasType(property, 'object')
        const isArray = Array.isArray(parsedValue)
        const isObject = parsedValue !== null && typeof parsedValue === 'object' && !isArray

        if (!((allowsArray && isArray) || (allowsObject && isObject))) {
          const expected = allowsArray && allowsObject ? 'JSON array or object' : allowsArray ? 'JSON array' : 'JSON object'
          throw new Error(`${command.name}.${fieldName} must be a ${expected}`)
        }

        payload[fieldName] = parsedValue
        continue
      }

      if (propertyHasType(property, 'number') || propertyHasType(property, 'integer')) {
        if (rawValue === '' && !required.has(fieldName)) {
          continue
        }

        const numericValue = Number(rawValue)
        if (Number.isNaN(numericValue)) {
          throw new Error(`${command.name}.${fieldName} must be a number`)
        }

        payload[fieldName] = propertyHasType(property, 'integer') ? Math.trunc(numericValue) : numericValue
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

      const payload = buildPayload(command)
      const result = await runCommand<unknown>(command.name, payload)
      recordRecentExecution(command, payload, 'run')
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

      const payload = buildPayload(command)
      const taskId = await startCommand(command.name, payload)
      const task = await pollTask(taskId)
      await callBridge<{ removed: boolean }>('removetask', taskId)
      log(`${command.name} task final response -> ${task.responseJson || 'no response'}`)
      recordRecentExecution(command, payload, 'task')

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

  function describeFieldConstraints(property: SchemaProperty) {
    const constraints: string[] = []

    if (typeof property.minimum === 'number') {
      constraints.push(`min ${property.minimum}`)
    }
    if (typeof property.maximum === 'number') {
      constraints.push(`max ${property.maximum}`)
    }
    if (typeof property.exclusiveMinimum === 'number') {
      constraints.push(`> ${property.exclusiveMinimum}`)
    }
    if (typeof property.exclusiveMaximum === 'number') {
      constraints.push(`< ${property.exclusiveMaximum}`)
    }
    if (typeof property.minLength === 'number') {
      constraints.push(`min length ${property.minLength}`)
    }
    if (typeof property.maxLength === 'number') {
      constraints.push(`max length ${property.maxLength}`)
    }
    if (typeof property.minItems === 'number') {
      constraints.push(`min items ${property.minItems}`)
    }
    if (typeof property.maxItems === 'number') {
      constraints.push(`max items ${property.maxItems}`)
    }
    if (property.default !== undefined) {
      constraints.push(`default ${formatSchemaDefault(property.default)}`)
    }

    return constraints.join(' | ')
  }

  function renderFieldHint(property: SchemaProperty) {
    const constraints = describeFieldConstraints(property)

    if (!property.description && !constraints) {
      return null
    }

    return (
      <small>
        {[property.description, constraints].filter(Boolean).join(' | ')}
      </small>
    )
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
          {renderFieldHint(property)}
        </label>
      )
    }

    if (propertyHasType(property, 'boolean')) {
      return (
        <label
          className={property.xDryRun ? 'schema-field checkbox dry-run-field' : 'schema-field checkbox'}
          key={fieldName}
          htmlFor={inputId}
        >
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
          {renderFieldHint(property)}
        </label>
      )
    }

    if (isStructuredProperty(property)) {
      return (
        <label className="schema-field" key={fieldName} htmlFor={inputId}>
          <span>
            {fieldName}
            {required ? <em>*</em> : null}
          </span>
          <textarea
            id={inputId}
            value={String(value)}
            placeholder={propertyHasType(property, 'array') ? '[]' : '{}'}
            rows={5}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              updateField(command.name, fieldName, event.target.value)
            }
          />
          {renderFieldHint(property)}
        </label>
      )
    }

    if (propertyHasType(property, 'string') && typeof property.maxLength === 'number' && property.maxLength > 160) {
      return (
        <label className="schema-field" key={fieldName} htmlFor={inputId}>
          <span>
            {fieldName}
            {required ? <em>*</em> : null}
          </span>
          <textarea
            id={inputId}
            value={String(value)}
            minLength={property.minLength}
            maxLength={property.maxLength}
            rows={4}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              updateField(command.name, fieldName, event.target.value)
            }
          />
          {renderFieldHint(property)}
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
          type={propertyHasType(property, 'number') || propertyHasType(property, 'integer') ? 'number' : 'text'}
          value={String(value)}
          min={property.minimum}
          max={property.maximum}
          minLength={property.minLength}
          maxLength={property.maxLength}
          step={propertyHasType(property, 'integer') ? 1 : undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            updateField(command.name, fieldName, event.target.value)
          }
        />
        {renderFieldHint(property)}
      </label>
    )
  }

  function renderPayloadPresets(command: CommandMetadata) {
    const recentForCommand = recentExecutions.filter((item) => item.command === command.name).slice(0, 3)

    return (
      <div className="payload-presets">
        <button type="button" onClick={() => loadSchemaDefaults(command)}>
          Defaults
        </button>
        <button type="button" onClick={() => clearPayloadDraft(command)}>
          Clear
        </button>
        {recentForCommand.map((item) => (
          <button type="button" key={item.id} onClick={() => loadPayloadDraft(command, item.payload)}>
            {item.mode === 'task' ? 'Task' : 'Run'} {formatRecentTime(item.ranAt)}
          </button>
        ))}
      </div>
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
          <div className="command-browser">
            <input
              type="search"
              value={commandSearch}
              placeholder="Search commands"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setCommandSearch(event.target.value)}
            />
            <select
              value={permissionFilter}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setPermissionFilter(event.target.value as PermissionFilter)
              }
            >
              <option value="all">All permissions</option>
              <option value="read">Read</option>
              <option value="write">Write</option>
              <option value="destructive">Destructive</option>
            </select>
            <span>{filteredCommands.length} shown</span>
          </div>
          {commands.length === 0 ? (
            <p className="muted">
              Load metadata from <code>system.commands</code>.
            </p>
          ) : filteredCommands.length === 0 ? (
            <p className="muted">No commands match the current filters.</p>
          ) : (
            Object.entries(commandGroups).map(([groupName, groupCommands]) => (
              <div className="command-group" key={groupName}>
                <h3>{groupName}</h3>
                {groupCommands.map((command) => (
                  <article className="command-card" key={command.name}>
                    <div className="command-card-header">
                      <strong>{command.name}</strong>
                      <span className="badge-group">
                        <span className={`badge ${command.permission}`} title={`${command.permission} permission`}>
                          {command.permission}
                        </span>
                        {commandHasDryRun(command) ? (
                          <span className="badge dry-run" title="Dry-run capable">
                            dry-run
                          </span>
                        ) : null}
                      </span>
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
                    {renderPayloadPresets(command)}
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
          <h2>Task Events</h2>
          {eventLines.length > 0 ? (
            <pre>{eventLines.join('\n')}</pre>
          ) : (
            <p className="muted">Task status events will appear here.</p>
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
