import assert from 'node:assert/strict'
import test from 'node:test'

import { validateNpmLockRegistry } from '../scripts/validate-npm-lock-registry.mjs'

function lockfileWith(resolved) {
  return {
    lockfileVersion: 3,
    packages: {
      '': { name: 'example' },
      'node_modules/example': { version: '1.0.0', resolved },
    },
  }
}

test('accepts official scoped and unscoped registry tarballs', () => {
  const result = validateNpmLockRegistry({
    packages: {
      '': { name: 'example' },
      'node_modules/example': {
        resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
      },
      'node_modules/@scope/example': {
        resolved: 'https://registry.npmjs.org/@scope/example/-/example-1.0.0.tgz',
      },
    },
  })

  assert.deepEqual(result, { errors: [], resolvedCount: 2 })
})

test('rejects unsafe or unexpected resolved URLs without echoing credentials', () => {
  const cases = [
    ['third-party mirror', 'https://mirrors.tencent.com/npm/example/-/example-1.0.0.tgz', 'host must be'],
    ['plain HTTP', 'http://registry.npmjs.org/example/-/example-1.0.0.tgz', 'must use HTTPS'],
    ['lookalike hostname', 'https://registry.npmjs.org.evil.test/example.tgz', 'host must be'],
    ['credentials', 'https://user:secret@registry.npmjs.org/example.tgz', 'must not contain credentials'],
    ['non-default port', 'https://registry.npmjs.org:444/example.tgz', 'non-default port'],
    ['query string', 'https://registry.npmjs.org/example.tgz?token=secret', 'query or fragment'],
    ['fragment', 'https://registry.npmjs.org/example.tgz#fragment', 'query or fragment'],
    ['non-tarball path', 'https://registry.npmjs.org/example/latest', 'registry tarball'],
    ['invalid URL', 'not a URL', 'URL is invalid'],
  ]

  for (const [label, resolved, expected] of cases) {
    const result = validateNpmLockRegistry(lockfileWith(resolved))
    assert.equal(result.errors.length, 1, label)
    assert.match(result.errors[0], new RegExp(expected), label)
    assert.doesNotMatch(result.errors[0], /secret/, label)
  }
})

test('rejects malformed packages and a lockfile with no resolved URLs', () => {
  assert.deepEqual(validateNpmLockRegistry(null), {
    errors: ['lockfile root must be an object'],
    resolvedCount: 0,
  })
  assert.deepEqual(validateNpmLockRegistry({ packages: [] }), {
    errors: ['lockfile packages must be an object'],
    resolvedCount: 0,
  })
  assert.deepEqual(validateNpmLockRegistry({ packages: { '': { name: 'example' } } }), {
    errors: ['lockfile must contain at least one resolved package URL'],
    resolvedCount: 0,
  })
  assert.deepEqual(validateNpmLockRegistry({ packages: { 'node_modules/example': null } }), {
    errors: [
      'node_modules/example: package entry must be an object',
      'lockfile must contain at least one resolved package URL',
    ],
    resolvedCount: 0,
  })
})

test('rejects a non-string resolved value', () => {
  assert.deepEqual(validateNpmLockRegistry(lockfileWith(42)), {
    errors: ['lockfile.packages.node_modules/example.resolved: resolved URL must be a string'],
    resolvedCount: 1,
  })
})

test('checks legacy dependency entries as well as the packages table', () => {
  const result = validateNpmLockRegistry({
    lockfileVersion: 2,
    packages: {
      'node_modules/example': {
        resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
      },
    },
    dependencies: {
      legacy: {
        resolved: 'https://mirrors.tencent.com/npm/legacy/-/legacy-1.0.0.tgz',
      },
    },
  })

  assert.equal(result.resolvedCount, 2)
  assert.deepEqual(result.errors, [
    'lockfile.dependencies.legacy.resolved: resolved URL host must be registry.npmjs.org',
  ])
})
