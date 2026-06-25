import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import './App.css'
import { InspectorPanel } from './components/InspectorPanel'
import { ResultRenderer } from './components/ResultRenderer'
import { ToolRackPanel } from './components/ToolRackPanel'
import { WorkspacePanel } from './components/WorkspacePanel'
import { createRequestId, useEditorBridge } from './bridge'
import type { BridgeResponse, TaskResult, WebUISettings } from './bridge'
import {
  formatRecentTime,
  loadStoredRecentExecutions,
  MAX_RECENT_EXECUTIONS,
  saveStoredRecentExecutions,
} from './recent-executions'
import type { ExecutionMode, RecentExecution } from './recent-executions'
import {
  decodeEnumOption,
  encodeEnumOption,
  hasCommandResult,
  isSchemaScalar,
  parseNumericDraft,
} from './schema-form'
import {
  commandCategoryId,
  commandSupportsStage,
  loadToolPreferences,
  saveToolPreferences,
  TOOL_CATEGORIES,
  TOOL_PROJECTS,
  TOOL_STAGES,
} from './tool-manifest'
import type { ToolCategoryId, ToolProjectId, ToolStageId } from './tool-manifest'
import { isTerminalTaskStatus, parseTaskStatus } from './task-model'
import type { TaskRecord, WebUIEvent } from './task-model'

type DraftValue = string | number | boolean
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
  metadataVersion?: number
  name: string
  description: string
  permission: 'read' | 'write' | 'destructive' | string
  schema: CommandSchema
  supportsDryRun?: boolean
  category?: string
  icon?: string
  tags?: string[]
  order?: number
  supportedAssetTypes?: string[]
  ui?: Record<string, unknown>
  resultType?: string
  warnings?: string[]
  execution?: {
    thread?: string
    cancellationMode?: string
    timeoutPolicy?: string
  }
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

function formatSchemaDefault(value: unknown) {
  if (value === undefined) {
    return ''
  }

  return typeof value === 'string' ? value : JSON.stringify(value)
}

