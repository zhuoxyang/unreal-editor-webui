# Trusted Unreal CI Runners

The licensed Unreal jobs run only on protected, interactive Windows self-hosted runners. Public
pull requests run hosted checks and never execute contributed code on these machines.

## Closed Runner Set

The workflow always expands the checked-in `scripts/ue-release-variants.json` registry into these
three release jobs. `max-parallel: 1` serializes them so only one GUI editor job consumes the
machine at a time.

| Variant | Required label | Standard engine root | Exact engine | MSVC | Windows SDK |
| --- | --- | --- | --- | --- | --- |
| `ue54` | `ue-5.4` | `C:\Program Files\Epic Games\UE_5.4` | 5.4.4, CL 35576357, BuildId 33043543 | family 14.38.33130, product 14.38.33145 | 10.0.19041.0 |
| `ue55` | `ue-5.5` | `C:\Program Files\Epic Games\UE_5.5` | 5.5.4, CL 40574608, BuildId 37670630 | family 14.38.33130, product 14.38.33145 | 10.0.22621.0 |
| `ue58` | `ue-5.8` | `C:\Program Files\Epic Games\UE_5.8` | 5.8.0, CL 55116800, BuildId 55116800 | family 14.44.35207, product 14.44.35219 | 10.0.22621.0 |

Every registration gets only `self-hosted,windows,gui,<exact-engine-label>`. Do not put multiple
closed engine labels on one runner registration. The release resolver rejects cross-labelled jobs.

The repository setup script derives roots, runner names, labels, identities, and artifact policy
from the closed registry. It does not accept free-form label or UE-root overrides.

## Trust Boundary

`.github/workflows/ue-ci.yml` has no `pull_request` trigger. A protected native job runs only when:

- a matching path changes on a push to `main`; or
- a reviewed `main` ref is manually dispatched with `Run UE validation on the protected
  self-hosted runner` enabled; and
- the `ue-self-hosted` environment is approved.

The hosted prerequisites run first and validate the release-variant registry, build-environment
parser, resolver contracts, frontend, Python registry, PowerShell syntax, and packaging contracts.
Environment approval does not make an arbitrary branch trusted: the release resolver also requires
the eligible workflow run's `head_branch` to be `main`.

## Machine Prerequisites

Each runner needs:

- One exact Unreal installation from the table, including `RunUAT.bat`, `UnrealEditor.exe`,
  `UnrealEditor-Cmd.exe`, `Build.version`, `UnrealEditor.version`, `UnrealEditor.modules`, embedded
  Python, and CEF.
- Visual Studio 2022 C++ tools and the exact MSVC family/product tuple for that variant.
- The exact x64 Windows SDK tools from the table.
- Git for Windows with the standard `tar.exe` and `gzip.exe` paths; setup validates a gzip archive
  round trip before registration.
- A supported Node.js executable on `PATH`, used to decode the checked-in registry. The workflow's
  pinned `actions/setup-node` then provisions the repository Node/npm version with
  `package-manager-cache: false` for exact-commit packaging.
- Network access to GitHub Actions and the official npm registry.
- A logged-in interactive desktop session with `explorer.exe` in the same nonzero session.

UE 5.8 editor launches receive the early restrictive-Python ini override. UE 5.4 and UE 5.5 do
not provide the same reliable control, so their dedicated Windows user profiles must not contain
`Documents\UnrealEngine\Python\init_unreal.py`. Setup and job preflight fail before BuildPlugin if
that path exists. The current developer account's global startup link must not be reused for a
trusted UE 5.4/5.5 runner.

## Register A Runner

