# Rez Packaging

This repository contains an offline Rez packaging contract for one shared
`UnrealEditorWebUI` core and independently versioned Tool Packs. It targets only Windows x64 and
the three exact native identities in `scripts/ue-release-variants.json`:

| Rez core variant | Native payload | Engine BuildId |
| --- | --- | --- |
| `unreal_engine==5.4.4` | `UE54-Win64` | `33043543` |
| `unreal_engine==5.5.4` | `UE55-Win64` | `37670630` |
| `unreal_engine==5.8.0` | `UE58-Win64` | `55116800` |

The variants are not interchangeable. The core recipe is currently `0.2.0` so it matches the
checked-in plugin descriptor while this feature is being reviewed. The release tracked by issue
#117 must atomically change the descriptor, core recipe, both Tool Pack core requirements, and all
aggregate core pins to `0.3.0`. A `0.2.0` Rez build from this branch is not the promised v0.3.0
binary release.

## Packages

- `rez/packages/unreal_editor_webui` is the shared precompiled core. Its three Rez variants select
  the engine requirement; users cannot select a payload through an arbitrary environment value.
- `rez/packages/unreal_editor_webui_asset_tools` and
  `rez/packages/unreal_editor_webui_level_tools` are independent content-only example Tool Packs.
  They demonstrate separate versions, manifests, archives, receipts, and rollback.
- `rez/packages/unreal_editor_webui_project` is an optional aggregate request. Each of its three
  variants pins one exact engine, core `0.2.0`, and both Tool Packs `1.0.0`.

Each package appends its own `<root>/Plugins` directory to `UE_ADDITIONAL_PLUGIN_PATHS`; it never
replaces paths contributed by other packages. The core also exposes `UNREAL_EDITOR_WEBUI_ROOT`,
`UNREAL_EDITOR_WEBUI_REZ_RECEIPT`, and the mandatory `uewebui-rez-launch` and
`uewebui-rez-preflight` tools. Each example pack exposes its own convenience root and receipt.

## Immutable Local Inputs

Recipes never download, compile, invoke UAT, run npm, or install Python dependencies. A build must
receive all three already-precompiled core ZIPs and both already-packaged Tool Pack ZIPs through an
explicit local payload directory and a canonical payload lock:

```powershell
$Payloads = "D:\reviewed\unreal-editor-webui-payloads"
$Lock = "D:\reviewed\unreal-editor-webui-payload-lock.json"

python scripts\rez-package.py create-lock `
  --core "ue54=$Payloads\UnrealEditorWebUI-v0.2.0-UE54-Win64.zip" `
  --core "ue55=$Payloads\UnrealEditorWebUI-v0.2.0-UE55-Win64.zip" `
  --core "ue58=$Payloads\UnrealEditorWebUI-v0.2.0-UE58-Win64.zip" `
  --tool-pack "unreal_editor_webui_asset_tools=$Payloads\AssetToolsFixture-v1.0.0.zip" `
  --tool-pack "unreal_editor_webui_level_tools=$Payloads\LevelToolsFixture-v1.0.0.zip" `
  --output $Lock
```

Use the actual filenames emitted by `scripts/package-tool-pack.py`; the example names above only
show the assignment shape. `create-lock` accepts exactly the closed variant and recipe sets. It
safely extracts every ZIP, validates the descriptor and `Binaries/Win64/UnrealEditor.modules`
BuildId/DLL mapping, validates each Tool Pack distribution manifest, and records both the archive
SHA-256 and a canonical final-tree SHA-256. The tree digest is calculated over sorted records as
`path + NUL + size + NUL + sha256 + LF`.

The payload directory must be ACL-controlled and immutable for the complete hash/extract/install
operation. The tooling rejects archive reparse points, opens each archive once without following
links, hashes and extracts through that same file handle, and verifies the file identity and
timestamps did not change. It does not make a concurrently writable input trustworthy.

Core `Source` and `Intermediate` directories may exist in a reviewed BuildPlugin ZIP. Their bytes
remain covered by the archive hash; staging removes only those two real, contained directories and
then locks the final binary-only tree. Installed-package verification is read-only and rejects any
later file addition, removal, or modification. `SourceManifest.json` remains provenance input but
is not trusted as the final activated-tree digest.

Set the three fixed build inputs before invoking Rez:

```powershell
$env:UNREAL_EDITOR_WEBUI_REZ_PAYLOAD_ROOT = $Payloads
$env:UNREAL_EDITOR_WEBUI_REZ_PAYLOAD_LOCK = $Lock
$env:UNREAL_EDITOR_WEBUI_REZ_PAYLOAD_LOCK_SHA256 = (Get-Content "$Lock.sha256" -Raw).Trim()
```

Then install the recipes with the studio's Rez Python and package repository configuration:

