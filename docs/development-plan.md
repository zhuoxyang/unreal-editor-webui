# Development Plan

## Current Baseline

The repository now contains a minimal Unreal Engine 5.5+ editor plugin starter:

- Editor-only plugin descriptor with `WebBrowserWidget` and `PythonScriptPlugin` enabled.
- C++ module that registers `Window > Unreal Editor WebUI`.
- Dockable editor tab powered by `SWebBrowser`.
- `UObject` bridge exposed to JavaScript as `window.ue.editorwebui`.
- Basic bridge methods for messages, project info, and editor Python execution.
- Static `Web/index.html` smoke-test UI.
- Small Python demo script under `Python/`.

## Near-Term Goals

1. Compile and smoke test inside a real UE 5.5+ project.
2. Replace raw Python string execution with a safer command registry.
3. Add typed JSON request/response routing between Web UI and C++.
4. Add a simple frontend build option, likely React + Vite.
5. Document plugin installation, rebuild, and troubleshooting steps from a clean UE project.

## Design Direction

Keep the first version focused on editor tooling:

- Web UI handles layout and user interaction.
- C++ owns the Unreal-facing bridge and editor tab lifecycle.
- Python handles editor automation, asset workflows, and pipeline tasks.
- Long-running work should move through async command queues instead of blocking the editor thread.

Runtime/game UI support is intentionally out of scope for the initial version.

## Validation Checklist

- Plugin is discovered by UE Editor.
- Editor starts with both required plugins enabled.
- Menu entry appears under `Window`.
- `Web/index.html` loads in the dockable tab.
- JavaScript can call C++ bridge methods.
- C++ can execute a trusted Python command.
- Errors are visible in the Unreal log.
