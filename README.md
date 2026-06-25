# unreal-editor-webui

Build Unreal Engine 5.5+ editor Web UI tools with WebBrowser/SWebBrowser, Python automation, and C++ extension hooks.

## What This Is

`unreal-editor-webui` is a UE Editor plugin starter for building internal tools with:

- `SWebBrowser` for embedded editor Web UI panels.
- A C++ `UObject` bridge exposed to JavaScript as `window.ue.editorwebui`.
- A typed JSON command bridge backed by a Python command registry.
- A React/Vite frontend plus a minimal static HTML fallback.

This project targets editor tooling, not packaged runtime/game UI.

## Current Features

- Adds a `Window > Unreal Editor WebUI` menu entry.
- Opens a dockable editor tab backed by `SWebBrowser`.
- Loads `Web/dist/index.html` when a frontend build exists, otherwise falls back to `Web/index.html`.
- Supports local static Web UI and configurable dev server startup URLs.
- Exposes Web UI startup configuration in `Project Settings > Plugins > Unreal Editor WebUI`.
- Restricts bridge-capable startup and navigation URLs to packaged `Web/` files, `about:blank`, or loopback `http(s)` hosts.
- Exposes synchronous and task-style bridge methods to JavaScript.
- Tracks task progress, logs, cancellation state, execution thread, timeout policy, and bounded cleanup for task-style commands.
- Pushes task status events from C++ to the Web UI with `SWebBrowser::ExecuteJavascript`.
- Shows active/completed task records in a persistent React task panel with progress, logs, cancellation, and cleanup controls.
- Routes commands through `Python/unreal_editor_webui_registry.py`.
- Exposes command metadata through `system.commands`.
- Generates frontend command forms from command metadata and schemas, including bounds, defaults, arrays, and nested objects.
- Supports command search, permission filtering, schema defaults, recent payload reuse, and editable startup settings in the React console.
- Requires confirmation before running `write` or `destructive` commands, including a native editor confirmation in the bridge path.
- Shows command-specific result views for starter asset commands.
- Includes starter commands:
  - `system.commands`
  - `system.ping`
  - `editor.projectInfo`
  - `editor.log`
  - `editor.selectedAssets`
  - `asset.listByPath`
  - `asset.validateNaming`
  - `asset.validateTextureBudget`
  - `asset.scanRedirectors`
  - `asset.renameBatch`
  - `demo.run`
  - `demo.longRun`

## Install In A UE Project

1. Copy or clone this repository into your project's `Plugins/UnrealEditorWebUI` directory.
2. Enable these UE plugins if they are not already enabled:
   - `WebBrowserWidget`
   - `PythonScriptPlugin`
3. Regenerate project files.
4. Build the editor target.
5. Open Unreal Editor and choose `Window > Unreal Editor WebUI`.

## Frontend Development

The React app lives in `frontend/`.

Use Node.js 22.13 or newer, or Node.js 20.19 or newer. The repository includes
an `.nvmrc` pinned to Node.js 22.13.0 for local development.

```sh
cd frontend
npm ci
npm run dev
```

Use the bridge settings to point the editor panel at the Vite dev server:

```ini
[UnrealEditorWebUI]
bUseDevServer=true
DevServerURL=http://localhost:5173
StartupURL=
```

Build the frontend for packaged plugin loading:

```sh
cd frontend
npm run build
```

The build output is written to `Web/dist`. If that folder is missing, the plugin falls back to `Web/index.html`.

## Package The Plugin

Use the repository scripts when packaging. They install the locked frontend dependencies, build the React app, verify `Web/dist/index.html`, and then stage a clean copy of the plugin without local dependency folders such as `frontend/node_modules`.

```sh
bash scripts/package-plugin.sh \
  "/Users/Shared/Epic Games/UE_5.7/Engine/Build/BatchFiles/RunUAT.sh" \
  /tmp/UnrealEditorWebUI-Package
```

On Windows, use the PowerShell script with `RunUAT.bat`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-plugin.ps1 `
  "C:\Program Files\Epic Games\UE_5.7\Engine\Build\BatchFiles\RunUAT.bat" `
  "$env:TEMP\UnrealEditorWebUI-Package"
```

Use the helper scripts for release packages so the React frontend is always rebuilt from the lockfile. Calling `RunUAT BuildPlugin` directly does not build `Web/dist` for you.

See `docs/validation.md` for the latest local validation status.
See `docs/tool-framework.md` for the tool rack manifest, prototype policy, and UE CI runner notes.

## JavaScript Command Example

Inside the embedded browser, Unreal exposes bound `UObject` functions in lowercase:

```js
const request = {
  id: crypto.randomUUID(),
  command: "editor.projectInfo",
  payload: {},
};

const responseJson = await window.ue.editorwebui.executecommand(
  JSON.stringify(request)
);
const response = JSON.parse(responseJson);
```

Response shape:

```json
{
  "id": "request-id",
  "ok": true,
  "result": {}
}
```

Errors use the same envelope with `ok: false` and an `error` object.

## Async Task Example

Use `startcommand` for commands that should return a task id immediately:

```js
const startResponse = JSON.parse(
  await window.ue.editorwebui.startcommand(JSON.stringify(request))
);

