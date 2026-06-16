# Development Plan

## Current Baseline

The repository now contains a minimal Unreal Engine 5.5+ editor plugin starter:

- Editor-only plugin descriptor with `WebBrowserWidget` and `PythonScriptPlugin` enabled.
- C++ module that registers `Window > Unreal Editor WebUI`.
- Dockable editor tab powered by `SWebBrowser`.
- `UObject` bridge exposed to JavaScript as `window.ue.editorwebui`.
- Typed JSON command bridge via `executecommand(requestJson)`.
- Task-style command API via `startcommand`, `gettask`, and `removetask`.
- Task status events pushed from C++ into the browser through `SWebBrowser::ExecuteJavascript`.
- Configurable startup URL support for local packaged UI or a dev server.
- Python command registry with command metadata, permission labels, and payload schema validation.
- React/Vite frontend that discovers commands, generates simple schema forms, and builds into `Web/dist`.
- Confirmation guard for `write` and `destructive` commands launched from generated forms.
- Command-specific table result views for starter asset commands.
- Clean package script that stages the plugin without local frontend dependencies.
- Starter asset commands for selected Content Browser assets and Asset Registry path listing.
- Static `Web/index.html` smoke-test UI.
- Small Python demo script under `Python/`.

## Near-Term Goals

1. Compile and smoke test inside a real UE 5.5+ project.
2. Add progress percentages and log streaming for long-running tasks.
3. Add more command-specific result renderers for validation reports.
4. Document plugin installation, rebuild, and troubleshooting steps from a clean UE project.
5. Expand the asset-tool demo with validation and batch operations.

## Design Direction

Keep the first version focused on editor tooling:

- Web UI handles layout and user interaction.
- C++ owns the Unreal-facing bridge and editor tab lifecycle.
- Python handles editor automation, asset workflows, and pipeline tasks through explicit command handlers.
- Long-running work should expose task state and progress; truly heavy work should move out of blocking editor Python handlers.

Runtime/game UI support is intentionally out of scope for the initial version.

## Validation Checklist

- Plugin is discovered by UE Editor.
- Editor starts with both required plugins enabled.
- Menu entry appears under `Window`.
- `Web/index.html` loads in the dockable tab.
- JavaScript can call `executecommand` with a JSON request.
- JavaScript can start a task and poll it until completion.
- JavaScript can receive pushed task status events.
- Startup URL can switch between packaged local HTML and a dev server.
- C++ can dispatch to the trusted Python command registry.
- React frontend can build successfully into `Web/dist`.
- Package script can build the plugin without copying local `node_modules`.
- Invalid payloads are rejected before command handlers run.
- Frontend can generate runnable forms from command metadata.
- Asset demo commands return useful editor data.
- `write` and `destructive` command launches require confirmation.
- Starter asset results render as tables.
- Errors are visible in the Unreal log.
