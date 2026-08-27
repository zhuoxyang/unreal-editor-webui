# External Web App Integration Guide

This guide shows how a trusted external Web app can call the Unreal Editor WebUI bridge. The app must run inside the plugin's `SWebBrowser` tab and must be loaded from an allowed origin.

## Allowed Origins

The bridge is exposed as `window.ue.editorwebui` only inside Unreal's embedded browser. Configure the tab to load one of these trusted origins:

- A packaged file under the plugin `Web/` directory.
- `about:blank`.
- A loopback development server, for example `http://localhost:5173`.

Remote production URLs are not accepted by the bridge allowlist. If an external asset library needs to integrate, host a small local Web app or proxy on loopback, then have that app call its remote service from the browser or from its backend.

## Bridge Availability

```js
function getBridge() {
  const bridge = window.ue?.editorwebui;
  if (!bridge) {
    throw new Error("Unreal Editor WebUI bridge is unavailable.");
  }
  return bridge;
}
```

Unreal exposes `UObject` methods in lowercase. The current bridge methods are:

- `executecommand(requestJson)`
- `startcommand(requestJson)`
- `gettask(taskId)`
- `listtasks()`
- `removetask(taskId)`
- `canceltask(taskId)`
- `getwebuisettings()`
- `setwebuisettings(settingsJson)`
- `getwebuihealth()`
- `getprojectcontext()`
- `gettoolcatalog()`

## Web UI Health

`getwebuihealth()` is read-only and takes no arguments. A successful v1 result has exactly these
fields:

```json
{
  "protocolVersion": 1,
  "bridgeProtocolVersion": 1,
  "pluginVersion": "0.2.0",
  "engineVersion": "5.8.0",
  "documentScope": "packaged",
  "pythonRuntime": "available",
  "privilegedConfirmation": "per_call",
  "taskSessionIsolation": "document"
}
```

`documentScope` is only `packaged`, `loopback_http`, `loopback_https`, or `inactive`; it never
contains a URL, hostname, port, path, query, or fragment. The response also excludes project
identity, settings, command and catalog data, task/session/request ids, logs, environment values,
and machine identity. Older plugin builds may not expose the optional method, so clients must treat
its absence as `unsupported` without breaking other bridge operations.

The bundled frontend generates its copied support report from this strictly decoded result and
other already-decoded scalar statuses. Do not construct support output by serializing settings,
project context, command metadata, task records, logs, or generic bridge errors and then attempting
to redact them.

The report is a closed object whose exact top-level keys are `reportVersion`, `product`, `health`,
`native`, `bridge`, `project`, `registry`, `catalog`, `toolPacks`, and `tasks`; `reportVersion` is `2` and
`product` is `unreal-editor-webui`.
`health.overallStatus` is one of `unavailable`, `unsupported`, `checking`, `healthy`, `degraded`,
`unhealthy`, or `error`. Its ordered `reasonCodes` use only these fixed values:

- `health_bridge_unavailable`, `health_method_unavailable`, `health_bridge_checking`,
  `health_transport_invalid`, or `health_request_failed`;
- `health_native_context_invalid`, `health_document_inactive`, or `health_python_unavailable`;
- `health_project_persistence_loading` or `health_project_persistence_unavailable`;
- `health_registry_loading`, `health_registry_unavailable`, or
  `health_registry_modules_rejected`;
- `health_catalog_loading` or `health_catalog_fallback`.
- `health_tool_packs_loading`, `health_tool_packs_unavailable`,
  `health_tool_packs_rejected`, or `health_tool_packs_truncated`.

The `catalog.diagnosticCode` retains the existing bounded catalog reason when fallback is active.
The panel maps every reason to repository-owned fixed text; native/parser exception messages never
enter the report or DOM. A known unhealthy or degraded condition takes precedence over pending
checks; `checking` is used only when every active reason is a loading state.

