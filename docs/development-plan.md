# Development Plan

## Current Baseline

The repository now contains a minimal Unreal Engine 5.5+ editor plugin starter:

- Editor-only plugin descriptor with `WebBrowserWidget` and `PythonScriptPlugin` enabled.
- C++ module that registers `Window > Unreal Editor WebUI`.
- Dockable editor tab powered by `SWebBrowser`.
- `UObject` bridge exposed to JavaScript as `window.ue.editorwebui`.
- Typed JSON command bridge via `executecommand(requestJson)`.
- Task-style command API via `startcommand`, `gettask`, `canceltask`, and `removetask`.
- Task status, progress, log, cancellation, and cleanup APIs pushed from C++ into the browser through `SWebBrowser::ExecuteJavascript`.
- Configurable startup URL support for local packaged UI or loopback dev servers.
- Native settings surface under `Project Settings > Plugins > Unreal Editor WebUI`, mirrored to the legacy ini keys.
- Unsafe browser navigation is redirected back to the last allowed bridge URL.
- Python command registry with command metadata, permission labels, recursive payload schema validation, defaults, and dry-run markers.
- React/Vite frontend that discovers commands, generates schema-aware forms, filters command lists, and builds into `Web/dist`.
- Frontend and native editor confirmation guards for `write` and `destructive` commands.
- Exact command capability policy for privileged command execution.
- Bounded task storage with cleanup for completed task records.
- Command-specific table result views for starter asset commands.
- Recent payload reuse and schema-default presets in the command console.
- Clean package script that stages the plugin without local frontend dependencies.
- Starter asset commands for selected Content Browser assets and Asset Registry path listing.
- Static `Web/index.html` smoke-test UI.
- Small Python demo script under `Python/`.

## Near-Term Goals

1. Compile and smoke test inside a real UE 5.5+ project.
2. Add more command-specific result renderers for validation reports.
3. Document plugin installation, rebuild, and troubleshooting steps from a clean UE project.
4. Expand the asset-tool demo with validation and batch operations.
5. Add optional validation/status widgets for Web UI startup and bridge safety options.

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
- JavaScript can cancel queued tasks and inspect task progress/log lines.
- JavaScript can receive pushed task status events.
- Startup URL can switch between packaged local HTML and a loopback dev server.
- Startup settings are discoverable under `Project Settings > Plugins > Unreal Editor WebUI`.
- Existing `[UnrealEditorWebUI]` ini keys continue to be read and written by bridge APIs.
- Invalid Project Settings URL edits are reverted before being persisted.
- Unsafe remote, `javascript:`, or `data:` startup URLs are rejected.
- Unsafe browser navigation is redirected away after URL changes.
- C++ can dispatch to the trusted Python command registry.
- React frontend can build successfully into `Web/dist`.
- Package script can build the plugin without copying local `node_modules`.
- Invalid payloads are rejected before command handlers run.
- Privileged commands are rejected unless the bridge grants exact command capability.
- Frontend can generate runnable forms from command metadata.
- Frontend can search commands, filter by permission, load schema defaults, and reuse recent payloads.
- Python registry validates nested objects, arrays, numeric bounds, string bounds, defaults, and dry-run schema markers.
- Asset demo commands return useful editor data.
- `write` and `destructive` command launches require confirmation.
- Starter asset results render as tables.
- Errors are visible in the Unreal log.
- Web-facing Python handler errors do not include full tracebacks by default.
