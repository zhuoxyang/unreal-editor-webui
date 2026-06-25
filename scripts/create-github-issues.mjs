#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const [, , inputPath, repo, mode = 'create'] = process.argv

if (!inputPath || !repo) {
  console.error('Usage: node scripts/create-github-issues.mjs <issues.json> <owner/repo> [create|dry-run]')
  process.exit(1)
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token && mode !== 'dry-run') {
  console.error('Set GH_TOKEN or GITHUB_TOKEN before creating issues.')
  process.exit(1)
}

const issues = JSON.parse(await readFile(inputPath, 'utf8'))
if (!Array.isArray(issues)) {
  console.error('Issue file must contain a JSON array.')
  process.exit(1)
}

for (const issue of issues) {
  if (!issue || typeof issue.title !== 'string' || typeof issue.body !== 'string') {
    console.error('Each issue must include string title and body fields.')
    process.exit(1)
  }

  if (mode === 'dry-run') {
    console.log(`[dry-run] ${issue.title}`)
    continue
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'unreal-editor-webui-issue-creator',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({
      title: issue.title,
      body: issue.body,
      labels: Array.isArray(issue.labels) ? issue.labels : undefined,
    }),
  })

  const responseText = await response.text()
  if (!response.ok) {
    console.error(`Failed to create "${issue.title}": ${response.status} ${responseText}`)
    process.exit(1)
  }

  const created = JSON.parse(responseText)
  console.log(`#${created.number} ${created.html_url}`)
}