`toolPacks` has the exact keys `status`, `diagnosticCode`, `statusVersion`, `coreApiVersion`,
`loadedCount`, `rejectedCount`, `truncatedCount`, and `reasonCodes`. It contains no pack id,
provider, plugin name/version, command name, discovery/load exception, or traceback. Its lifecycle
is one of `unavailable`, `loading`, `ready`, `unsupported`, `malformed`, or `error`; diagnostics
and coarse reasons are selected only from repository-owned fixed codes. Reason codes are ordered
from `tool_pack_core_api_mismatch`, `tool_pack_discovery_rejected`, and
`tool_pack_load_rejected` to `tool_pack_status_truncated`. The backend now emits
`system.toolPacks.statusVersion: 2`; the frontend still accepts the legacy v1 shape. Backend v2
reason codes and policy details are reduced to these aggregate support categories, never copied
with pack identities.
While native bridge health is ready, `health_tool_packs_loading` is a checking-only reason. An
unsupported/malformed/failed status request, rejected aggregate count, or truncated aggregate
count maps to one of the other fixed Tool Pack health reasons and degrades overall health. Bridge
unavailability and the existing error/unhealthy precedence remain authoritative.

## Request Envelope

Commands use a JSON request envelope:

```js
const request = {
  id: crypto.randomUUID(),
  command: "asset.listByPath",
  payload: {
    path: "/Game",
    recursive: true,
    limit: 50,
  },
};
```

Every command response uses the same JSON response envelope:

```json
{
  "id": "request-id",
  "ok": true,
  "result": {}
}
```

Errors use `ok: false`:

```json
{
  "id": "request-id",
  "ok": false,
  "error": {
    "code": "invalid_payload",
    "message": "Payload failed schema validation.",
    "details": ["Missing required field: message"]
  }
}
```

## Synchronous Commands

Use `executecommand` for short editor-thread work. It blocks until the command finishes, so keep handlers small.

```js
async function executeCommand(command, payload = {}) {
  const bridge = getBridge();
  const responseJson = await bridge.executecommand(JSON.stringify({
    id: crypto.randomUUID(),
    command,
    payload,
  }));
  const response = JSON.parse(responseJson);
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.result;
}

const project = await executeCommand("editor.projectInfo");
```

## Task Commands

Use `startcommand` when a command should return a task id immediately or when the UI should show progress, logs, cancellation, and final status.

```js
async function startCommand(command, payload = {}) {
  const bridge = getBridge();
  const responseJson = await bridge.startcommand(JSON.stringify({
    id: crypto.randomUUID(),
    command,
    payload,
  }));
  const response = JSON.parse(responseJson);
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.result;
}

const task = await startCommand("demo.longRun", { steps: 10 });
console.log(task.taskId, task.status, task.cancellable);
```

Poll as a recovery path:

```js
async function getTask(taskId) {
  const response = JSON.parse(await getBridge().gettask(taskId));
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.result;
}

const latest = await getTask(task.taskId);
```

Use `listtasks()` only for reconciliation. Its entries deliberately omit request payloads, logs, and `responseJson`; fetch those fields with `gettask(taskId)` only when detail is needed:

```js
const summaryResponse = JSON.parse(await getBridge().listtasks());
const summaries = summaryResponse.result.tasks;
```

Subscribe to pushed task events for low-latency updates:

```js
window.addEventListener("unreal-editor-webui", (event) => {
  const detail = event.detail;
  if (detail.type !== "task.status") {
    return;
  }

  console.log(detail.taskId, detail.status, detail.progress, detail.log);
});
```

Terminal statuses are `completed`, `failed`, `cancelled`, and `timed_out`. Only terminal tasks can be removed:

```js
await getBridge().removetask(task.taskId);
```

Use `canceltask(taskId)` for queued work or cooperative tasks. Running game-thread Python commands are reported as non-cancellable because interrupting Unreal Editor Python execution is unsafe.

Tasks are scoped to the creating top-level document. Reloading or replacing the document rotates the bridge session, cancels queued/cooperative work, and makes earlier task identifiers unavailable to the new page.

