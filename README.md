# unreal-editor-webui

Build Unreal Engine editor Web UI tools with WebBrowser/SWebBrowser, Python automation, and C++ extension hooks.

## What This Is

`unreal-editor-webui` is a UE Editor plugin starter for building internal tools with:

- `SWebBrowser` for embedded editor Web UI panels.
- A C++ `UObject` bridge exposed to JavaScript as `window.ue.editorwebui`.
- A typed JSON command bridge backed by a Python command registry.
- A React/Vite frontend plus a minimal static HTML fallback.

This project targets editor tooling, not packaged runtime/game UI.

The maintained native release matrix is Windows UE 5.4.4, UE 5.5.4, and UE 5.8.0. Each minor
version has its own compiled archive and exact engine BuildId; the archives are not
cross-compatible or universal:

| Project engine | Native variant | Exact BuildId | Distribution filename suffix |
| --- | --- | --- | --- |
| UE 5.4 | `UE54-Win64` | `33043543` | `-UE54-Win64.zip` |
| UE 5.5 | `UE55-Win64` | `37670630` | `-UE55-Win64.zip` |
| UE 5.8 | `UE58-Win64` | `55116800` | `-UE58-Win64.zip` |

This is the checked-in compatibility and CI contract, not a claim that the current commit has
already passed licensed-engine validation. Release eligibility requires all three protected,
exact-commit GUI jobs from one trusted run attempt. Static tests or a previous local UE run do not
replace those results.

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
- Discovers commands from independent Tool Pack payloads in content-only or existing code plugins
  through the stable `unreal_editor_webui_sdk` API, so many tools can share one installed core plugin.
- Exposes command metadata through `system.commands` and bounded provider status through
  `system.toolPacks`.
- Generates frontend command forms from command metadata and schemas, including bounds, defaults, arrays, and nested objects.
- Supports command search, permission filtering, schema defaults, project-scoped recent payload reuse, and editable startup settings in the React console.
- Loads an optional schema-v1 project/stage/category catalog at runtime from the fixed project
  `Config/UnrealEditorWebUI/ToolCatalog.json` path, with strict validation and a safe bundled fallback.
- Requires confirmation before running `write` or `destructive` commands, including a native editor confirmation in the bridge path.
- Shows command-specific result views for starter asset commands.
- Includes starter commands:
  - `system.commands`
  - `system.toolPacks`
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

### Prebuilt Plugin (Recommended)

1. Download the native plugin ZIP matching the project's UE minor version and its `.sha256`
   sidecar from your reviewed distribution channel:
   - `UnrealEditorWebUI-v...-UE54-Win64.zip` for UE 5.4.
   - `UnrealEditorWebUI-v...-UE55-Win64.zip` for UE 5.5.
   - `UnrealEditorWebUI-v...-UE58-Win64.zip` for UE 5.8.

   The repository's release-candidate workflow produces review artifacts only; it does not publish
   a GitHub Release automatically.
2. Verify the archive before extracting it. On Windows:

   ```powershell
   Get-FileHash .\UnrealEditorWebUI-*-UE55-Win64.zip -Algorithm SHA256
   ```

   Replace `UE55` with the selected variant and compare the printed hash with the matching checksum
   file. Do not install a ZIP produced for another UE minor version.
3. Extract the archive's `UnrealEditorWebUI` directory to
   `<Project>/Plugins/UnrealEditorWebUI`.
4. Open the project, enable `UnrealEditorWebUI` if prompted, and restart the editor. Its plugin
   descriptor enables `WebBrowserWidget` and `PythonScriptPlugin`.
5. Choose `Window > Unreal Editor WebUI`, run `system.ping`, and confirm that it returns `pong`.

The v0.3.0 prebuilt archives include the Tool Pack loader and stable SDK API 1. Install each Tool
Pack as a separate UE plugin beside the shared core, enable it in the project, update the core's
opt-in trust allowlist when required, and restart Unreal after every pack or policy change.

### Build From Source

Source development additionally requires a supported Node.js version, Visual Studio 2022 with
the C++ toolchain and Windows SDK, and a source-capable project for the selected UE 5.4, 5.5, or
5.8 version.

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
5. Build the editor target with the same UE minor version that will load the plugin.
6. Open Unreal Editor and choose `Window > Unreal Editor WebUI`.

Optional: copy [`docs/examples/tool-catalog.v1.json`](docs/examples/tool-catalog.v1.json) to
`<Project>/Config/UnrealEditorWebUI/ToolCatalog.json` and edit its validated display data to
configure the rack without rebuilding the React bundle. The catalog cannot add or authorize
commands; Python command registration and native permission checks remain authoritative.

