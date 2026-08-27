# Tool Framework

This plugin is evolving from a command console into a project-aware UE editor tool rack.

## Tool Manifest Contract

Tools are registered in Python with rich metadata:

- `category`: top-level rack grouping.
- `icon`: compact icon token for the launcher UI.
- `tags`: search and stage filtering hints.
- `order`: deterministic ordering within categories.
- `supportedAssetTypes`: optional asset class hints.
- `resultType`: preferred result renderer such as `assetTable`, `issueTable`, or `changeSet`.
- `execution`: authoritative task execution policy.

The frontend combines this metadata with the active, runtime-decoded project/stage catalog to
decide where tools appear. A catalog organizes discovered commands; it never registers,
authorizes, or executes a command.

## Third-Party Command Plugins

Independent teams can ship Tool Pack payloads in dedicated content-only plugins or existing code
plugins that all use one installed `UnrealEditorWebUI` core. The core discovers a fixed manifest
and Python package from each enabled plugin, while the public SDK keeps extensions out of the
internal registry implementation. Packs are isolated at registration time, namespaced, and
surfaced in the same `system.commands`
catalogue. The separate `system.toolPacks` status view reports loaded/rejected providers and maps
each loaded provider to its bounded command-name list without changing command metadata v1. See
[Third-Party Tool Packs](tool-packs.md) for the layout, manifest, scaffolder, installation flow,
compatibility rules, and trust boundary.

## Project And Stage Catalog

The starter frontend includes sample projects and stages:

- Projects: `Project Aurora`, `Project Neon`, `Project Mobile`.
- Stages: `我的常用`, `创意设计`, `TA 工程`, `关卡制作`, `项目管理`.

These are deterministic fallback data. A project can replace them without rebuilding `Web/dist`
by creating:

```text
<Project>/Config/UnrealEditorWebUI/ToolCatalog.json
```

The bridge reads only this fixed project-controlled path. It does not accept a path or URL from
JavaScript, scan user directories, or fetch remote catalogs. The file must be UTF-8 JSON (an
optional UTF-8 BOM is accepted), no larger than 128 KiB, and conform to the closed
`schemaVersion: 1` contract. See [`docs/examples/tool-catalog.v1.json`](examples/tool-catalog.v1.json)
for a complete example.

Schema v1 contains:

- `projects`: unique project ids, display names/descriptions, and references to allowed stages.
- `stages`: unique stage ids and labels.
- `categories`: unique category ids, labels, and a safe built-in icon token.
- `defaultPreferences`: a valid default project, one of that project's stages, a valid category,
  and bounded favorite/open-tab command-name lists.

Every object is closed: unknown keys, unsupported versions, duplicate/empty ids, dangling stage
references, invalid defaults, unsafe icon markup, and values above the documented bounds reject
the whole project catalog. No partially valid project data is merged into the starter catalog.
Missing configuration is a normal starter fallback. A malformed, unreadable, unsupported, or
over-limit file produces a bounded diagnostic and also uses the starter catalog, but automatic
preference rewriting is paused so a temporary configuration mistake cannot erase project ids.

The category ids `all`, `favorites`, and `recent` are reserved UI behaviors and are required.
Custom command categories match a command's exact lowercase `category`, an exact tag equal to the
category id, or a `category:<id>` tag. The configured default stage is the unfiltered landing
stage; other custom stages match an exact tag equal to the stage id or a `stage:<id>` tag. The
starter `common`, `art`, `ta`, `level`, and `release` stages and starter
category ids retain their existing keyword compatibility. Unknown runtime stages never silently
show every command.

Persisted preferences are reconciled against the active catalog: compatible ids and command-name
lists retain their order, while removed project/stage/category ids fall back deterministically.
Favorites or tabs whose commands are temporarily unavailable are skipped in the rendered view,
not deleted from storage. Catalog files are readable by the trusted embedded page, so never place
tokens, credentials, absolute machine paths, executable code, HTML, SVG, or remote URLs in them.

The rack header's health panel reports whether catalog loading, command discovery, and the
strictly decoded `system.toolPacks` deployment view are ready. The backend emits status v2 with
closed policy state and reason codes, while the frontend continues to accept the legacy v1 shape.
It can show bounded public pack identity and command ownership for local diagnosis. Its schema-v2 copyable support report contains
only catalog source/status, schema version, fixed diagnostic codes, registry/Tool Pack aggregate
counts, and fixed reason codes. Catalog ids, labels, descriptions, defaults, command names, pack
or plugin identities, module names, raw load errors, and decoder exceptions are deliberately
outside that report.
The same aggregate drives closed health reasons: Tool Pack loading is `checking`, while status
unavailability, rejection, and truncation are `degraded`. These reasons never copy the underlying
pack identity or exception text, and existing bridge-unavailable/error precedence is unchanged.

## Prototype Policy

Local exploratory mockups are intentionally ignored by git:

- `docs/tool-hub-*.html`
- `docs/ue-tool-framework-*.html`
- `docs/ue-tool-framework-*.md`
- `ui-workflow-*`
- `tencent/`

Promote a prototype into source only when it becomes product documentation or a production
frontend implementation. Archive accepted designs under a stable docs path with screenshots and
decision notes rather than leaving scratch files in the repository root.

## UE CI Rollout

The hosted CI remains fast and platform-neutral. The UE workflow in `.github/workflows/ue-ci.yml`
requires a Windows self-hosted runner with labels:

- `self-hosted`
- `windows`
- `gui`
- exactly one of `ue-5.4`, `ue-5.5`, or `ue-5.8`; the checked-in registry always runs the three
  exact jobs serially for protected `main` validation. A second three-listener wave then runs the
  same exact variants for Rez external-path activation.

Runner prerequisites:

- UE 5.4.4, 5.5.4, or 5.8.0 at the registry's exact standard path and BuildId.
- The variant-specific Visual Studio 2022 C++ toolchain and Windows SDK tuple.
- Network access so the pinned `actions/setup-node` step can provision Node.js/npm for frontend packaging.
- UE 5.8 launches the editor with restrictive Python mode enabled before plugin initialization.
  UE 5.4/5.5 preflight rejects a user-global `init_unreal.py` and requires a clean dedicated
  runner profile because those versions cannot provide the same isolation guarantee.

Each job tests a package in a source-stripped temporary host and rejects plugin rebuild markers.
That same-machine binary-only simulation is not a clean no-compiler/no-Node consumer result;
independent VM acceptance remains issue #117.

Public pull requests use only the required GitHub-hosted checks. The trusted licensed UE runner is reserved for a trusted push to `main` or an explicitly approved manual run through the protected `ue-self-hosted` environment; do not execute unreviewed pull-request code on it. The documented default provisions six clean profile-local registrations and launches two sequential waves of three ephemeral one-job runners.

See `docs/ue-ci-runner.md` for the pinned runner setup, trust boundary, branch protection checklist, and artifact policy. See `docs/release-process.md` for exact-commit release candidate verification.