## Discover Commands

Fetch command metadata from `system.commands` and build forms from each command schema:

```js
const { metadataVersion, commands, loadErrors } = await executeCommand("system.commands");
if (metadataVersion !== 1) {
  throw new Error(`Unsupported command metadata version: ${metadataVersion}`);
}
for (const command of commands) {
  console.log(command.name, command.permission, command.schema, command.execution);
}
for (const loadError of loadErrors) {
  console.warn(`Command module ${loadError.module} was skipped: ${loadError.error}`);
}
```

`metadataVersion: 1` versions both the command-catalogue shape and the schema contract. Every command entry also carries this version. The payload root is an `object`; every v1 property schema has exactly one type: `object`, `array`, `string`, `integer`, `number`, or `boolean`. Nullable and union types are not supported.

The complete v1 subset consists of root `type`, `properties`, `required`, and boolean `additionalProperties`; property `type`, optional `description`, and a type-compatible `default`; scalar, non-empty, type-compatible `enum`; object `properties`, `required`, and boolean `additionalProperties`; array `items`, `minItems`, and `maxItems`; string `minLength` and `maxLength`; numeric `minimum`, `maximum`, `exclusiveMinimum`, and `exclusiveMaximum`; and `xDryRun` on direct payload boolean properties. Arrays require an `items` schema. Length and item bounds are non-negative integers, numeric bounds are finite, and lower bounds cannot exceed upper bounds. Omitted `additionalProperties` means `true`; schema-valued `additionalProperties` and unknown keywords are rejected.

Defaults must satisfy the complete schema node, including enum, nested item, and bound constraints. The Python registry recursively applies them before validating a payload. This intentionally means a required property with a valid default can be omitted. The cross-layer acceptance and rejection cases are in `tests/fixtures/command-schema-v1.json`.

Modules are registered independently. A schema-contract failure rolls back that module's partial commands and appears in `loadErrors`; healthy modules and their commands remain available. Treat `loadErrors` as visible catalogue diagnostics, not as a reason to discard valid commands.

Tool Pack deployment status is a separate, versioned command so the metadata-v1 catalogue shape
does not change:

```js
const status = await executeCommand("system.toolPacks");
if (status.statusVersion !== 1 && status.statusVersion !== 2) {
  throw new Error(`Unsupported Tool Pack status version: ${status.statusVersion}`);
}
for (const pack of status.packs) {
  console.log(pack.packId, pack.pluginVersion, pack.state, pack.commandCount, pack.commands);
}
```

The bounded response contains sanitized provider, version, API, and state fields plus a sorted
list of owned command names already exposed by `system.commands`. A manifest rejected before its
descriptor is trusted has only a sanitized plugin label, null descriptor fields, and an empty
command list. V2 adds a closed top-level `policy` state and a bounded fixed `reasonCodes` array on
each pack; loaded packs have no reasons. V1 remains decodable without those fields. The response
deliberately omits paths, Python package names, the manifest namespace as a separate field,
exception text, and tracebacks. Use the existing `loadErrors` list for safe detail.
`truncatedCount` is a saturating cumulative count of status observations
omitted across publications; repeated omitted observations increment it again without retaining
an unbounded hidden-provider history.

## Error Codes

Common codes:

- `invalid_request`: request JSON is empty or not an object.
- `invalid_json`: request JSON could not be parsed.
- `invalid_command`: command name is missing or malformed.
- `unknown_command`: command is not registered.
- `invalid_payload`: payload does not match the command schema.
- `permission_denied`: the command requires `write` or `destructive` permission and was not approved.
- `python_unavailable`: Unreal's PythonScriptPlugin is unavailable.
- `python_execution_failed`: the Python dispatch expression could not run.
- `handler_exception`: a command handler raised an exception.
- `task_not_found`, `task_not_finished`, `task_not_cancellable`: task lifecycle errors.
- `request_too_large`, `response_too_large`, `json_too_complex`, `too_many_tasks`: resource limits.

