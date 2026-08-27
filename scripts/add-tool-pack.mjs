import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

const MAX_DESCRIPTOR_BYTES = 1024 * 1024
const MAX_JSON_DEPTH = 64
const PACK_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+(?![\s\S])/u
const COMMAND_NAMESPACE_PATTERN =
  /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?![\s\S])/u
const PLUGIN_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}(?![\s\S])/u
const PYTHON_PACKAGE_PATTERN = /^[a-z_][a-z0-9_]{1,255}(?![\s\S])/u
const CORE_PLUGIN_NAME = 'UnrealEditorWebUI'

class StrictJsonParser {
  constructor(source, label) {
    this.source = source
    this.label = label
    this.index = 0
  }

  fail(message) {
    throw new Error(this.label + ' is not valid strict JSON: ' + message)
  }

  skipWhitespace() {
    while (
      this.index < this.source.length
      && (
        this.source[this.index] === ' '
        || this.source[this.index] === '\t'
        || this.source[this.index] === '\r'
        || this.source[this.index] === '\n'
      )
    ) {
      this.index += 1
    }
  }

  consume(expected) {
    if (this.source[this.index] !== expected) {
      this.fail('expected "' + expected + '" at character ' + this.index + '.')
    }
    this.index += 1
  }

  parseString() {
    const start = this.index
    this.consume('"')
    while (this.index < this.source.length) {
      const character = this.source[this.index]
      if (character === '"') {
        this.index += 1
        try {
          return JSON.parse(this.source.slice(start, this.index))
        } catch {
          this.fail('contains an invalid string at character ' + start + '.')
        }
      }
      if (character === '\\') {
        this.index += 1
        const escape = this.source[this.index]
        if ('"\\/bfnrt'.includes(escape)) {
          this.index += 1
          continue
        }
        if (escape === 'u') {
          const hex = this.source.slice(this.index + 1, this.index + 5)
          if (!/^[0-9A-Fa-f]{4}(?![\s\S])/u.test(hex)) {
            this.fail('contains an invalid Unicode escape at character ' + this.index + '.')
          }
          this.index += 5
          continue
        }
        this.fail('contains an invalid escape at character ' + this.index + '.')
      }
      if (character.charCodeAt(0) < 0x20) {
        this.fail('contains a control character in a string.')
      }
      this.index += 1
    }
    this.fail('contains an unterminated string.')
  }

  parseNumber() {
    const match = this.source
      .slice(this.index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)
    if (!match) {
      this.fail('contains an invalid number at character ' + this.index + '.')
    }
    this.index += match[0].length
  }

  parseLiteral(literal) {
    if (!this.source.startsWith(literal, this.index)) {
      this.fail('contains an invalid value at character ' + this.index + '.')
    }
    this.index += literal.length
  }

  parseArray(depth) {
    this.consume('[')
    this.skipWhitespace()
    if (this.source[this.index] === ']') {
      this.index += 1
      return
    }
    while (true) {
      this.parseValue(depth + 1)
      this.skipWhitespace()
      if (this.source[this.index] === ']') {
        this.index += 1
        return
      }
      this.consume(',')
      this.skipWhitespace()
    }
  }

  parseObject(depth) {
    this.consume('{')
    this.skipWhitespace()
    const keys = new Set()
    if (this.source[this.index] === '}') {
      this.index += 1
      return
    }
    while (true) {
      if (this.source[this.index] !== '"') {
        this.fail('requires quoted object keys at character ' + this.index + '.')
      }
      const key = this.parseString()
      if (keys.has(key)) {
        this.fail('contains duplicate object key "' + key + '".')
      }
      keys.add(key)
      this.skipWhitespace()
      this.consume(':')
      this.skipWhitespace()
      this.parseValue(depth + 1)
      this.skipWhitespace()
      if (this.source[this.index] === '}') {
        this.index += 1
        return
      }
      this.consume(',')
      this.skipWhitespace()
    }
  }

