# unreal-editor-webui

Build Unreal Engine 5.5+ editor Web UI tools with WebBrowser/SWebBrowser, Python automation, and C++ extension hooks.

## What This Is

`unreal-editor-webui` is a UE Editor plugin starter for building internal tools with:

- `SWebBrowser` for embedded editor Web UI panels.
- A C++ `UObject` bridge exposed to JavaScript as `window.ue.editorwebui`.
- A typed JSON command bridge backed by a Python command registry.
- A minimal local HTML page for smoke testing the bridge.

This project targets editor tooling, not packaged runtime/game UI.

## Current Features

- Adds a `Window > Unreal Editor WebUI` menu entry.
- Opens a dockable editor tab backed by `SWebBrowser`.
- Loads `Web/index.html` from the plugin folder.
- Exposes `executecommand(requestJson)` to JavaScript.
- Routes commands through `Python/unreal_editor_webui_registry.py`.
- Includes safe starter commands:
  - `system.ping`
  - `editor.projectInfo`
  - `editor.log`
  - `demo.run`

## Install In A UE Project

1. Copy or clone this repository into your project's `Plugins/UnrealEditorWebUI` directory.
2. Enable these UE plugins if they are not already enabled:
   - `WebBrowserWidget`
   - `PythonScriptPlugin`
3. Regenerate project files.
4. Build the editor target.
5. Open Unreal Editor and choose `Window > Unreal Editor WebUI`.

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

## Python Command Registry

Register commands in `Python/unreal_editor_webui_registry.py`:

```python
@command("asset.scan")
def scan_assets(payload):
    return {"count": 0}
```

Keep commands small, explicit, and trusted. Avoid exposing raw Python execution to Web UI pages.

## Roadmap

- Add async command execution and progress events.
- Add optional React/Vite frontend template.
- Add tests or a sample host UE project.