Show the bounded `message` to users and log request ids/error metadata rather than complete successful payloads. Handler tracebacks are written to Unreal logs, not returned to the browser.

Command failures may also include two optional, distinct fields:

- `error.details` is a list of human-readable strings for compact validation or diagnostic context.
- `error.data` is a versioned, discriminated object intended for structured rendering. Protocol version 1 currently accepts only `view: "changeSet"`, with a complete `summary` and at most 200 normalized change operations. Unknown versions, views, or malformed operations must not be passed to UI renderers.

An applied `asset.renameBatch` in which no asset can be changed returns `code: "batch_failed"` and a compact change-set in `error.data`. Direct and task responses use the same shape, so clients can show the per-asset failure table while retaining the error state. The normal 4 MiB direct-response and 1.5 MiB stored-task-response limits still apply.

## Settings From JavaScript

Settings calls are useful for local tool development:

```js
const settingsResponse = JSON.parse(await getBridge().getwebuisettings());
const settings = settingsResponse.result;

await getBridge().setwebuisettings(JSON.stringify({
  useDevServer: true,
  devServerUrl: "http://localhost:5173",
  startupUrl: "",
}));
```

`setwebuisettings` is a privileged write path and requires native confirmation.

## Runtime Tool Catalog

Call `gettoolcatalog()` to resolve the fixed project catalog candidate:

```js
const response = JSON.parse(await getBridge().gettoolcatalog());
const candidate = response.result;
```

The result uses protocol version 1 and has the closed shape
`{ protocolVersion, source, catalog, diagnosticCode }`:

- `source: "project"` carries a parsed JSON object from
  `Config/UnrealEditorWebUI/ToolCatalog.json` and a null diagnostic.
- `source: "missing"` carries a null catalog and diagnostic; use the bundled starter catalog.
- `source: "invalid"` carries a null catalog and one stable diagnostic code; use the bundled
  starter catalog and do not automatically rewrite project preferences.

The native read boundary validates the fixed location, byte/encoding/complexity limits, and JSON
object root. A client must still run the nested `catalog` through the complete closed schema-v1
decoder before making it active. If semantic validation fails, reject the whole candidate and use
the bundled starter. Do not merge individual arrays or fields from rejected input. The first-party
React client exposes only the active source, schema version, fixed relative source label, and a
bounded diagnostic; it never returns or renders an absolute source path or raw parser input.

Calling the getter again explicitly reloads the file. There is no catalog setter, filesystem
watcher, remote source, or arbitrary-path bridge method.

## Project-Scoped Browser Storage

Call `getprojectcontext()` before persisting browser preferences or command history:

```js
const contextResponse = JSON.parse(await getBridge().getprojectcontext());
const { protocolVersion, projectName, storageNamespace } = contextResponse.result;
```

Require `protocolVersion === 1`. `storageNamespace` is a stable, non-sensitive hash for the current project. If the method is missing, fails, or returns an unsupported envelope, keep state in memory and do not fall back to a global local-storage key.

Legacy global preference and history keys are deliberately not migrated automatically because the bridge cannot prove which Unreal project owns them. The project-scoped runtime leaves those keys quarantined and reads and writes only the namespace returned by the current document session.

## Resource Limits

Keep command requests below 256 KiB UTF-8 and direct responses below 4 MiB UTF-8. Stored task responses have a stricter 1.5 MiB UTF-8 limit so the final escaped task-detail envelope remains bounded; terminal events contain summaries and never embed `responseJson`. JSON nesting is limited to 32 levels and 10,000 nodes. Native settings input is limited to 64 Ki characters, task identifiers to 128 characters, retained task count to 64, and cooperative jobs to 64. The project tool catalog is limited to 128 KiB strict UTF-8, 16 JSON levels, and 10,000 structural nodes before its domain-specific array and string limits are applied. Clients should treat `request_too_large`, `response_too_large`, `json_too_complex`, `too_many_tasks`, and catalog diagnostic codes as stable operational outcomes.

