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
- Restricts bridge-capable startup URLs to packaged `Web/` files, `about:blank`, or loopback `http(s)` hosts.
- Exposes synchronous and task-style bridge methods to JavaScript.
- Pushes task status events from C++ to the Web UI with `SWebBrowser::ExecuteJavascript`.
- Routes commands through `Python/unreal_editor_webui_registry.py`.
- Exposes command metadata through `system.commands`.
- Generates frontend command forms from command metadata and schemas.
- Requires confirmation before running `write` or `destructive` commands, including a native editor confirmation in the bridge path.
- Shows command-specific result views for starter asset commands.
- Includes safe starter commands:
  - `system.commands`
  - `system.ping`
  - `editor.projectInfo`
  - `editor.log`
  - `editor.selectedAssets`
  - `asset.listByPath`
  - `demo.run`

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

```sh
cd frontend
npm install
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

Use the repository script when packaging after frontend development. It stages a clean copy of the plugin and excludes local dependency folders such as `frontend/node_modules`.

```sh
bash scripts/package-plugin.sh \
  "/Users/Shared/Epic Games/UE_5.7/Engine/Build/BatchFiles/RunUAT.sh" \
  /tmp/UnrealEditorWebUI-Package
```

You can still run `RunUAT BuildPlugin` directly from a clean checkout, but the script is safer after `npm install`.

See `docs/validation.md` for the latest local validation status.

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

The current task runner queues work back onto the editor game thread before calling Python. It is useful for request lifecycle and polling, but long Python handlers can still block the editor while they execute. Heavy work should eventually move to dedicated background workers or external processes.

Task status changes are also pushed into the browser as DOM events:

```js
window.addEventListener("unreal-editor-webui", (event) => {
  console.log(event.detail.type, event.detail.taskId, event.detail.status);
});
```

The current event type is `task.status`, with statuses such as `queued`, `running`, `completed`, and `failed`.

## Web UI Startup Settings

The plugin reads startup settings from the per-project editor ini section `UnrealEditorWebUI`:

```ini
[UnrealEditorWebUI]
bUseDevServer=true
DevServerURL=http://localhost:5173
StartupURL=
```

If `bUseDevServer` is false and `StartupURL` is empty, the panel loads the packaged `Web/index.html`.

For safety, `DevServerURL` and `StartupURL` only accept empty values, `about:blank`, packaged `file://` URLs under the plugin `Web/` directory, or loopback `http(s)` URLs such as `http://localhost:5173`, `http://127.0.0.1:5173`, or `http://[::1]:5173`. Remote URLs are rejected by `setwebuisettings` and ignored when resolving the startup URL.

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

The registry validates a small JSON-schema-like subset before dispatching. `write` and `destructive` commands require bridge-supplied permission policy after native confirmation, so command permissions are not only frontend labels. Keep commands small, explicit, and trusted. Avoid exposing raw Python execution to Web UI pages.

The React frontend reads this metadata from `system.commands` and generates basic forms for supported field types:

- `string`
- `number`
- `integer`
- `boolean`
- `enum`

Starter asset commands include:

- `editor.selectedAssets`: returns assets selected in the Content Browser.
- `asset.listByPath`: lists Asset Registry entries under a content path such as `/Game`.

The frontend renders those asset results as tables instead of raw JSON, while other command results still fall back to a JSON view.

## Roadmap

- Verify `BuildPlugin` with a local UE 5.5 install.
- Add progress percentages/log streaming for long-running tasks.
- Add richer schema support and more command result views.
- Add tests or a sample host UE project.
