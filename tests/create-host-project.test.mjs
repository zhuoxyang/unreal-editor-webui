import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CREATE_HOST_PROJECT = join(REPOSITORY_ROOT, 'scripts', 'create-host-project.ps1')
const ADD_TOOL_PACK = join(REPOSITORY_ROOT, 'scripts', 'add-tool-pack.ps1')
const TOOL_CATALOG_TEMPLATE = join(
  REPOSITORY_ROOT,
  'tests',
  'fixtures',
  'tool-catalog',
  'host-project-v1.template.json',
)
const CATALOG_MARKER_PLACEHOLDER = '__UE_WEBUI_CATALOG_MARKER__'
const VALID_MARKER = '0123456789abcdef0123456789abcdef'
const TOOL_PACK_FIXTURES = [
  join(REPOSITORY_ROOT, 'tests', 'fixtures', 'ue-tool-packs', 'AssetToolsFixture'),
  join(REPOSITORY_ROOT, 'tests', 'fixtures', 'ue-tool-packs', 'LevelToolsFixture'),
]
const BUSINESS_PLUGIN_FIXTURE = join(
  REPOSITORY_ROOT,
  'tests',
  'fixtures',
  'ue-tool-packs',
  'ExistingBusinessPluginFixture',
)

function createTestRoot() {
  const root = mkdtempSync(join(tmpdir(), 'unreal webui host project-'))
  const pluginSource = join(root, 'packaged plugin')
  mkdirSync(pluginSource)
  writeFileSync(
    join(pluginSource, 'UnrealEditorWebUI.uplugin'),
    '{"FileVersion":3}\n',
    'utf8',
  )
  return { root, pluginSource }
}

function runCreateHostProject({
  projectDir,
  pluginSource,
  toolCatalogTemplate,
  toolCatalogMarker,
  toolPackSourceDirs = [],
}) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    CREATE_HOST_PROJECT,
    '-ProjectDir',
    projectDir,
    '-PluginSourceDir',
    pluginSource,
    '-EngineAssociation',
    '5.8',
  ]
  if (toolCatalogTemplate !== undefined) {
    args.push('-ToolCatalogTemplate', toolCatalogTemplate)
  }
  if (toolCatalogMarker !== undefined) {
    args.push('-ToolCatalogMarker', toolCatalogMarker)
  }
  if (toolPackSourceDirs.length > 0) {
    args.push('-ToolPackSourceDirsJson', JSON.stringify(toolPackSourceDirs))
  }

  return spawnSync('powershell.exe', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
}

function runAddToolPack(pluginDirectory) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ADD_TOOL_PACK,
      '-PluginDirectory',
      pluginDirectory,
      '-Id',
      'com.openai.fixture.existing-business',
      '-CommandNamespace',
      'fixture.business',
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    },
  )
}

function assertSucceeded(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.equal(result.error, undefined, output)
  assert.equal(result.status, 0, output)
}

