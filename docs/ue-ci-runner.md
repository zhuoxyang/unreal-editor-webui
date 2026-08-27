# Trusted Unreal CI Runners

The licensed Unreal jobs run only on protected, interactive Windows self-hosted runners. Public
pull requests run hosted checks and never execute contributed code on these machines.

## Closed Runner Set

The workflow expands `scripts/ue-release-variants.json` into these three exact engine jobs:

| Variant | Required label | Standard engine root | Exact engine | MSVC | Windows SDK |
| --- | --- | --- | --- | --- | --- |
| `ue54` | `ue-5.4` | `C:\Program Files\Epic Games\UE_5.4` | 5.4.4, CL 35576357, BuildId 33043543 | family 14.38.33130, product 14.38.33145 | 10.0.19041.0 |
| `ue55` | `ue-5.5` | `C:\Program Files\Epic Games\UE_5.5` | 5.5.4, CL 40574608, BuildId 37670630 | family 14.38.33130, product 14.38.33145 | 10.0.22621.0 |
| `ue58` | `ue-5.8` | `C:\Program Files\Epic Games\UE_5.8` | 5.8.0, CL 55116800, BuildId 55116800 | family 14.44.35207, product 14.44.35219 | 10.0.22621.0 |

Every registration has exactly `self-hosted,windows,gui,<exact-engine-label>`. The setup script uses
`--no-default-labels`, then supplies those four reviewed labels explicitly. Never put multiple
closed engine labels on one registration.

The workflow has two serial three-variant waves:

1. `buildplugin-and-automation` produces and validates the three native packages.
2. `rez-external-e2e` downloads all three packages and validates external-path activation.

Every listener is `--ephemeral`, so one protected run needs six registrations: three for the build
wave and three for the Rez wave. Only one wave is launched at a time. Starting all six together is
unsafe because a failed build wave skips Rez and would leave the unused listeners online.

## Trust And Concurrency Boundary

`.github/workflows/ue-ci.yml` has no `pull_request` trigger. A protected native job runs only when:

- a matching path changes on a push to `main`, or a reviewed `main` ref is manually dispatched with
  trusted validation enabled;
- the `ue-self-hosted` environment is approved; and
- the repository keeps the environment branch policy restricted to `main` with its required
  reviewer.

The workflow-level `ue-ci-protected-interactive` concurrency group has
`cancel-in-progress: false`. This serializes whole workflow runs without placing matrix siblings in
one job-level concurrency group; GitHub allows only one pending member per group and could otherwise
discard a pending engine job.

Do not approve the environment or launch a runner for unreviewed code. Before a release, confirm the
workflow `head_branch` and exact `head_sha` are the intended `main` commit.

## Dedicated Windows Account

Use a dedicated local standard Windows account that is not a member of Administrators and is not
used for development, email, browsing, or DCC startup customization. Do not run the listener as a
service. The account needs read/execute access to the exact Unreal installs and toolchains, and
write access only to its own profile and runner work roots.

The session probe fails unless all of these are true:

- the identity is neither an administrator nor a Windows service identity;
- the process is in the active nonzero console session;
- `Environment.UserInteractive` is true;
- the active input desktop can be opened and closed; and
- the same session contains an Explorer desktop and a loaded user profile.

`-UserDir` isolates an editor invocation's state but does not isolate
`Documents\UnrealEngine\Python\init_unreal.py` on UE 5.4/5.5. Those profiles must not contain that
file. UE 5.8 also receives the restrictive-Python ini override.

## Machine Prerequisites

Each runner machine needs the exact engine, embedded Python, CEF, Visual Studio toolchain, Windows
SDK, and Git for Windows versions checked by the setup script. The setup script does not depend on
the operator's `PATH` Node installation. It downloads these fixed official archives:

- GitHub Actions runner 2.337.0 x64,
  SHA-256 `1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc`;
- Node.js 24.18.1 x64 ZIP,
  SHA-256 `ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765`.

Both archives are verified before extraction. Runner auto-update is disabled; updates require a
reviewed repository change to the pinned version and checksum, followed by fresh registrations.

## Provision Six One-Job Registrations

From an operator PowerShell, obtain the credential for the dedicated standard account. The
controller opens a visible child PowerShell with that profile. The child session performs the full
desktop check and prompts for the short-lived repository registration token as a `SecureString`:

```powershell
$DedicatedCredential = Get-Credential

foreach ($Wave in @("build", "rez")) {
    foreach ($Variant in @("ue54", "ue55", "ue58")) {
        powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-ue-runner-setup.ps1 -RepoUrl "https://github.com/OWNER/REPOSITORY" -Variant $Variant -Wave $Wave -DedicatedUserCredential $DedicatedCredential
    }
}
```

