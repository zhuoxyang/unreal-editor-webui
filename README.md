# unreal-editor-webui

Build Unreal Engine 5.5+ editor Web UI tools with WebBrowser/SWebBrowser, Python automation, and C++ extension hooks.

## What This Is

`unreal-editor-webui` is a UE Editor plugin starter for building internal tools with:

- `SWebBrowser` for embedded editor Web UI panels.
- A C++ `UObject` bridge exposed to JavaScript as `window.ue.editorwebui`.
- Python Editor Script Plugin integration for editor automation commands.
- A minimal local HTML page for smoke testing the bridge.

This project targets editor tooling, not packaged runtime/game UI.

## Current Features

- Adds a `Window > Unreal Editor WebUI` menu entry.
- Opens a dockable editor tab backed by `SWebBrowser`.
- Loads `Web/index.html` from the plugin folder.
- Exposes C++ bridge methods to JavaScript:
  - `postmessage(payload)`
  - `getprojectname()`
  - `getprojectdir()`
  - `executepython(pythonCode)`
- Includes a small Python demo script in `Python/unreal_editor_webui_demo.py`.

## Install In A UE Project

1. Copy or clone this repository into your project's `Plugins/UnrealEditorWebUI` directory.
2. Enable these UE plugins if they are not already enabled:
   - `WebBrowserWidget`
   - `PythonScriptPlugin`
3. Regenerate project files.
4. Build the editor target.
5. Open Unreal Editor and choose `Window > Unreal Editor WebUI`.

## JavaScript Bridge Example

Inside the embedded browser, Unreal exposes bound `UObject` functions in lowercase:

```js
await window.ue.editorwebui.postmessage(JSON.stringify({ type: "hello" }));

const projectName = await window.ue.editorwebui.getprojectname();

await window.ue.editorwebui.executepython(
  "import unreal\nunreal.log('Hello from WebUI')"
);
```

Only run trusted local Web UI through `executepython`, because it executes editor Python code.

## Roadmap

- Add typed JSON request/response routing.
- Add a Python command registry instead of raw Python string execution.
- Add optional React/Vite frontend template.
- Add tests or a sample host UE project.