test(
  'Windows host-project creation renders one schema-v1 catalog at the fixed project path',
  { skip: process.platform !== 'win32' },
  () => {
    const fixtureSource = readFileSync(TOOL_CATALOG_TEMPLATE, 'utf8')
    assert.match(fixtureSource, /"schemaVersion"\s*:\s*1/u)
    assert.ok(fixtureSource.includes(CATALOG_MARKER_PLACEHOLDER))

    const { root, pluginSource } = createTestRoot()
    const projectDir = join(root, 'generated host')
    try {
      const result = runCreateHostProject({
        projectDir,
        pluginSource,
        toolCatalogTemplate: TOOL_CATALOG_TEMPLATE,
        toolCatalogMarker: VALID_MARKER,
      })
      assertSucceeded(result)

      const expectedProjectPath = join(projectDir, 'HostProject.uproject')
      assert.equal(
        realpathSync.native(result.stdout.trim()).toLowerCase(),
        realpathSync.native(expectedProjectPath).toLowerCase(),
      )
      assert.equal(result.stdout.trim().split(/\r?\n/u).length, 1)
      assert.ok(existsSync(expectedProjectPath))
      assert.ok(
        existsSync(
          join(
            projectDir,
            'Plugins',
            'UnrealEditorWebUI',
            'UnrealEditorWebUI.uplugin',
          ),
        ),
      )

      const catalogPath = join(
        projectDir,
        'Config',
        'UnrealEditorWebUI',
        'ToolCatalog.json',
      )
      const catalogSource = readFileSync(catalogPath, 'utf8')
      const catalog = JSON.parse(catalogSource.replace(/^\uFEFF/u, ''))
      assert.equal(catalog.schemaVersion, 1)
      assert.equal(catalog.projects[0].id, `project-${VALID_MARKER}`)
      assert.equal(catalog.projects[0].name, `CI Project ${VALID_MARKER}`)
      assert.deepEqual(catalog.projects[0].stages, [`stage-${VALID_MARKER}`])
      assert.equal(catalog.stages[0].id, `stage-${VALID_MARKER}`)
      assert.equal(catalog.stages[0].label, `CI Stage ${VALID_MARKER}`)
      assert.equal(catalog.categories.at(-1).id, `category-${VALID_MARKER}`)
      assert.equal(
        catalog.categories.at(-1).label,
        `CI Category ${VALID_MARKER}`,
      )
      assert.deepEqual(
        catalog.categories.slice(0, 3).map(({ id }) => id),
        ['all', 'favorites', 'recent'],
      )
      assert.deepEqual(
        catalog.categories.map(({ icon }) => icon),
        ['grid', 'star', 'recent', 'assets'],
      )
      assert.deepEqual(catalog.defaultPreferences, {
        projectId: `project-${VALID_MARKER}`,
        stageId: `stage-${VALID_MARKER}`,
        categoryId: `category-${VALID_MARKER}`,
        favorites: ['system.ping'],
        openTabs: [],
      })
      assert.equal(catalogSource.includes(CATALOG_MARKER_PLACEHOLDER), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'Windows host-project creation keeps catalog injection optional',
  { skip: process.platform !== 'win32' },
  () => {
    const { root, pluginSource } = createTestRoot()
    const projectDir = join(root, 'generated host')
    try {
      const result = runCreateHostProject({ projectDir, pluginSource })
      assertSucceeded(result)
      assert.ok(existsSync(join(projectDir, 'HostProject.uproject')))
      assert.equal(
        existsSync(
          join(
            projectDir,
            'Config',
            'UnrealEditorWebUI',
            'ToolCatalog.json',
          ),
        ),
        false,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'Windows host-project creation installs and enables multiple independent Tool Packs',
  { skip: process.platform !== 'win32' },
  () => {
    const { root, pluginSource } = createTestRoot()
    const projectDir = join(root, 'generated host')
    try {
      const result = runCreateHostProject({
        projectDir,
        pluginSource,
        toolPackSourceDirs: TOOL_PACK_FIXTURES,
      })
      assertSucceeded(result)

      const project = JSON.parse(
        readFileSync(join(projectDir, 'HostProject.uproject'), 'utf8').replace(/^\uFEFF/u, ''),
      )
      const enabledPlugins = new Map(
        project.Plugins.map(({ Name, Enabled }) => [Name, Enabled]),
      )
      assert.equal(enabledPlugins.get('UnrealEditorWebUI'), true)
      assert.equal(enabledPlugins.get('AssetToolsFixture'), true)
      assert.equal(enabledPlugins.get('LevelToolsFixture'), true)

      for (const fixture of TOOL_PACK_FIXTURES) {
        const pluginName = fixture.split(/[\\/]/u).at(-1)
        const installedRoot = join(projectDir, 'Plugins', pluginName)
        assert.ok(existsSync(join(installedRoot, `${pluginName}.uplugin`)))
        assert.ok(
          existsSync(
            join(installedRoot, 'Content', 'UnrealEditorWebUI', 'ToolPack.json'),
          ),
        )
        assert.ok(existsSync(join(installedRoot, 'Content', 'Python')))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'Windows host-project creation accepts a Tool Pack payload in an existing code plugin',
  { skip: process.platform !== 'win32' },
  () => {
    const { root, pluginSource } = createTestRoot()
    const projectDir = join(root, 'generated host')
    const businessPlugin = join(root, 'ExistingBusinessPluginFixture')
    cpSync(BUSINESS_PLUGIN_FIXTURE, businessPlugin, { recursive: true })
    try {
      const addResult = runAddToolPack(businessPlugin)
      assertSucceeded(addResult)

      const result = runCreateHostProject({
        projectDir,
        pluginSource,
        toolPackSourceDirs: [businessPlugin],
      })
      assertSucceeded(result)

      const installedRoot = join(
        projectDir,
        'Plugins',
        'ExistingBusinessPluginFixture',
      )
      const installedDescriptor = JSON.parse(
        readFileSync(
          join(installedRoot, 'ExistingBusinessPluginFixture.uplugin'),
          'utf8',
        ).replace(/^\uFEFF/u, ''),
      )
      assert.deepEqual(installedDescriptor.Modules, [
        {
          Name: 'ExistingBusinessPluginFixture',
          Type: 'Editor',
          LoadingPhase: 'Default',
        },
      ])
      assert.equal(installedDescriptor.CanContainContent, true)
      assert.equal(installedDescriptor.NoCode, undefined)
      assert.equal(
        installedDescriptor.Plugins.some(
          (dependency) =>
            dependency.Name === 'UnrealEditorWebUI'
            && dependency.Enabled === true,
        ),
        true,
      )
      assert.ok(
        existsSync(
          join(installedRoot, 'Content', 'UnrealEditorWebUI', 'ToolPack.json'),
        ),
      )
      assert.ok(
        existsSync(
          join(
            installedRoot,
            'Source',
            'ExistingBusinessPluginFixture',
            'ExistingBusinessPluginFixture.Build.cs',
          ),
        ),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'Windows host-project creation rejects duplicate Tool Pack inputs before writing',
  { skip: process.platform !== 'win32' },
  () => {
    const { root, pluginSource } = createTestRoot()
    const projectDir = join(root, 'generated host')
    try {
      const result = runCreateHostProject({
        projectDir,
        pluginSource,
        toolPackSourceDirs: [TOOL_PACK_FIXTURES[0], TOOL_PACK_FIXTURES[0]],
      })
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.equal(existsSync(projectDir), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'Windows host-project creation rejects Unicode-escaped duplicate manifest keys',
  { skip: process.platform !== 'win32' },
  () => {
    const { root, pluginSource } = createTestRoot()
    const projectDir = join(root, 'generated host')
    const toolPackSource = join(root, 'UnicodeDuplicateFixture')
    cpSync(TOOL_PACK_FIXTURES[0], toolPackSource, { recursive: true })
    writeFileSync(
      join(toolPackSource, 'Content', 'UnrealEditorWebUI', 'ToolPack.json'),
      String.raw`{"schemaVersion":1,"\u0073chemaVersion":1,"id":"com.openai.fixture.asset-tools","requiredCoreApi":1,"pythonPackage":"ue_webui_asset_tools_fixture","commandNamespace":"fixture.asset"}`,
      'utf8',
    )

    try {
      const result = runCreateHostProject({
        projectDir,
        pluginSource,
        toolPackSourceDirs: [toolPackSource],
      })
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.equal(existsSync(projectDir), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'Windows host-project creation rejects unpaired or unsafe catalog inputs before writing',
  { skip: process.platform !== 'win32' },
  () => {
    const invalidInputs = [
      { toolCatalogTemplate: TOOL_CATALOG_TEMPLATE },
      { toolCatalogMarker: VALID_MARKER },
      {
        toolCatalogTemplate: TOOL_CATALOG_TEMPLATE,
        toolCatalogMarker: VALID_MARKER.toUpperCase(),
      },
      {
        toolCatalogTemplate: TOOL_CATALOG_TEMPLATE,
        toolCatalogMarker: VALID_MARKER.slice(1),
      },
    ]

    for (const invalidInput of invalidInputs) {
      const { root, pluginSource } = createTestRoot()
      const projectDir = join(root, 'generated host')
      try {
        const result = runCreateHostProject({
          projectDir,
          pluginSource,
          ...invalidInput,
        })
        assert.equal(result.error, undefined)
        assert.notEqual(result.status, 0)
        assert.equal(existsSync(projectDir), false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  },
)

test(
  'Windows host-project creation rejects invalid catalog templates before writing',
  { skip: process.platform !== 'win32' },
  () => {
    const invalidTemplates = [
      '{"schemaVersion":1,"projects":[]}\n',
      `{"schemaVersion":2,"marker":"${CATALOG_MARKER_PLACEHOLDER}"}\n`,
      `{"schemaVersion":"1","marker":"${CATALOG_MARKER_PLACEHOLDER}"}\n`,
      `{"schemaVersion":1.1,"marker":"${CATALOG_MARKER_PLACEHOLDER}"}\n`,
      `{"schemaVersion":1,"marker":"${CATALOG_MARKER_PLACEHOLDER}"\n`,
    ]

    for (const [index, source] of invalidTemplates.entries()) {
      const { root, pluginSource } = createTestRoot()
      const projectDir = join(root, 'generated host')
      const templatePath = join(root, `invalid-${index}.template.json`)
      writeFileSync(templatePath, source, 'utf8')
      try {
        const result = runCreateHostProject({
          projectDir,
          pluginSource,
          toolCatalogTemplate: templatePath,
          toolCatalogMarker: VALID_MARKER,
        })
        assert.equal(result.error, undefined)
        assert.notEqual(result.status, 0)
        assert.equal(existsSync(projectDir), false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  },
)
