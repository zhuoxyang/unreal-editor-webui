# Validation Status And Boundaries

## Maintained Compatibility Contract

The repository declares three exact Windows native release variants:

| Variant | Exact UE build | Editor/module BuildId | Embedded Python | Embedded Chromium | Required compiler / SDK |
| --- | --- | --- | --- | --- | --- |
| `UE54-Win64` | UE 5.4.4, CL 35576357, compatible CL 33043543 | 33043543 | 3.11.8 | 90.0.4430.212 | MSVC 14.38.33130 / product 14.38.33145, SDK 10.0.19041.0 |
| `UE55-Win64` | UE 5.5.4, CL 40574608, compatible CL 37670630 | 37670630 | 3.11.8 | 90.0.4430.212 | MSVC 14.38.33130 / product 14.38.33145, SDK 10.0.22621.0 |
| `UE58-Win64` | UE 5.8.0, CL 55116800, compatible CL 0 | 55116800 | 3.11.8 | 128.0.6613.138 | MSVC 14.44.35207 / product 14.44.35219, SDK 10.0.22621.0 |

These identities come from `scripts/ue-release-variants.json` and are enforced as a closed set.
Each BuildPlugin output is native to one UE minor version; renaming or copying it into another
variant is not supported. Package descriptor `EngineVersion`, `UnrealEditor.version`, module
manifest BuildId, and artifact/evidence subjects must all agree.

The frontend build is pinned to `chrome90` and ES2020 so output remains consumable by the oldest
maintained CEF runtime in UE 5.4/5.5. UE 5.8's newer Chromium consumes the same frontend output.

## Current Claim

The checked-in workflows, parsers, and static contracts implement the three-variant validation
chain. This alone is not a current native compatibility result. The current commit must not be
called release-validated until one protected `UE CI` run on that exact commit completes all three
serialized BuildPlugin/automation/GUI jobs and produces the closed six-artifact evidence set.

Previous local BuildPlugin/smoke results from other patch/minor identities remain historical
implementation evidence only. They cannot satisfy the exact UE 5.4.4, 5.5.4, and 5.8.0 release
gate.

## Hosted Validation

Ordinary GitHub-hosted CI validates the parts that do not require a licensed engine:

- frontend builds on the supported Node 22.22.2 and 24.18.1 floors, with lint, tests, production
  coverage, and packaged `Web/dist/index.html` checks;
- the Vite/TypeScript contract remains at `chrome90`/ES2020;
- Python registry and Tool Pack tests run on Python 3.9 and 3.11;
- the release-variant registry emits exactly `ue54`, `ue55`, and `ue58` with the complete exact
  identity/toolchain/runtime matrix;
- BuildEnvironment schema 2 tests cover all three variants, cross-variant substitution, exact UBT
  selections, UTF-16 logs, Windows case/junction containment, unknown-field privacy, canonical
  bytes, artifact subject binding, malformed runtime/frontend data, package DLL/module/descriptor
  identity, and fresh output rules;
- release resolver tests cover closed jobs/artifacts, API pagination, run-attempt binding,
  malformed ids/types/digests/expiry/workflow metadata, cross-labelled jobs, duplicate subjects,
  all-environment-before-package ordering, final archive hashes, and provenance contracts;
- packaging and log contracts retain the exact-commit source manifest/license boundary, scoped
  runner-local current-invocation logs, original process exit code, CEF product-DOM/report/privacy
  canaries, bounded dynamic Tool Pack count, Python startup isolation, artifact ordering, and the
  allowlisted diagnostics-last behavior;
- PowerShell/Bash syntax, immutable GitHub Action references, official npm registry guards, and safe
  ZIP extraction profiles are tested.

Hosted checks do not compile the C++ module or open Unreal Editor, and therefore cannot establish
native or CEF runtime success.

## Protected Exact-Version Validation

The protected job matrix is emitted from the checked-in registry and runs with
`strategy.max-parallel: 1` on interactive Windows runners labelled:

- `self-hosted`, `windows`, `gui`, `ue-5.4`;
- `self-hosted`, `windows`, `gui`, `ue-5.5`;
- `self-hosted`, `windows`, `gui`, `ue-5.8`.

Every variant job validates before packaging:

- full `Build.version` and `UnrealEditor.version` values, including patch, changelist, compatible
  changelist, branch, promoted/licensee flags, and editor BuildId;
- `UnrealEditor.modules` BuildId;
- the actual embedded Python ProductVersion;
- exactly one recursive CEF `libcef.dll` and its actual ProductVersion/Chromium version;
- a dedicated standard-user identity on the active nonzero console and input desktop, with an
  interactive Explorer shell;
- for UE 5.4/5.5, absence of user-global
  `Documents\UnrealEngine\Python\init_unreal.py` before BuildPlugin.

BuildPlugin writes to fresh run-id/run-attempt/variant-scoped package and log paths. The workflow
checks the exact commit's `SourceManifest.json`, generated frontend entry, committed MIT license,
descriptor `Installed` and exact `EngineVersion`, one module mapping, non-empty DLL, and exact
BuildId.

The temporary project installs the packaged core plugin and three representative Tool Packs:

- AssetToolsFixture v1;
- LevelToolsFixture v1;
- ExampleAssetTools v2.