```powershell
Push-Location rez\packages\unreal_editor_webui
rez-build -i --variants 0 1 2
Pop-Location

Push-Location rez\packages\unreal_editor_webui_asset_tools
rez-build -i
Pop-Location

Push-Location rez\packages\unreal_editor_webui_level_tools
rez-build -i
Pop-Location

Push-Location rez\packages\unreal_editor_webui_project
rez-build -i --variants 0 1 2
Pop-Location

rez-test unreal_editor_webui_project==1.0.0 core-payload asset-tools-payload level-tools-payload --extra-packages unreal_engine==5.4.4 --stop-on-fail
rez-test unreal_editor_webui_project==1.0.0 core-payload asset-tools-payload level-tools-payload --extra-packages unreal_engine==5.5.4 --stop-on-fail
rez-test unreal_editor_webui_project==1.0.0 core-payload asset-tools-payload level-tools-payload --extra-packages unreal_engine==5.8.0 --stop-on-fail

rez-test unreal_editor_webui==0.2.0 payload --extra-packages unreal_engine==5.4.4 --stop-on-fail
rez-test unreal_editor_webui==0.2.0 payload --extra-packages unreal_engine==5.5.4 --stop-on-fail
rez-test unreal_editor_webui==0.2.0 payload --extra-packages unreal_engine==5.8.0 --stop-on-fail
```

The recipe build commands use `rez-python`; they do not depend on a separately configured system
Python and do not run pip. Run each command in a trusted build environment whose Rez package path
and release repository are under studio control.

## Resolve And Launch

Resolve either explicit pins or the aggregate matching the target engine, for example:

```powershell
rez-env unreal_editor_webui_project==1.0.0 unreal_engine==5.5.4
uewebui-rez-preflight --project D:\Project\Project.uproject --engine-root "C:\Program Files\Epic Games\UE_5.5"
uewebui-rez-launch --project D:\Project\Project.uproject --engine-root "C:\Program Files\Epic Games\UE_5.5" --editor "C:\Program Files\Epic Games\UE_5.5\Engine\Binaries\Win64\UnrealEditor.exe"
```

The project descriptor must explicitly enable the core. Tool Packs that may be removed from a
resolve must remain enabled but optional:

```json
{
  "Plugins": [
    { "Name": "UnrealEditorWebUI", "Enabled": true },
    { "Name": "AssetToolsFixture", "Enabled": true, "Optional": true },
    { "Name": "LevelToolsFixture", "Enabled": true, "Optional": true }
  ]
}
```

The launcher verifies the exact engine identity, every installed receipt and final tree, the
project contract, and the complete external plugin-root scan before starting the editor. It rejects
wrong variants, altered payloads, duplicate core copies in project/engine/additional roots, and an
editor executable outside the validated engine root. Launching `UnrealEditor.exe` directly bypasses
this protection and is not a supported production entry point. Receipts and final-tree hashes cover
the activated `Plugins/<name>` tree. The core's `Scripts` directory and `RezPayload.json` are the
verification code and trust anchor, not self-authenticating data; the installed Rez repository must
therefore be immutable and writable only by the trusted package publisher.

## Validation Boundary

Deterministic repository tests build synthetic exact-identity payloads, exercise Rez-style
`commands()` append semantics without requiring Rez, reject hash/tree/variant/duplicate-core
failures, and verify the external-only project contract. The protected `UE CI` workflow waits for
all three native BuildPlugin artifacts, creates one closed lock, and runs two fresh editor processes
per variant through the mandatory launcher: first with both example packs, then after removing the
Level pack from the resolve and clearing project `Saved`/`Intermediate` state. The smoke checks real
plugin base directories, `system.ping`, `system.toolPacks`, both representative commands, and the
removed provider/command/module/path state.

Deterministic no-Rez tests do not by themselves prove `rez-build`, `rez-test`, or `rez-env`
behavior. The protected workflow stages payloads directly through the same lock/install/preflight
code and is an activation smoke, not a Rez resolver test. Real Rez commands require separate audit
evidence. Neither class of test proves the licensed UE matrix until the protected jobs run on the
exact commit. Keep issue #115 open until that evidence exists; issue #117 still owns independent
clean no-compiler/no-Node consumer VMs and publication acceptance.

The workflow intentionally has two serial three-variant waves: native BuildPlugin production, then
external-path activation after all three artifacts exist. An ephemeral-runner rollout therefore
needs a second set of three one-job listeners (or explicitly managed non-ephemeral trusted
listeners); the first wave's runners cannot be assumed to accept the second wave. Uploaded Rez E2E
evidence contains only bounded roles, provider names, booleans, rounds, and process ids. Absolute
machine paths and raw UE logs remain runner-local.