To add separately distributed commands without modifying this repository, install one or more
[third-party Tool Packs](docs/tool-packs.md) alongside the core plugin.

### Rez External Plugin Roots

Studios that already use Rez can package the shared precompiled core once and resolve independent
Tool Pack packages without copying any plugin into `<Project>/Plugins`. The checked-in recipes cover
the exact UE 5.4.4, 5.5.4, and 5.8.0 Windows x64 variants, append their own plugin roots to
`UE_ADDITIONAL_PLUGIN_PATHS`, and require fixed local archive and final-tree hashes. Production
launches must use the installed `uewebui-rez-launch` preflight wrapper; launching the editor directly
bypasses duplicate-core, wrong-variant, and payload-integrity protection.

See [Rez packaging](docs/rez-packaging.md) for the recipes, central payload lock, aggregate pins,
external-only project descriptor, build/resolve commands, two-process E2E, and validation boundary.
The v0.3.0 core recipe and every aggregate/Tool Pack dependency pin match the published plugin
descriptor; do not mix a recipe or Tool Pack dependency with a different core version.

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

Production frontend output is pinned to `chrome90`/ES2020 because UE 5.4 and UE 5.5 embed
Chromium 90, while UE 5.8 embeds Chromium 128. Raising the Vite target requires intentionally
changing the maintained engine floor and its contract tests.

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

The commands above use UE 5.8 as an example. Use the matching `UE_5.4` or `UE_5.5` RunUAT path to
produce those native variants; one BuildPlugin output must never be renamed and reused as another
variant.

The output directory must not already exist. On Windows, `BuildPlugin` writes to a short random directory under the system temp root when that root is on the output volume, avoiding UnrealBuildTool's 260-character action-path limit; the helper then publishes it with a same-volume, no-overwrite directory move. On Unix, `BuildPlugin` writes to a private sibling, the helper atomically reserves the final name before populating it, and `SourceManifest.json` moves last as the completion marker. A concurrently created or stale final path is never overwritten. A successful package includes `SourceManifest.json`, which binds every pre-UBT staged file to either its Git blob in the selected commit or the isolated frontend build. Use the helper scripts for release packages; calling `RunUAT BuildPlugin` directly neither builds `Web/dist` nor establishes this source boundary.

See `docs/validation.md` for the latest local validation status.
See `docs/tool-framework.md` for the project catalog, prototype policy, and UE CI runner notes.
See `docs/tool-packs.md` for the stable third-party Python SDK, manifest, offline validator,
scaffolder, and multi-pack installation model.
See `docs/ue-ci-runner.md` for reproducible Windows self-hosted runner setup and required-check guidance.
See `docs/release-process.md` for exact-commit UE artifact verification, candidate checksums,
frontend npm dependency metadata, signed provenance, and release boundaries.
See `docs/rez-packaging.md` for offline Rez recipes, external plugin-root activation, and payload locks.

The protected workflow's temporary host removes packaged plugin `Source` and `Intermediate` before
tests and rejects recompilation markers. This is a binary-only simulation on a build machine, not
a clean no-compiler/no-Node consumer result. A release still requires independent clean-VM positive
installs and cross-version rejection tests.

## Architecture And Integration Docs

- `docs/architecture.md`: full Web UI -> `SWebBrowser` -> C++ bridge -> Python registry -> UE API architecture, including task event pushback.
- `docs/integration-guide.md`: external Web app bridge contract, request/response envelopes, task APIs, error codes, and trusted-origin requirements.
- `docs/tool-packs.md`: third-party plugin contract and offline validator for sharing one core
  WebUI across multiple tools.

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

## Health and Support Report

The workspace header includes a health status control. It checks the optional
`getwebuihealth()` bridge method and reports only categorical runtime state: public plugin and
`major.minor.patch` engine versions, packaged or loopback document scope, Python availability,
per-call privileged confirmation, document-session task isolation, project persistence, catalog
fallback, command discovery counts, and a strictly decoded Tool Pack deployment view. The Tool
Pack view strictly decodes the bounded public v1/v2 provider status and gives static restart
guidance because packs are discovered only during registry initialization. Projects can opt in to
an exact Tool Pack allowlist at `Config/UnrealEditorWebUI/ToolPackPolicy.json`; the core verifies
pack id, plugin version, required core API, and the canonical payload-tree hash before importing
that pack's declared schema-v2 entry modules.