This is a stronger three-pack regression while satisfying the requirement to exercise multiple
independent packs and both v1/v2 contracts. The workflow runs native Bridge/Settings automation,
packaged bridge and settings Python smokes, and
`UnrealEditorWebUI.Browser.CEFBindingAndTaskEvent` through the real GUI editor. The GUI test observes
the packaged React product UI, closed schema-v2 health report, negative privacy canaries,
`system.ping`, task events, task detail, and rendered TaskCard through CEF rather than invoking
diagnostic bridge shortcuts.

UE 5.8 editor launches receive restrictive Python mode. UE 5.4/5.5 rely on a dedicated clean
Windows profile because they cannot provide the same early isolation control.

## Binary-Only Simulation Boundary

After BuildPlugin, the job creates a fresh temporary host under `RUNNER_TEMP`, resolves containment,
deletes the host copy's plugin `Source` and `Intermediate` directories, and verifies the remaining
frontend, Python, Config, descriptor, module manifest, BuildId, and non-empty DLL. All four editor
launches use that binary-only copy. Retained logs are scanned for UnrealBuildTool, plugin compile,
missing-module, or incompatible-module markers.

This proves that the packaged binary can load without the plugin's build inputs on that build host.
It does not prove the external-consumer baseline because those build tools remain installed on the
same runner. Independent Windows Sandbox acceptance and real off-diagonal prelaunch identity
rejections remain mandatory release evidence and must not be inferred from this simulation. The Sandbox baseline is
not a generic no-compiler/no-build-tool claim: the read-only UE mapping carries UBT, bundled .NET,
and embedded Python as engine payload.

## Clean-Host Release Gate

[Clean-Host Windows Sandbox Acceptance](clean-host-acceptance.md) defines the reproducible
clean-consumer gate. One candidate-mode run must use three independent, network-disabled Windows
Sandbox guests with read-only exact-engine and prepared candidate mappings, no guest dependency
installation, and one fresh writable evidence mapping per guest. Each guest records six closed
external-system results: Node.js command absent from command resolution/PATH, npm command absent
from command resolution/PATH, usable system-Python command and external runtime absent, Visual
Studio installation absent, MSVC compiler absent, and Windows SDK development files absent.
Matching editor logs must also show no compile/rebuild or runtime-install markers. The finalized
closed matrix must contain exactly three matching successes and six off-diagonal prelaunch
rejections.

Preparation uses `git archive` to create a safely extracted source snapshot from the exact release
commit. A private run manifest hashes that snapshot, the copied controller validator and variant
module/registry, the mapped guest harness, all plans, and all `.wsb` files. Each guest writes its
result first and then a binding sentinel that fixes the result hash, plan hash, and harness hashes;
finalization verifies those bindings and runs the copied, manifest-bound validator. This detects
stale or mixed run data under a trusted controller/operator model, but it cannot resist evidence
forgery by a malicious local administrator.

The checked-in harness, static validator tests, generated `.wsb` configurations, or a prepare-only
run are implementation evidence, not a clean-host result. Publication remains blocked until the
real three-guest run produces the complete privacy-safe JSON and checksum for the reviewed
candidate. After publication, fresh re-downloaded assets require a separate `published` replay;
raw UE, UAT, UBT, editor, Sandbox, and host logs remain local and are never promoted as evidence.
This gate supplements rather than replaces the protected exact-version UE validation above.

## Evidence And Promotion

Only after all validation steps pass does each job upload its package. It then creates one fresh,
canonical `BuildEnvironment.json` using the retained BuildPlugin console log, explicitly referenced
current UBT logs, exact engine/editor files, detected runtime versions, source manifest, and immutable
package artifact id/name/digest.

The three package artifacts and three BuildEnvironment artifacts are required together. Release
assembly digest-verifies all six, validates all three environments before extracting any package,
checks package descriptor/module/DLL/source identity, creates three native ZIPs and SHA-256
sidecars, writes schema 3 project provenance binding the final archive hashes, and requests
GitHub-signed SLSA build provenance whose subjects are exactly those three ZIPs. The attestation
step runs after the project provenance and fails before candidate upload if signing fails. A
missing, duplicate, expired, malformed, cross-version, or mismatched subject fails closed. One bounded allowlisted
diagnostics JSON is uploaded last for each variant and never consumed by release assembly. Raw UE,
UAT, UBT, host, and browser logs remain on the runner.

Runtime identity is version-level. The workflow records actual reported Python and CEF versions but
does not serialize machine paths or claim byte-for-byte Python/CEF DLL hashes.

## Manual Packaged Smoke Example

The following UE 5.8 commandlet example exercises packaged frontend assets and the Python bridge;
use a host project created from the matching UE 5.8 package:

```powershell
$env:UNREAL_WEBUI_PACKAGED_SMOKE_RESULT = Join-Path $env:TEMP "UnrealEditorWebUI-PackagedSmoke.json"
& "C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" $HostProject '-ini:Engine:[ConsoleVariables]:Engine.Python.IsPythonInRestrictiveMode=1' -run=pythonscript "-script=$PWD/scripts/validate-packaged-bridge-smoke.py" -unattended -nopause -nosplash -NullRHI
if ($LASTEXITCODE -ne 0) { throw "Packaged bridge smoke failed with exit code $LASTEXITCODE" }
```

That commandlet does not open an interactive CEF browser and must not be described as GUI
end-to-end validation. The protected GUI automation is the authoritative CEF layer.
