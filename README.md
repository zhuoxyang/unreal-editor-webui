# unreal-editor-webui

Build Unreal Engine editor Web UI tools with WebBrowser/SWebBrowser, Python automation, and C++ extension hooks.

## What This Is

`unreal-editor-webui` is a UE Editor plugin starter for building internal tools with:

- `SWebBrowser` for embedded editor Web UI panels.
- A C++ `UObject` bridge exposed to JavaScript as `window.ue.editorwebui`.
- A typed JSON command bridge backed by a Python command registry.
- A React/Vite frontend plus a minimal static HTML fallback.

This project targets editor tooling, not packaged runtime/game UI.

The current automated build and release target is Unreal Engine 5.8 on Windows. Release eligibility requires successful exact-commit UE 5.8 validation. Results from UE 5.3, UE 5.5, or other platforms are point-in-time evidence only unless they are revalidated for the current commit.

## Current Features

- Adds a `Window > Unreal Editor WebUI` menu entry.
- Opens a dockable editor tab backed by `SWebBrowser`.
- Loads `Web/dist/index.html` when a frontend build exists, otherwise falls back to `Web/index.html`.
- Supports local static Web UI and configurable dev server startup URLs.
- Exposes Web UI startup configuration in `Project Settings > Plugins > Unreal Editor WebUI`.
- Restricts bridge-capable navigation to the exact configured loopback scheme/host/port or packaged `Web/` files.
- Exposes synchronous and task-style bridge methods to JavaScript.
- Tracks task progress, logs, cancellation state, execution thread, timeout policy, and bounded cleanup for task-style commands.
- Pushes task status events from C++ to the Web UI with `SWebBrowser::ExecuteJavascript`.
- Shows active/completed task records in a React task panel with summary reconciliation, lazy detail loading, cancellation, and cleanup controls.
- Routes commands through `Python/unreal_editor_webui_registry.py`.
- Exposes command metadata through `system.commands`.
- Generates frontend command forms from command metadata and schemas, including bounds, defaults, arrays, and nested objects.
- Supports command search, permission filtering, schema defaults, project-scoped recent payload reuse, and editable startup settings in the React console.
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
2. Build the complete React UI before opening the plugin:

   ```sh
   node scripts/validate-npm-lock-registry.mjs frontend/package-lock.json
   cd frontend
   npm ci
   npm run build
   ```

   Verify that `Web/dist/index.html` now exists. The tracked `Web/index.html` is a minimal diagnostic fallback, not the complete React tool UI.
3. Enable these UE plugins if they are not already enabled:
   - `WebBrowserWidget`
   - `PythonScriptPlugin`
4. Regenerate project files.
5. Build the Unreal Engine 5.8 editor target.
6. Open Unreal Editor and choose `Window > Unreal Editor WebUI`.

## Frontend Development

The React app lives in `frontend/`.

Use Node.js 24 from 24.18.1 onward (recommended), or Node.js 22 from 22.22.2 onward. Other Node.js major versions are not accepted by the repository engine policy. The repository includes an `.nvmrc` pinned to Node.js 24.18.1 for local development, packaging, and release tooling.

Node.js 20 is excluded because it is upstream end-of-life, while Node.js 26 remains excluded until it is intentionally added to the CI matrix. Raising the maintained floors also permits the jsdom 30 and jest-dom 7 test stack; `@types/node` stays pinned to the Node 22 line so compiled tooling cannot accidentally depend on Node 24-only APIs.

```sh
node scripts/validate-npm-lock-registry.mjs frontend/package-lock.json
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

The build output is written to `Web/dist`. If that folder is missing, the plugin falls back to the minimal diagnostic page at `Web/index.html`; this fallback does not provide the complete React tool UI.

Repository governance tools use the small root lockfile separately from the frontend. To run the immutable GitHub Actions reference check locally:

```sh
node scripts/validate-npm-lock-registry.mjs package-lock.json
npm ci --ignore-scripts --include=dev --no-audit --no-fund
node --test tests/validate-github-action-references.test.mjs
node scripts/validate-github-action-references.mjs
```

The validator parses YAML 1.2 and requires every external action or reusable workflow to use a full 40-character commit SHA. Local actions and Docker actions remain fail-closed until their nested dependencies have equivalent immutable-reference validation.

## Package The Plugin

Use the repository scripts when packaging. They require one exact full commit SHA, materialize that commit's tracked inputs directly from Git objects, install and build the frontend in an isolated tree, and stage only tracked plugin files plus the newly generated `Web/dist`. Dirty and untracked working-tree files are never package inputs.

```sh
SOURCE_COMMIT="$(git rev-parse --verify 'HEAD^{commit}')"
bash scripts/package-plugin.sh \
  "/path/to/UE_5.8/Engine/Build/BatchFiles/RunUAT.sh" \
  /tmp/UnrealEditorWebUI-Package \
  "$SOURCE_COMMIT"
```

On Windows, use the PowerShell script with `RunUAT.bat`:

```powershell
$SourceCommit = (& git rev-parse --verify "HEAD^{commit}").Trim()
powershell -ExecutionPolicy Bypass -File scripts/package-plugin.ps1 `
  -RunUAT "C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\RunUAT.bat" `
  -PackageDir "$env:TEMP\UnrealEditorWebUI-Package" `
  -SourceCommit $SourceCommit
```