  parseValue(depth) {
    if (depth > MAX_JSON_DEPTH) {
      this.fail('exceeds the supported nesting depth.')
    }
    this.skipWhitespace()
    const character = this.source[this.index]
    if (character === '{') {
      this.parseObject(depth)
    } else if (character === '[') {
      this.parseArray(depth)
    } else if (character === '"') {
      this.parseString()
    } else if (character === '-' || (character >= '0' && character <= '9')) {
      this.parseNumber()
    } else if (character === 't') {
      this.parseLiteral('true')
    } else if (character === 'f') {
      this.parseLiteral('false')
    } else if (character === 'n') {
      this.parseLiteral('null')
    } else {
      this.fail('contains an invalid value at character ' + this.index + '.')
    }
  }

  parse() {
    this.skipWhitespace()
    this.parseValue(0)
    this.skipWhitespace()
    if (this.index !== this.source.length) {
      this.fail('contains trailing data at character ' + this.index + '.')
    }
  }
}

function parseArguments(argv) {
  const options = {
    pluginDirectory: null,
    id: null,
    commandNamespace: null,
    dryRun: false,
  }
  const valueOptions = new Map([
    ['--plugin-directory', 'pluginDirectory'],
    ['--id', 'id'],
    ['--command-namespace', 'commandNamespace'],
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') {
      if (options.dryRun) throw new Error('--dry-run may be supplied only once.')
      options.dryRun = true
      continue
    }
    const optionName = valueOptions.get(argument)
    if (!optionName) throw new Error('Unknown argument: ' + argument)
    if (options[optionName] !== null) {
      throw new Error(argument + ' may be supplied only once.')
    }
    index += 1
    if (index >= argv.length || argv[index].startsWith('--')) {
      throw new Error(argument + ' requires a value.')
    }
    options[optionName] = argv[index]
  }

  for (const [argument, optionName] of valueOptions) {
    if (options[optionName] === null) throw new Error(argument + ' is required.')
  }
  return options
}

function readStrictJson(path, label) {
  const bytes = readFileSync(path)
  if (bytes.length === 0 || bytes.length > MAX_DESCRIPTOR_BYTES) {
    throw new Error(label + ' must be non-empty and no larger than 1 MiB.')
  }
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(label + ' must use strict UTF-8 encoding.')
  }
  if (source.startsWith('\uFEFF')) source = source.slice(1)
  new StrictJsonParser(source, label).parse()
  return JSON.parse(source)
}

function assertPlainObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(label + ' must be a JSON object.')
  }
}

function exactField(record, field, label) {
  const matchingKeys = Object.keys(record).filter(
    (key) => key.toLowerCase() === field.toLowerCase(),
  )
  if (matchingKeys.length > 1 || (matchingKeys.length === 1 && matchingKeys[0] !== field)) {
    throw new Error(label + ' contains ambiguous field casing for "' + field + '".')
  }
  return matchingKeys.length === 1
}

function assertSafeDirectory(path, label) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(label + ' must not be a reparse point or symbolic link.')
  if (!stat.isDirectory()) throw new Error(label + ' must be a directory.')
}

function assertSafeFile(path, label) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(label + ' must not be a reparse point or symbolic link.')
  if (!stat.isFile()) throw new Error(label + ' must be a regular file.')
}

function assertInside(root, candidate, label) {
  const child = relative(root, candidate)
  if (child === '..' || child.startsWith('../') || child.startsWith('..\\')) {
    throw new Error(label + ' escaped the plugin directory.')
  }
}

function derivePythonPackage(pluginName) {
  const snake = pluginName
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/gu, '$1_$2')
    .replace(/_+/gu, '_')
    .toLowerCase()
  const packageName = 'ue_webui_toolpack_' + snake
  if (!PYTHON_PACKAGE_PATTERN.test(packageName)) {
    throw new Error('Plugin name could not be converted to a safe Python package.')
  }
  return packageName
}