The generated schema-v2 support report is built from an explicit frontend allowlist and is capped
at 4 KiB UTF-8. Its `health.overallStatus` and ordered `health.reasonCodes` are derived from the
same decoded snapshot shown by the panel. It never copies settings, URLs, paths, project names or
namespaces, catalog or command contents, module errors, task ids, payloads, responses, logs, raw
bridge errors, Tool Pack/provider/plugin/command identities, host identity, or credentials. Its
`toolPacks` member contains only lifecycle/diagnostic codes, schema/core API versions, aggregate
loaded/rejected/truncated counts, and fixed coarse reason codes. The report is not uploaded or persisted. If CEF
cannot grant clipboard access, the read-only preview is selected for manual copying instead.
Tool Pack loading contributes a fixed checking reason to aggregate health. An unavailable,
unsupported, malformed, or failed status check, any rejected pack, or truncated status history
contributes a fixed degraded reason; bridge-unavailable and other higher-priority health states
keep their existing precedence.

## Python Commands And Tool Packs

Built-in commands live under `Python/unreal_editor_webui_commands`. Third-party commands should
live in a dedicated Tool Pack or an existing business plugin and import the stable SDK; they must
not edit or import the internal registry directly:

```python
from unreal_editor_webui_sdk import command


@command(
    "studio.assets.scan",
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

The Tool Pack manifest declares and enforces the `studio.assets` namespace. Command names are
dotted ASCII identifiers with at least two segments, a 256-character maximum, and a lowercase
letter at the start of every segment; later characters may be letters, digits, or underscores.
Declared namespaces may not be equal to, an ancestor of, or a descendant of another Tool Pack's
namespace. See
[`docs/tool-packs.md`](docs/tool-packs.md) for the fixed plugin layout, scaffold command,
compatibility contract, whole-pack rollback behavior, and multi-pack installation steps.

Release authors can create a fresh deterministic ZIP, canonical manifest, and SHA-256 sidecar with
`python scripts/package-tool-pack.py`. Recipients can run the read-only
`python scripts/tool-pack-doctor.py` against explicit project, engine, and external plugin roots;
the doctor never imports pack code or launches Unreal. Native-code packs require an explicit
matching engine root, while explicit `NoCode: true` content packs remain engine-variant independent.

`system.commands.metadataVersion` and every command entry's `metadataVersion` are the version of both the command-catalogue shape and its schema contract. Version 1 uses a strict JSON-schema-like subset. Every property schema declares exactly one of `object`, `array`, `string`, `integer`, `number`, or `boolean`; `null` and union types are not supported. The complete v1 keyword set is:

- payload root: `type: "object"`, `properties`, `required`, and boolean `additionalProperties`
- property schemas: `type`, optional `description`, a type-compatible `default`, and, for scalar types, a non-empty type-compatible `enum`
- objects: `properties`, `required`, and boolean `additionalProperties` (omission means `true`; schema-valued `additionalProperties` is not supported)
- arrays: required `items` plus non-negative integer `minItems` and `maxItems`
- strings: non-negative integer `minLength` and `maxLength`
- integers and numbers: finite `minimum`, `maximum`, `exclusiveMinimum`, and `exclusiveMaximum`
- direct payload boolean properties: optional boolean `xDryRun`

Unknown keywords, incompatible constraints, invalid defaults, inverted bounds, and required names that are not declared properties fail registration. Defaults are recursively applied before payload validation, so a required property with a valid default may be omitted by the caller. The shared executable contract examples live in `tests/fixtures/command-schema-v1.json`.

Built-in command modules are loaded independently. A third-party Tool Pack is loaded atomically:
if any of its modules violates the contract, every registration from that pack is rolled back.
`system.commands.loadErrors` reports the bounded diagnostic while commands from healthy packs and
core modules remain available. Consumers should surface these diagnostics instead of treating
them as a failure of the entire catalogue.

`system.toolPacks` keeps deployment diagnostics separate from command metadata. The backend emits
status v2 with a closed project-policy state and bounded fixed reason codes; the frontend also
accepts the legacy v1 response during migration. Its versioned, bounded result reports each
accepted descriptor's sanitized identity, plugin version, required core API, state, owned-command
count, and stable list of owned command names. Those names are
already public in `system.commands` and make provider ownership inspectable. If discovery rejects
a manifest before a descriptor can be trusted, only the sanitized plugin label and `rejected`
state are present; descriptor fields are `null` and `commands` is empty. It never returns package
paths, Python package names, the manifest namespace as a separate field, exceptions, or
tracebacks; detailed rejection reasons remain in the bounded `system.commands.loadErrors` list and
the full traceback remains only in the Unreal log.

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