The output directory must not already exist. `BuildPlugin` writes to a private sibling directory. On Windows, the helper publishes it with a no-overwrite directory move; on Unix, it atomically reserves the final name before populating it and moves `SourceManifest.json` last as the completion marker. A concurrently created or stale final path is never overwritten. A successful package includes `SourceManifest.json`, which binds every pre-UBT staged file to either its Git blob in the selected commit or the isolated frontend build. Use the helper scripts for release packages; calling `RunUAT BuildPlugin` directly neither builds `Web/dist` nor establishes this source boundary.

See `docs/validation.md` for the latest local validation status.
See `docs/tool-framework.md` for the tool rack manifest, prototype policy, and UE CI runner notes.
See `docs/ue-ci-runner.md` for reproducible Windows self-hosted runner setup and required-check guidance.
See `docs/release-process.md` for exact-commit UE artifact verification, candidate checksums, SBOMs, and release boundaries.

## Architecture And Integration Docs

- `docs/architecture.md`: full Web UI -> `SWebBrowser` -> C++ bridge -> Python registry -> UE API architecture, including task event pushback.
- `docs/integration-guide.md`: external Web app bridge contract, request/response envelopes, task APIs, error codes, and trusted-origin requirements.

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

Use `canceltask(taskId)` for queued work or a running cooperative task. `listtasks()` returns lifecycle summaries only; request payloads, log arrays, and `responseJson` are available through `gettask(taskId)` when the UI explicitly opens task details. The React console applies pushed `task.status` events immediately and uses a single low-frequency summary reconciliation request to recover from reloads or dropped events. `removetask(taskId)` only removes terminal tasks.

Most built-in commands use `execution.thread = "editor_game_thread"`, `cancellationMode = "queued_only"`, and `timeoutPolicy = "none"` because Unreal Editor Python APIs are not safe to invoke from arbitrary background threads. Queued tasks can be cancelled before execution, while a running game-thread handler cannot be interrupted safely. `demo.longRun` demonstrates the real registry-owned cooperative protocol with `execution.thread = "editor_tick"`, cancellation checks, progress/log updates, cleanup, and a bounded timeout.

For additional long-running workflows, keep the WebUI bridge as the lifecycle/control plane and implement small generator steps that yield progress without blocking an editor tick. Use an external process or an editor-safe UE async task for CPU-heavy work, and marshal Unreal API access back to the game thread. Commands that remain editor-thread-bound should stay explicit in metadata and keep handlers short.

Task status changes are also pushed into the browser as DOM events:

```js
window.addEventListener("unreal-editor-webui", (event) => {
  console.log(event.detail.type, event.detail.taskId, event.detail.status);
});
```

The current event type is `task.status`, with statuses such as `queued`, `running`, `completed`, `failed`, `cancelled`, and `timed_out`. Events contain bounded lifecycle updates; clients fetch final detail through `gettask()`. Cancellation is immediate for queued work, cooperative at the next step for `editor_tick` handlers, and unavailable once an editor-game-thread Python handler is running.

## Web UI Startup Settings

The easiest path is `Edit > Project Settings > Plugins > Unreal Editor WebUI`. These settings are backed by UE's native settings system and mirrored to the existing per-project editor ini section `UnrealEditorWebUI` for compatibility.

You can also configure the same values directly in ini:

```ini
[UnrealEditorWebUI]
bUseDevServer=true
DevServerURL=http://localhost:5173
StartupURL=
```

If `bUseDevServer` is false and `StartupURL` is empty, the panel loads `Web/dist/index.html` when present and otherwise uses the minimal `Web/index.html` diagnostic fallback.

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

`system.commands.metadataVersion` and every command entry's `metadataVersion` are the version of both the command-catalogue shape and its schema contract. Version 1 uses a strict JSON-schema-like subset. Every property schema declares exactly one of `object`, `array`, `string`, `integer`, `number`, or `boolean`; `null` and union types are not supported. The complete v1 keyword set is:

- payload root: `type: "object"`, `properties`, `required`, and boolean `additionalProperties`
- property schemas: `type`, optional `description`, a type-compatible `default`, and, for scalar types, a non-empty type-compatible `enum`
- objects: `properties`, `required`, and boolean `additionalProperties` (omission means `true`; schema-valued `additionalProperties` is not supported)
- arrays: required `items` plus non-negative integer `minItems` and `maxItems`
- strings: non-negative integer `minLength` and `maxLength`
- integers and numbers: finite `minimum`, `maximum`, `exclusiveMinimum`, and `exclusiveMaximum`
- direct payload boolean properties: optional boolean `xDryRun`

Unknown keywords, incompatible constraints, invalid defaults, inverted bounds, and required names that are not declared properties fail registration. Defaults are recursively applied before payload validation, so a required property with a valid default may be omitted by the caller. The shared executable contract examples live in `tests/fixtures/command-schema-v1.json`.

Command modules are loaded independently. If a module violates the v1 contract, its partial registrations are rolled back and `system.commands.loadErrors` reports the module and error; commands from healthy modules remain available. Consumers should surface these diagnostics instead of treating them as a failure of the entire catalogue.

`write` and `destructive` commands require a bridge-supplied exact-command capability after native confirmation, so command permissions are not only frontend labels. Every real privileged invocation receives a fresh, payload-specific confirmation; approvals are never cached or reusable, and a dry run cannot authorize a later write. Handler exceptions return concise Web-facing errors while full tracebacks are written to the Unreal log. Keep commands small, explicit, and trusted. Avoid exposing raw Python execution to Web UI pages.

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
- Expand the GUI CEF automation matrix when additional engine/platform targets are intentionally maintained.

## License

This project is distributed under the [MIT License](LICENSE).