Obtain a short-lived repository registration token from the repository's Actions settings. Do not
save it in a script, shell profile, log, or document. From the checked-out repository, register one
variant at a time:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-ue-runner.ps1 -RepoUrl "https://github.com/OWNER/REPOSITORY" -Token $env:GITHUB_RUNNER_TOKEN -Variant ue54 -Ephemeral
```

Use `-Variant ue55` and `-Variant ue58` for the other registrations. The script:

1. Decodes and validates the exact three-variant registry.
2. Validates full `Build.version` and `UnrealEditor.version` identities plus editor/module BuildId.
3. Validates the embedded Python ProductVersion and the single CEF `libcef.dll` ProductVersion.
4. Validates the exact MSVC directory and `cl.exe` product version plus Windows SDK `rc.exe`.
5. Enforces the clean-profile rule for UE 5.4/5.5 and an interactive GUI session.
6. Creates a fresh variant-specific root such as `C:\actions-runner-unreal-editor-webui-ue54`.
7. Downloads the pinned GitHub runner, verifies its SHA-256, checks its reported version, and
   configures it with `--disableupdate` and no service mode.

The runner root must not already exist. That fail-closed rule avoids treating a version string as
integrity evidence for an old or partially overwritten installation. Remove an obsolete
registration through GitHub and the runner's supported removal flow before provisioning a new
root; do not edit runner internals in place.

Start `run.cmd` interactively from the logged-in desktop. A Windows service executes in Session 0
and cannot provide valid CEF coverage. An ephemeral registration accepts one job, then unregisters;
create a fresh registration for the next exact variant when using a single physical machine.

## What Each Variant Job Proves

For its exact engine, every job:

- materializes and packages the exact commit, retaining scoped current-invocation BuildPlugin and
  UBT logs;
- validates `SourceManifest.json`, the generated frontend, exact committed license, descriptor
  `Installed`/`EngineVersion`, module mapping, DLL, and BuildId;
- creates a fresh temporary host with AssetToolsFixture v1, LevelToolsFixture v1, and
  ExampleAssetTools v2;
- removes the host plugin's `Source` and `Intermediate` directories before launching any test;
- runs native Bridge/Settings automation, packaged bridge and settings smokes, and the real GUI CEF
  binding/task/event/DOM test;
- scans retained logs for plugin recompilation, UBT invocation, missing module, or incompatible
  module evidence;
- uploads one variant-specific package, one canonical BuildEnvironment artifact, and one diagnostic
  log artifact.

The binary-only host is a same-machine simulation. Because the machine still has Visual Studio and
Node.js, it is not a clean no-compiler/no-Node consumer acceptance result. That independent VM
coverage and real cross-variant negative installation remain issue #117 work.

## Artifact Policy

Successful jobs publish these immutable subjects:

- `UnrealEditorWebUI-Package-UE54-Win64`
- `UnrealEditorWebUI-Package-UE55-Win64`
- `UnrealEditorWebUI-Package-UE58-Win64`
- `UnrealEditorWebUI-BuildEnvironment-UE54-Win64`
- `UnrealEditorWebUI-BuildEnvironment-UE55-Win64`
- `UnrealEditorWebUI-BuildEnvironment-UE58-Win64`
- `unreal-editor-webui-ue-logs-ue54`, `...-ue55`, and `...-ue58` diagnostics

Every temporary package, host, log, report, and evidence path contains run id, run attempt, and
variant id. The package uploads only after all native and GUI validation succeeds. BuildEnvironment
schema 2 then binds the exact package artifact id/name/digest and actual retained build selection.
The always-run diagnostic upload remains last and is never a release input.

Runtime identity is version-level: preflight reads the actual embedded Python and CEF file version
metadata and compares it with the registry, and evidence records those detected strings. It does
not claim byte-level hashes for the Python or CEF binaries.

## Required Checks And Current Status

Keep the ordinary hosted `CI` checks required for pull requests. The licensed UE workflow is an
additional protected release gate, not a replacement for hosted CI.

Unreal Engine is not installed on GitHub-hosted runners. If an exact labelled interactive runner is
offline or the environment is not approved, the native job remains queued. Static workflow tests,
runner setup preflight, or a prior local run do not establish current release compatibility. A
commit is exact-version validated only after all three protected GUI jobs pass for that same
commit and run attempt.
