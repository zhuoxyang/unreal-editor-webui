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

## Discover Commands

Fetch command metadata from `system.commands` and build forms from each command schema:

```js
const { commands } = await executeCommand("system.commands");
for (const command of commands) {
  console.log(command.name, command.permission, command.schema, command.execution);
}
```

The registry supports a small JSON-schema-like subset: `required`, `additionalProperties`, `enum`, string length bounds, numeric bounds, arrays, nested objects, defaults, and `xDryRun` markers. Defaults are applied by the Python registry before command handlers run.

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

Show the `message` to users, and log the full response envelope for debugging. Handler tracebacks are written to Unreal logs, not returned to the browser.

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