function normalizeDescriptor(descriptor, pluginName) {
  assertPlainObject(descriptor, 'Plugin descriptor')
  if (exactField(descriptor, 'Modules', 'Plugin descriptor') && !Array.isArray(descriptor.Modules)) {
    throw new Error('Plugin descriptor field "Modules" must be an array when present.')
  }

  exactField(descriptor, 'CanContainContent', 'Plugin descriptor')
  descriptor.CanContainContent = true

  const hasPlugins = exactField(descriptor, 'Plugins', 'Plugin descriptor')
  if (!hasPlugins) descriptor.Plugins = []
  if (!Array.isArray(descriptor.Plugins)) {
    throw new Error('Plugin descriptor field "Plugins" must be an array when present.')
  }

  const coreDependencies = []
  for (let index = 0; index < descriptor.Plugins.length; index += 1) {
    const dependency = descriptor.Plugins[index]
    const label = 'Plugin dependency at index ' + index
    assertPlainObject(dependency, label)
    if (!exactField(dependency, 'Name', label) || typeof dependency.Name !== 'string') {
      throw new Error(label + ' must contain a string "Name" field.')
    }
    if (dependency.Name.toLowerCase() === CORE_PLUGIN_NAME.toLowerCase()) {
      coreDependencies.push(dependency)
    }
  }

  if (coreDependencies.length > 1) {
    throw new Error('Plugin descriptor contains duplicate UnrealEditorWebUI dependencies.')
  }
  if (coreDependencies.length === 0) {
    descriptor.Plugins.push({ Name: CORE_PLUGIN_NAME, Enabled: true })
  } else {
    const dependency = coreDependencies[0]
    exactField(dependency, 'Enabled', 'UnrealEditorWebUI dependency')
    dependency.Name = CORE_PLUGIN_NAME
    dependency.Enabled = true
  }

  if (pluginName.toLowerCase() === CORE_PLUGIN_NAME.toLowerCase()) {
    throw new Error('Refusing to add a Tool Pack payload to the core plugin itself.')
  }
}

function prepare(options) {
  if (
    typeof options.id !== 'string'
    || options.id.length > 128
    || !PACK_ID_PATTERN.test(options.id)
  ) {
    throw new Error('Id must be a lowercase reverse-DNS identifier.')
  }
  if (
    typeof options.commandNamespace !== 'string'
    || options.commandNamespace.length > 128
    || !COMMAND_NAMESPACE_PATTERN.test(options.commandNamespace)
  ) {
    throw new Error(
      'CommandNamespace must be a lowercase dotted identifier using ASCII letters, digits, and underscores.',
    )
  }

  const pluginDirectory = resolve(options.pluginDirectory)
  if (!existsSync(pluginDirectory)) {
    throw new Error('PluginDirectory does not exist: ' + pluginDirectory)
  }
  assertSafeDirectory(pluginDirectory, 'PluginDirectory')

  const descriptorEntries = readdirSync(pluginDirectory, { withFileTypes: true }).filter(
    (entry) => entry.name.toLowerCase().endsWith('.uplugin'),
  )
  if (descriptorEntries.some((entry) => entry.isSymbolicLink())) {
    throw new Error('The root .uplugin descriptor must not be a reparse point or symbolic link.')
  }
  const descriptorFiles = descriptorEntries.filter((entry) => entry.isFile())
  if (descriptorFiles.length !== 1 || descriptorEntries.length !== 1) {
    throw new Error('PluginDirectory must contain exactly one regular root .uplugin descriptor.')
  }

  const descriptorPath = join(pluginDirectory, descriptorFiles[0].name)
  assertSafeFile(descriptorPath, 'Plugin descriptor')
  const pluginName = basename(descriptorPath, extname(descriptorPath))
  if (!PLUGIN_NAME_PATTERN.test(pluginName)) {
    throw new Error('Plugin descriptor name is invalid: ' + pluginName)
  }

  const descriptor = readStrictJson(descriptorPath, 'Plugin descriptor')
  normalizeDescriptor(descriptor, pluginName)
  const pythonPackage = derivePythonPackage(pluginName)

  const contentDirectory = join(pluginDirectory, 'Content')
  const manifestDirectory = join(contentDirectory, CORE_PLUGIN_NAME)
  const manifestPath = join(manifestDirectory, 'ToolPack.json')
  const pythonRoot = join(contentDirectory, 'Python')
  const pythonPackageDirectory = join(pythonRoot, pythonPackage)
  for (const [path, label] of [
    [contentDirectory, 'Content directory'],
    [manifestDirectory, 'Tool Pack manifest directory'],
    [pythonRoot, 'Python content directory'],
  ]) {
    assertInside(pluginDirectory, path, label)
    if (existsSync(path)) assertSafeDirectory(path, label)
  }
  assertInside(pluginDirectory, manifestPath, 'Tool Pack manifest')
  assertInside(pluginDirectory, pythonPackageDirectory, 'Tool Pack Python package')
  if (existsSync(manifestPath)) {
    throw new Error('Refusing to overwrite existing Tool Pack manifest: ' + manifestPath)
  }
  if (existsSync(pythonPackageDirectory)) {
    throw new Error('Refusing to overwrite existing Tool Pack Python package: ' + pythonPackageDirectory)
  }

  return {
    pluginDirectory,
    pluginName,
    descriptor,
    descriptorPath,
    contentDirectory,
    manifestDirectory,
    manifestPath,
    pythonRoot,
    pythonPackageDirectory,
    pythonPackage,
    id: options.id,
    commandNamespace: options.commandNamespace,
  }
}

