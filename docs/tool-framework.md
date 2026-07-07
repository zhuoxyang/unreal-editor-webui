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

The frontend combines this metadata with its built-in project/stage catalog in
`frontend/src/tool-manifest.ts` to decide where tools appear.

## Project And Stage Catalog

The starter frontend includes sample projects and stages:

- Projects: `Project Aurora`, `Project Neon`, `Project Mobile`.
- Stages: `我的常用`, `创意设计`, `TA 工程`, `关卡制作`, `项目管理`.

These are starter defaults. Production teams should replace them with project data loaded from
settings, an internal service, or a checked-in manifest file.

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
- `ue-5.5`

Runner prerequisites:

- Unreal Engine 5.5 at `C:\Program Files\Epic Games\UE_5.5`.
- Visual Studio 2022 C++ toolchain and Windows SDK.
- Node.js/npm for frontend packaging.
- No user-global Unreal Python startup script that logs errors during commandlets.

Once the runner is online, make the UE workflow a required pull-request check for changes under
`Source/`, `Python/`, `Web/`, `frontend/`, `scripts/`, and the plugin descriptor.

See `docs/ue-ci-runner.md` for the runner setup script, branch protection checklist, and artifact policy.