const taskId = startResponse.result.taskId;
const task = JSON.parse(await window.ue.editorwebui.gettask(taskId));
await window.ue.editorwebui.removetask(taskId);
```

Use `canceltask(taskId)` for queued work that should not run. `listtasks()` returns retained task records so the React panel can recover after a page reload. Task records expose `cancellable`, `cancellationMode`, `executionThread`, `timeoutPolicy`, and `message` so clients can show whether cancellation is currently available instead of guessing from status alone. The React console keeps started tasks in a task panel and polls them until they reach `completed`, `failed`, `cancelled`, or `timed_out`, so long-running task UI is no longer tied to a short fixed timeout. `removetask(taskId)` only removes terminal tasks.

The current built-in Python command registry is marked as `execution.thread = "editor_game_thread"` with `cancellationMode = "queued_only"` and `timeoutPolicy = "none"`. This is intentional because the starter commands call Unreal Editor APIs that are not safe to invoke from arbitrary background threads. Queued tasks can be cancelled before execution. Once a task enters the running state, the bridge marks it non-cancellable and reports why.

For future long-running workflows, keep the WebUI bridge as the lifecycle/control plane and move only the safe work unit off the editor thread: use an external process, an editor-safe UE async task that marshals Unreal API access back to the game thread, or a cooperative job that periodically persists progress and checks cancellation. Commands that remain editor-thread-bound should stay explicit in metadata and keep handlers short.

Task status changes are also pushed into the browser as DOM events:

```js
window.addEventListener("unreal-editor-webui", (event) => {
  console.log(event.detail.type, event.detail.taskId, event.detail.status);
});
```

The current event type is `task.status`, with statuses such as `queued`, `running`, `completed`, `failed`, `cancelled`, and `timed_out`. Task payloads can include `progress` from 0 to 100, a short `log` line, lifecycle fields, and the final `responseJson`. Cancellation is best-effort and only stops queued tasks; running Python commands cannot be interrupted by the current game-thread task runner.

## Web UI Startup Settings

The easiest path is `Edit > Project Settings > Plugins > Unreal Editor WebUI`. These settings are backed by UE's native settings system and mirrored to the existing per-project editor ini section `UnrealEditorWebUI` for compatibility.

You can also configure the same values directly in ini:

```ini
[UnrealEditorWebUI]
bUseDevServer=true
DevServerURL=http://localhost:5173
StartupURL=
```

If `bUseDevServer` is false and `StartupURL` is empty, the panel loads the packaged `Web/index.html`.

For safety, `DevServerURL` and `StartupURL` only accept empty values, `about:blank`, packaged `file://` URLs under the plugin `Web/` directory, or loopback `http(s)` URLs such as `http://localhost:5173`, `http://127.0.0.1:5173`, or `http://[::1]:5173`. Invalid Project Settings edits show a native warning and are reverted to the last saved value before persistence. Remote URLs are rejected by `setwebuisettings`, ignored when resolving the startup URL, and blocked or redirected if the embedded browser navigates to them.

Settings can also be inspected or updated from JavaScript:

```js
const settings = JSON.parse(await window.ue.editorwebui.getwebuisettings());

await window.ue.editorwebui.setwebuisettings(
  JSON.stringify({ useDevServer: true, devServerUrl: "http://localhost:5173" })
);
```

## Python Command Registry

Register commands in `Python/unreal_editor_webui_registry.py`:

```python
@command(
    "asset.scan",
    description="Scan project assets.",
    permission="read",
    schema={
        "type": "object",
        "properties": {
            "path": {"type": "string"},
        },
        "required": ["path"],
        "additionalProperties": False,
    },
)
def scan_assets(payload):
    return {"count": 0}
```

The registry validates a small JSON-schema-like subset before dispatching. Supported schema features include `required`, `additionalProperties`, `enum`, string `minLength`/`maxLength`, numeric `minimum`/`maximum`, arrays with `items`/`minItems`/`maxItems`, nested object schemas, defaults, and `xDryRun` boolean field markers. Defaults are applied before the handler runs. `write` and `destructive` commands require bridge-supplied exact command capability after native confirmation, so command permissions are not only frontend labels. Confirmed `write` commands are remembered for the current WebUI tab session; `destructive` commands still require confirmation every time. Handler exceptions return concise Web-facing errors while full tracebacks are written to the Unreal log. Keep commands small, explicit, and trusted. Avoid exposing raw Python execution to Web UI pages.

The React frontend reads this metadata from `system.commands` and generates forms for supported field types:

- `string`
- `number`
- `integer`
- `boolean`
- `enum`
- `array` JSON fields
- `object` JSON fields

Forms also surface schema constraints such as min/max values, default values, and dry-run markers. Command cards can be searched, filtered by permission, reset to schema defaults, cleared, or refilled from recent successful payloads.

Starter asset commands include:

- `editor.selectedAssets`: returns assets selected in the Content Browser.
- `asset.listByPath`: lists Asset Registry entries under a content path such as `/Game`.

The frontend renders those asset results as tables instead of raw JSON, while other command results still fall back to a JSON view.

## Roadmap

- Add more command-specific result views and production editor workflows.
- Add tests or a sample host UE project.