function App() {
  const [commands, setCommands] = useState<CommandMetadata[]>([])
  const [settings, setSettings] = useState<WebUISettings | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<WebUISettings | null>(null)
  const [settingsMessage, setSettingsMessage] = useState('')
  const [payloadDrafts, setPayloadDrafts] = useState<Record<string, Record<string, DraftValue>>>({})
  const [commandResults, setCommandResults] = useState<Record<string, unknown>>({})
  const [taskRecords, setTaskRecords] = useState<Record<string, TaskRecord>>({})
  const [commandSearch, setCommandSearch] = useState('')
  const [toolPreferences, setToolPreferences] = useState(loadToolPreferences)
  const [selectedCommandName, setSelectedCommandName] = useState<string | null>(null)
  const [workspaceTabs, setWorkspaceTabs] = useState<string[]>(toolPreferences.openTabs)
  const [favoriteCommands, setFavoriteCommands] = useState<string[]>(toolPreferences.favorites)
  const [recentExecutions, setRecentExecutions] = useState<RecentExecution[]>(loadStoredRecentExecutions)
  const [eventLines, setEventLines] = useState<string[]>([])
  const [logLines, setLogLines] = useState<string[]>([
    'Open this app inside the Unreal Editor WebUI tab to enable the bridge.',
  ])

  const log = useCallback((message: string) => {
    const time = new Date().toLocaleTimeString()
    setLogLines((lines) => [`[${time}] ${message}`, ...lines].slice(0, 80))
  }, [])

  const { bridgeReady, callBridge, callBridgeQuiet } = useEditorBridge(log)

  const taskList = useMemo(() => {
    return Object.values(taskRecords).sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }, [taskRecords])

  const activeTaskIds = useMemo(() => {
    return taskList.filter((task) => !isTerminalTaskStatus(task.status)).map((task) => task.taskId)
  }, [taskList])

  const activeTaskKey = activeTaskIds.join('|')

  const activeProject = TOOL_PROJECTS.find((project) => project.id === toolPreferences.projectId) || TOOL_PROJECTS[0]
  const availableStages = TOOL_STAGES.filter((stage) => activeProject.stages.includes(stage.id))

  const filteredCommands = useMemo(() => {
    const search = commandSearch.trim().toLowerCase()

    return commands.filter((command) => {
      const matchesStage = commandSupportsStage(command, toolPreferences.stageId)
      const categoryId = commandCategoryId(command)
      const matchesCategory =
        toolPreferences.categoryId === 'all' ||
        (toolPreferences.categoryId === 'favorites' && favoriteCommands.includes(command.name)) ||
        (toolPreferences.categoryId === 'recent' && recentExecutions.some((item) => item.command === command.name)) ||
        categoryId === toolPreferences.categoryId
      const searchText = `${command.name} ${command.description} ${command.category || ''} ${(command.tags || []).join(' ')}`.toLowerCase()
      return matchesStage && matchesCategory && (!search || searchText.includes(search))
    })
  }, [commands, commandSearch, favoriteCommands, recentExecutions, toolPreferences.categoryId, toolPreferences.stageId])

  const selectedCommand = useMemo(() => {
    if (selectedCommandName) {
      return commands.find((command) => command.name === selectedCommandName) || filteredCommands[0] || null
    }

    return filteredCommands[0] || null
  }, [commands, filteredCommands, selectedCommandName])

  const recentCommandNames = useMemo(() => {
    return Array.from(new Set(recentExecutions.map((item) => item.command))).slice(0, 6)
  }, [recentExecutions])

  const favoriteCommandSet = useMemo(() => new Set(favoriteCommands), [favoriteCommands])

  const visibleFavoriteCommands = useMemo(() => {
    return favoriteCommands
      .map((name) => commands.find((command) => command.name === name))
      .filter((command): command is CommandMetadata => Boolean(command))
  }, [commands, favoriteCommands])

  const visibleRecentCommands = useMemo(() => {
    return recentCommandNames
      .map((name) => commands.find((command) => command.name === name))
      .filter((command): command is CommandMetadata => Boolean(command))
  }, [commands, recentCommandNames])

  const openWorkspaceCommandNames = useMemo(() => {
    const names = workspaceTabs.filter((name) => commands.some((command) => command.name === name))
    if (selectedCommand && !names.includes(selectedCommand.name)) {
      return [selectedCommand.name, ...names]
    }

    return names
  }, [commands, selectedCommand, workspaceTabs])

  const workspaceCommandTabs = useMemo(() => {
    return openWorkspaceCommandNames
      .map((name) => commands.find((command) => command.name === name))
      .filter((command): command is CommandMetadata => Boolean(command))
      .map((command) => ({
        name: command.name,
        icon: command.icon,
      }))
  }, [commands, openWorkspaceCommandNames])

  function openCommandWorkspace(commandName: string) {
    setSelectedCommandName(commandName)
    setWorkspaceTabs((tabs) => (tabs.includes(commandName) ? tabs : [commandName, ...tabs].slice(0, 8)))
  }

  function closeCommandWorkspace(commandName: string) {
    setWorkspaceTabs((tabs) => tabs.filter((name) => name !== commandName))
    if (selectedCommandName === commandName) {
      setSelectedCommandName(workspaceTabs.find((name) => name !== commandName) || null)
    }
  }

  function toggleFavoriteCommand(commandName: string) {
    setFavoriteCommands((items) =>
      items.includes(commandName) ? items.filter((name) => name !== commandName) : [commandName, ...items].slice(0, 12),
    )
  }

  function updateToolProject(projectId: ToolProjectId) {
    const project = TOOL_PROJECTS.find((item) => item.id === projectId) || TOOL_PROJECTS[0]
    const nextStage = project.stages.includes(toolPreferences.stageId) ? toolPreferences.stageId : project.stages[0]
    setToolPreferences((preferences) => ({
      ...preferences,
      projectId,
      stageId: nextStage,
    }))
  }

  function updateToolStage(stageId: ToolStageId) {
    setToolPreferences((preferences) => ({
      ...preferences,
      stageId,
    }))
  }

  function updateToolCategory(categoryId: ToolCategoryId) {
    setToolPreferences((preferences) => ({
      ...preferences,
      categoryId,
    }))
  }

  useEffect(() => {
    saveStoredRecentExecutions(recentExecutions)
  }, [recentExecutions])

  useEffect(() => {
    saveToolPreferences({
      ...toolPreferences,
      favorites: favoriteCommands,
      openTabs: workspaceTabs,
    })
  }, [favoriteCommands, toolPreferences, workspaceTabs])

  const mergeTaskResult = useCallback((task: TaskResult, fallback?: Partial<TaskRecord>) => {
    setTaskRecords((records) => {
      const existing = records[task.taskId]
      const startedAt = existing?.startedAt || fallback?.startedAt || task.createdAt || new Date().toISOString()
      const command = task.command || existing?.command || fallback?.command || 'unknown'
      const payload = task.payload || existing?.payload || fallback?.payload || {}
      const replacesLastError = fallback && Object.prototype.hasOwnProperty.call(fallback, 'lastError')

      return {
        ...records,
        [task.taskId]: {
          ...existing,
          ...fallback,
          ...task,
          command,
          payload,
          startedAt,
          progress: task.progress ?? existing?.progress ?? 0,
          cancellable: task.cancellable ?? existing?.cancellable ?? false,
          cancellationMode: task.cancellationMode ?? existing?.cancellationMode,
          executionThread: task.executionThread ?? existing?.executionThread,
          timeoutPolicy: task.timeoutPolicy ?? existing?.timeoutPolicy,
          message: task.message ?? existing?.message,
          logs: task.logs ?? existing?.logs ?? [],
          updatedAt: task.updatedAt || existing?.updatedAt || new Date().toISOString(),
          lastError: replacesLastError ? fallback.lastError : existing?.lastError,
        },
      }
    })
  }, [])

  const mergeTaskEvent = useCallback((detail: WebUIEvent) => {
    if (!detail.taskId) {
      return
    }

    const taskId = detail.taskId
    const status = parseTaskStatus(detail.status)
    if (!status) {
      return
    }

    setTaskRecords((records) => {
      const existing = records[taskId]
      const logs = detail.log ? [...(existing?.logs || []), detail.log].slice(-80) : existing?.logs || []

      return {
        ...records,
        [taskId]: {
          taskId,
          command: existing?.command || 'unknown',
          payload: existing?.payload || {},
          startedAt: existing?.startedAt || detail.updatedAt || new Date().toISOString(),
          status,
          progress: detail.progress ?? existing?.progress ?? 0,
          cancellable: detail.cancellable ?? existing?.cancellable ?? false,
          cancellationMode: detail.cancellationMode ?? existing?.cancellationMode,
          executionThread: detail.executionThread ?? existing?.executionThread,
          timeoutPolicy: detail.timeoutPolicy ?? existing?.timeoutPolicy,
          message: detail.message ?? existing?.message,
          logs,
          createdAt: existing?.createdAt,
          updatedAt: detail.updatedAt || new Date().toISOString(),
          responseJson: detail.responseJson ?? existing?.responseJson,
          lastError: existing?.lastError,
        },
      }
    })
  }, [])

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
      mergeTaskEvent(detail)
    }

    window.addEventListener('unreal-editor-webui', handleWebUIEvent)
    return () => window.removeEventListener('unreal-editor-webui', handleWebUIEvent)
  }, [mergeTaskEvent])

  useEffect(() => {
    if (!bridgeReady) {
      return
    }

    let stopped = false
    void callBridgeQuiet<{ tasks: TaskResult[] }>('listtasks')
      .then((result) => {
        if (!stopped) {
          result.tasks.forEach((task) => mergeTaskResult(task))
        }
      })
      .catch((error) => {
        if (!stopped) {
          log(`Unable to restore tasks: ${error instanceof Error ? error.message : String(error)}`)
        }
      })

    return () => {
      stopped = true
    }
  }, [bridgeReady, callBridgeQuiet, log, mergeTaskResult])

  const recordTaskPollingError = useCallback((taskId: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setTaskRecords((records) => {
      const existing = records[taskId]
      if (!existing) {
        return records
      }

      return {
        ...records,
        [taskId]: {
          ...existing,
          lastError: message,
        },
      }
    })
  }, [])

  useEffect(() => {
    if (!bridgeReady || !activeTaskKey) {
      return
    }

    let stopped = false
    const taskIds = activeTaskKey.split('|')
    let timeoutId: number | undefined
    let consecutiveFailures = 0

    async function refreshTasks() {
      let hadFailure = false
      await Promise.all(taskIds.map(async (taskId) => {
        try {
          const task = await callBridgeQuiet<TaskResult>('gettask', taskId)
          if (!stopped) {
            mergeTaskResult(task, { lastError: undefined })
          }
        } catch (error) {
          hadFailure = true
          if (!stopped) {
            recordTaskPollingError(taskId, error)
          }
        }
      }))

      if (stopped) {
        return
      }

      consecutiveFailures = hadFailure ? Math.min(consecutiveFailures + 1, 4) : 0
      const delay = Math.min(1000 * 2 ** consecutiveFailures, 10000)
      timeoutId = window.setTimeout(() => {
        void refreshTasks()
      }, delay)
    }

    void refreshTasks()

    return () => {
      stopped = true
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [activeTaskKey, bridgeReady, callBridgeQuiet, mergeTaskResult, recordTaskPollingError])

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

    return callBridge<TaskResult>('startcommand', JSON.stringify(request))
  }

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
      void callBridgeQuiet<{ commands: CommandMetadata[] }>(
        'executecommand',
        JSON.stringify({
          id: createRequestId(),
          command: 'system.commands',
          payload: {},
        }),
      )
        .then((result) => setCommands(Array.isArray(result.commands) ? result.commands : []))
        .catch((error) => log(error instanceof Error ? error.message : String(error)))

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

  function getDefaultValue(property: SchemaProperty): DraftValue {
    if (property.default !== undefined) {
      if (property.enum && isSchemaScalar(property.default) && property.enum.includes(property.default)) {
        return property.default
      }
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

        if (property.enum && isSchemaScalar(payloadValue)) {
          return [fieldName, payloadValue]
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
        property.enum ? '' : propertyHasType(property, 'boolean') ? false : '',
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

      if (property.enum && rawValue === '') {
        if (required.has(fieldName)) {
          throw new Error(`${command.name}.${fieldName} is required`)
        }
        continue
      }

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

        payload[fieldName] = parseNumericDraft(rawValue, propertyHasType(property, 'integer'), `${command.name}.${fieldName}`)
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
      const payload = buildPayload(command)
      const task = await startCommand(command.name, payload)
      mergeTaskResult(task, {
        command: command.name,
        payload,
        startedAt: new Date().toISOString(),
      })
      log(`${command.name} task started -> ${task.taskId}`)
      recordRecentExecution(command, payload, 'task')
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    }
  }

  async function cancelTask(taskId: string) {
    try {
      const task = await callBridge<TaskResult>('canceltask', taskId)
      mergeTaskResult(task)
    } catch (error) {
      try {
        const latest = await callBridgeQuiet<TaskResult>('gettask', taskId)
        mergeTaskResult(latest, {
          lastError: error instanceof Error ? error.message : String(error),
        })
        return
      } catch {
        // Keep the original cancel error if the follow-up refresh also fails.
      }

      mergeTaskResult(
        {
          taskId,
          status: taskRecords[taskId]?.status || 'failed',
        },
        {
          lastError: error instanceof Error ? error.message : String(error),
        },
      )
    }
  }

  async function removeTask(taskId: string) {
    try {
      await callBridge<{ removed: boolean }>('removetask', taskId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(message)
      recordTaskPollingError(taskId, error)
      return
    }

    setTaskRecords((records) => {
      const next = { ...records }
      delete next[taskId]
      return next
    })
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
      const selectedValue = value === '' ? '' : encodeEnumOption(value)
      return (
        <label className="schema-field" key={fieldName} htmlFor={inputId}>
          <span>
            {fieldName}
            {required ? <em>*</em> : null}
          </span>
          <select
            id={inputId}
            value={selectedValue}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              const nextValue = event.target.value
              updateField(command.name, fieldName, nextValue === '' ? '' : decodeEnumOption(nextValue))
            }}
          >
            <option value="">Select a value</option>
            {property.enum.map((option) => (
              <option key={encodeEnumOption(option)} value={encodeEnumOption(option)}>
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

  function renderTaskRecord(task: TaskRecord) {
    const canCancel = task.cancellable === true
    const canRemove = isTerminalTaskStatus(task.status)
    let parsedTaskResponse: BridgeResponse<unknown> | null = null
    if (task.responseJson) {
      try {
        parsedTaskResponse = JSON.parse(task.responseJson) as BridgeResponse<unknown>
      } catch {
        parsedTaskResponse = null
      }
    }

    return (
      <article className="task-card" key={task.taskId}>
        <div className="task-card-header">
          <div>
            <strong>{task.command}</strong>
            <small>{task.taskId}</small>
          </div>
          <span className={`badge ${task.status}`}>{task.status}</span>
        </div>
        <div className="task-progress">
          <span style={{ width: `${task.progress ?? 0}%` }} />
        </div>
        <div className="task-meta">
          <span>{task.progress ?? 0}%</span>
          <span>{task.updatedAt ? formatRecentTime(task.updatedAt) : formatRecentTime(task.startedAt)}</span>
        </div>
        <div className="task-lifecycle">
          <span>{task.executionThread || 'unknown thread'}</span>
          <span>cancel: {task.cancellationMode || (task.cancellable ? 'available' : 'not available')}</span>
          <span>timeout: {task.timeoutPolicy || 'unknown'}</span>
        </div>
        {task.lastError ? <p className="task-error">{task.lastError}</p> : null}
        {task.message ? <p className="muted">{task.message}</p> : null}
        {task.logs && task.logs.length > 0 ? (
          <pre>{task.logs.slice(-8).join('\n')}</pre>
        ) : (
          <p className="muted">No task logs yet.</p>
        )}
        {task.responseJson ? (
          <details>
            <summary>Response</summary>
            {parsedTaskResponse?.ok ? (
              <ResultRenderer result={parsedTaskResponse.result} resultType={commands.find((command) => command.name === task.command)?.resultType} />
            ) : (
              <pre>{task.responseJson}</pre>
            )}
          </details>
        ) : null}
        <div className="task-actions">
          <button type="button" onClick={() => cancelTask(task.taskId)} disabled={!bridgeReady || !canCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => removeTask(task.taskId)} disabled={!bridgeReady || !canRemove}>
            Remove
          </button>
        </div>
      </article>
    )
  }

  function renderSettingsEditor() {
    const draft = settingsDraft || settings

    if (!draft) {
      return <p className="muted">Read settings from the bridge.</p>
    }

    return (
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
          <button type="button" onClick={saveSettings} disabled={!bridgeReady}>
            Save settings
          </button>
          <button type="button" onClick={loadSettings} disabled={!bridgeReady}>
            Reload
          </button>
        </div>
      </div>
    )
  }

  function renderCommandResult(commandName: string) {
    const result = commandResults[commandName]
    if (!hasCommandResult(commandResults, commandName)) {
      return null
    }

    const command = commands.find((item) => item.name === commandName)
    return <ResultRenderer commandName={commandName} result={result} resultType={command?.resultType} />
  }

  return (
    <main className="app-shell tool-shell">
      <section className="tool-shell-header">
        <div>
          <p className="eyebrow">Unreal Editor WebUI</p>
          <h1>Tool Rack Workspace</h1>
          <p className="lede">
            Search, favorite, open, inspect, and run Unreal editor tools from a persistent workspace shell.
          </p>
        </div>
        <span className={bridgeReady ? 'status ready' : 'status'}>
          {bridgeReady ? 'Bridge ready' : 'Bridge unavailable'}
        </span>
      </section>

      <section className="tool-shell-layout">
        <ToolRackPanel
          categories={TOOL_CATEGORIES}
          categoryId={toolPreferences.categoryId}
          commands={filteredCommands}
          favoriteCommands={visibleFavoriteCommands}
          onCategoryChange={updateToolCategory}
          onOpenCommand={openCommandWorkspace}
          onProjectChange={updateToolProject}
          onSearchChange={setCommandSearch}
          onStageChange={updateToolStage}
          projectId={toolPreferences.projectId}
          projects={TOOL_PROJECTS}
          recentCommands={visibleRecentCommands}
          search={commandSearch}
          selectedCommandName={selectedCommand?.name || null}
          shownCount={filteredCommands.length}
          stageId={toolPreferences.stageId}
          stages={availableStages}
        />

        <WorkspacePanel
          activeTabName={selectedCommand?.name || null}
          badges={
            selectedCommand ? (
              <>
                <span className={`badge ${selectedCommand.permission}`}>{selectedCommand.permission}</span>
                {commandHasDryRun(selectedCommand) ? <span className="badge dry-run">dry-run</span> : null}
                {selectedCommand.execution?.thread ? (
                  <span className="badge execution">{selectedCommand.execution.thread}</span>
                ) : null}
              </>
            ) : null
          }
          category={selectedCommand?.category || selectedCommand?.name.split('.')[0]}
          onCloseTab={closeCommandWorkspace}
          onSelectTab={setSelectedCommandName}
          result={
            selectedCommand ? (
              renderCommandResult(selectedCommand.name) || (
                <p className="muted">Run this tool to see structured output in the workspace.</p>
              )
            ) : (
              <p className="muted">No tool selected.</p>
            )
          }
          subtitle={selectedCommand?.description || 'No description provided.'}
          tabs={workspaceCommandTabs}
          title={selectedCommand?.name}
        />

        <InspectorPanel
          favoriteLabel={
            selectedCommand ? (favoriteCommandSet.has(selectedCommand.name) ? 'Unfavorite' : 'Favorite') : undefined
          }
          onToggleFavorite={selectedCommand ? () => toggleFavoriteCommand(selectedCommand.name) : undefined}
        >
          {selectedCommand ? (
            <>
              <div className="schema-form">
                {Object.entries(selectedCommand.schema.properties || {}).length > 0 ? (
                  Object.entries(selectedCommand.schema.properties || {}).map(([fieldName, property]) =>
                    renderField(selectedCommand, fieldName, property),
                  )
                ) : (
                  <p className="muted">No payload fields.</p>
                )}
              </div>
              {renderPayloadPresets(selectedCommand)}
              <div className="command-actions">
                <button type="button" onClick={() => runCommandFromMetadata(selectedCommand)} disabled={!bridgeReady}>
                  Run
                </button>
                <button type="button" onClick={() => startTaskFromMetadata(selectedCommand)} disabled={!bridgeReady}>
                  Start task
                </button>
              </div>
              <details>
                <summary>Schema</summary>
                <pre>{JSON.stringify(selectedCommand.schema, null, 2)}</pre>
              </details>
            </>
          ) : (
            <p className="muted">Select a tool to inspect its inputs.</p>
          )}
        </InspectorPanel>
      </section>

      <section className="tool-shell-bottom">
        <div className="panel task-panel">
          <h2>Task Monitor</h2>
          {taskList.length > 0 ? (
            <div className="task-list">
              {taskList.map((task) => renderTaskRecord(task))}
            </div>
          ) : (
            <p className="muted">Started tasks will appear here.</p>
          )}
        </div>

        <div className="panel log-panel">
          <h2>Message Log</h2>
          {eventLines.length > 0 ? (
            <pre>{eventLines.join('\n')}</pre>
          ) : (
            <p className="muted">Task status events will appear here.</p>
          )}
        </div>

        <div className="panel">
          <h2>Startup Settings</h2>
          {renderSettingsEditor()}
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