If credential launch cannot attach the child to the active input desktop, sign in to the dedicated
account normally and run `setup-ue-runner.ps1` there. Do not weaken the session probe.

The controller never receives the registration token. The child converts the `SecureString` to
plain text only for the official `config.cmd --token` invocation, zeroes the unmanaged buffer, and
does not place registration material in an environment variable, file, bootstrap evidence, or
uploaded diagnostic. Never enable PowerShell transcription while provisioning.

Runner roots are fresh and profile-local:

```text
%LOCALAPPDATA%\UnrealEditorWebUI\actions-runners\build-ue54
%LOCALAPPDATA%\UnrealEditorWebUI\actions-runners\build-ue55
%LOCALAPPDATA%\UnrealEditorWebUI\actions-runners\build-ue58
%LOCALAPPDATA%\UnrealEditorWebUI\actions-runners\rez-ue54
%LOCALAPPDATA%\UnrealEditorWebUI\actions-runners\rez-ue55
%LOCALAPPDATA%\UnrealEditorWebUI\actions-runners\rez-ue58
```

The roots and runner names are unique by wave and variant. Setup refuses an existing root and never
uses `--replace`.

## Run The Two Waves

Keep every registration offline until the matching jobs are approved and waiting for labels.

1. Approve the protected environment for the exact trusted run.
2. In the dedicated account's active desktop, launch the build wave:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-ue-runner-fleet.ps1 -Wave build
   ```

3. Wait for all three build jobs to succeed. Do not start Rez listeners if any build job fails.
4. When the three Rez jobs are queued, launch the second wave:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-ue-runner-fleet.ps1 -Wave rez
   ```

The fleet controller starts exactly three hidden listener wrappers in the existing interactive
desktop and waits for them. Any listener failure stops the other exact child process trees so they
cannot remain online. `Ctrl+C` also runs that cleanup path. A service or Session 0 launch is invalid
CEF evidence.

## UE 5.4 Houdini Compatibility Boundary

The checked machine currently needs a read-only UE 5.4 BuildPlugin compatibility argument when this
exact engine plugin is present:

```text
Engine\Plugins\Runtime\HoudiniEngine\HoudiniEngine.uplugin
sha256:44e6a8335fe84d80faddc5d11d3ba3107c4dabbd044763ba42913e478ab7b1c4
```

`scripts/package-plugin.ps1` enables the single fixed architecture argument only for the exact
5.4.4 engine identity and that descriptor hash. A different UE 5.4 identity or descriptor hash
fails before UAT. The script hashes the descriptor again after UAT and fails if it changed. It does
not rename, edit, delete, disable, or move any installed engine file, and it exposes no free-form
UAT argument parameter. UE 5.5 and 5.8 do not receive this argument.

## Evidence And Privacy

A successful build wave publishes the three native package artifacts and three canonical
`BuildEnvironment.json` artifacts. Raw UAT, UBT, Unreal, host, and browser logs remain runner-local.
The always-run diagnostic artifact contains only one bounded `RunnerDiagnostics.json` with closed
variant/run identifiers, booleans, counts, and explicit privacy flags. It contains no raw log text,
machine path, username, environment dump, runner registration material, or secret. Diagnostic
artifacts are never release inputs.

The Rez wave uploads only its bounded round result JSON files; raw editor logs remain local.

## Cleanup, Token Rotation, And Offline State

An ephemeral listener automatically unregisters after its one accepted job. After GitHub shows all
three registrations consumed or after an operator removes any interrupted/offline registrations in
repository Actions settings, remove the exact local wave roots:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\remove-ue-runner-wave.ps1 -Wave build -GitHubRegistrationsRemoved
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\remove-ue-runner-wave.ps1 -Wave rez -GitHubRegistrationsRemoved
```

The cleanup script validates all three bootstrap identities, containment under the dedicated
profile root, absence of reparse points, and absence of live listeners before deletion. It never
touches an Unreal installation.

Registration tokens are short lived and single-purpose. Discard them after provisioning. If a
token may have been exposed, revoke/delete the affected runner registrations, rotate the token in
GitHub, clean the exact roots, and reprovision; never reuse a bootstrap root.

When no trusted validation is active, GitHub should show no online runner from this fleet. Static
hosted checks, local setup, and historical runs do not establish current engine compatibility. Only
all six protected jobs passing for the same `main` commit and run attempt provide release evidence.

Provisioning requires the official download and GitHub registration endpoints. A network failure
stops setup or listener execution; there is no unverified archive-cache or offline-registration
fallback. If a listener loses GitHub connectivity, treat the job as non-evidence, stop the exact
wave, remove its interrupted registrations, clean the verified roots, and reprovision before retry.