function writeExclusive(path, source, createdFiles) {
  writeFileSync(path, source, { encoding: 'utf8', flag: 'wx' })
  createdFiles.push(path)
}

function ensureDirectory(path, createdDirectories) {
  if (existsSync(path)) {
    assertSafeDirectory(path, 'Existing output directory')
    return
  }
  mkdirSync(path)
  createdDirectories.push(path)
}

function applyPrepared(prepared) {
  const createdFiles = []
  const createdDirectories = []
  const descriptorTempPath = join(
    prepared.pluginDirectory,
    '.' + prepared.pluginName + '.add-tool-pack-' + randomUUID() + '.tmp',
  )
  let descriptorPublished = false

  try {
    ensureDirectory(prepared.contentDirectory, createdDirectories)
    ensureDirectory(prepared.manifestDirectory, createdDirectories)
    ensureDirectory(prepared.pythonRoot, createdDirectories)
    ensureDirectory(prepared.pythonPackageDirectory, createdDirectories)

    const manifest = {
      schemaVersion: 1,
      id: prepared.id,
      requiredCoreApi: 1,
      pythonPackage: prepared.pythonPackage,
      commandNamespace: prepared.commandNamespace,
    }
    writeExclusive(
      prepared.manifestPath,
      JSON.stringify(manifest, null, 2) + '\n',
      createdFiles,
    )
    writeExclusive(
      join(prepared.pythonPackageDirectory, '__init__.py'),
      '"""Commands provided by the ' + prepared.pluginName + ' Tool Pack."""\n',
      createdFiles,
    )
    const commandName = prepared.commandNamespace + '.ping'
    const commandsSource =
      'from __future__ import annotations\n'
      + '\n'
      + 'from typing import Any\n'
      + '\n'
      + 'from unreal_editor_webui_sdk import command\n'
      + '\n'
      + '\n'
      + '@command(\n'
      + '    "' + commandName + '",\n'
      + '    description="Verify that the ' + prepared.pluginName + ' Tool Pack is loaded.",\n'
      + '    permission="read",\n'
      + '    category="' + prepared.pluginName + '",\n'
      + '    tags=["tool-pack", "smoke"],\n'
      + '    result_type="json",\n'
      + ')\n'
      + 'def ping(payload: dict[str, Any]) -> dict[str, Any]:\n'
      + '    return {"message": "pong", "echo": payload}\n'
    writeExclusive(
      join(prepared.pythonPackageDirectory, 'commands.py'),
      commandsSource,
      createdFiles,
    )

    writeFileSync(
      descriptorTempPath,
      JSON.stringify(prepared.descriptor, null, 2) + '\n',
      { encoding: 'utf8', flag: 'wx' },
    )
    renameSync(descriptorTempPath, prepared.descriptorPath)
    descriptorPublished = true
  } catch (error) {
    if (!descriptorPublished) {
      if (existsSync(descriptorTempPath)) rmSync(descriptorTempPath, { force: true })
      for (const path of createdFiles.reverse()) {
        if (existsSync(path)) rmSync(path, { force: true })
      }
      for (const path of createdDirectories.reverse()) {
        if (existsSync(path)) rmSync(path, { recursive: false, force: true })
      }
    }
    throw error
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const prepared = prepare(options)
  if (!options.dryRun) applyPrepared(prepared)
  const action = options.dryRun ? 'Would add' : 'Added'
  process.stdout.write(
    action
      + ' Tool Pack "' + prepared.id + '" to '
      + prepared.pluginDirectory
      + ' using Python package '
      + prepared.pythonPackage
      + '.\n',
  )
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write('add-tool-pack: ' + message + '\n')
  process.exitCode = 1
}
