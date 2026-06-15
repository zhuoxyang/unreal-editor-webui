# Development Plan

## Current Baseline

The repository now contains a minimal Unreal Engine 5.5+ editor plugin starter:

- Editor-only plugin descriptor with `WebBrowserWidget` and `PythonScriptPlugin` enabled.
- C++ module that registers `Window > Unreal Editor WebUI`.
- Dockable editor tab powered by `SWebBrowser`.
- `UObject` bridge exposed to JavaScript as `window.ue.editorwebui`.
- Typed JSON command bridge via `executecommand(requestJson)`.
- Task-style command API via `startcommand`, `gettask`, and `removetask`.
- Configurable startup URL support for local packaged UI or a dev server.
- Python command registry with starter commands for ping, project info, logging, and demo execution.
- Static `Web/index.html` smoke-test UI.
- Small Python demo script under `Python/`.

## Near-Term Goals

1. Compile and smoke test inside a real UE 5.5+ project.
2. Add a simple frontend build option, likely React + Vite.
3. Add progress events for long-running tasks.
4. Document plugin installation, rebuild, and troubleshooting steps from a clean UE project.
5. Build a practical asset-tool demo command.

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
- Startup URL can switch between packaged local HTML and a dev server.
- C++ can dispatch to the trusted Python command registry.
- Errors are visible in the Unreal log.
