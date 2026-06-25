# GitHub Workflow

Use GitHub issues for grouped optimization work before opening branches. The
repository includes a small issue creation helper that reads issue drafts from a
JSON file and creates them with the GitHub REST API.

## Create Issues

Set a token with `issues:write` access:

```sh
export GH_TOKEN=github_pat_...
```

Then run:

```sh
node scripts/create-github-issues.mjs \
  docs/repository-optimization-issues.json \
  zhuoxyang/unreal-editor-webui
```

Preview the batch without creating issues:

```sh
node scripts/create-github-issues.mjs \
  docs/repository-optimization-issues.json \
  zhuoxyang/unreal-editor-webui \
  dry-run
```

Do not commit tokens or credential-manager output.
