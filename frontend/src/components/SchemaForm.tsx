import type { ChangeEvent } from 'react'
import { formatRecentTime, type RecentExecution } from '../recent-executions'
import { decodeEnumOption, encodeEnumOption } from '../schema-form'
import {
  formatSchemaDefault,
} from '../hooks/useCommandPayloads'
import {
  isStructuredProperty,
  propertyHasType,
  type CommandMetadata,
  type DraftValue,
  type SchemaProperty,
} from '../types/command'

type SchemaFormProps = {
  command: CommandMetadata
  recentExecutions: RecentExecution[]
  getFieldValue: (command: CommandMetadata, fieldName: string, property: SchemaProperty) => DraftValue
  onClear: (command: CommandMetadata) => void
  onFieldChange: (commandName: string, fieldName: string, value: DraftValue) => void
  onLoadDefaults: (command: CommandMetadata) => void
  onLoadPayload: (command: CommandMetadata, payload: Record<string, unknown>) => void
}

function describeFieldConstraints(property: SchemaProperty) {
  const constraints: string[] = []

  if (typeof property.minimum === 'number') constraints.push(`min ${property.minimum}`)
  if (typeof property.maximum === 'number') constraints.push(`max ${property.maximum}`)
  if (typeof property.exclusiveMinimum === 'number') constraints.push(`> ${property.exclusiveMinimum}`)
  if (typeof property.exclusiveMaximum === 'number') constraints.push(`< ${property.exclusiveMaximum}`)
  if (typeof property.minLength === 'number') constraints.push(`min length ${property.minLength}`)
  if (typeof property.maxLength === 'number') constraints.push(`max length ${property.maxLength}`)
  if (typeof property.minItems === 'number') constraints.push(`min items ${property.minItems}`)
  if (typeof property.maxItems === 'number') constraints.push(`max items ${property.maxItems}`)
  if (property.default !== undefined) constraints.push(`default ${formatSchemaDefault(property.default)}`)

  return constraints.join(' | ')
}

function FieldHint({ property }: { property: SchemaProperty }) {
  const constraints = describeFieldConstraints(property)

  if (!property.description && !constraints) {
    return null
  }

  return <small>{[property.description, constraints].filter(Boolean).join(' | ')}</small>
}

function SchemaField({
  command,
  fieldName,
  getFieldValue,
  onFieldChange,
  property,
}: {
  command: CommandMetadata
  fieldName: string
  getFieldValue: SchemaFormProps['getFieldValue']
  onFieldChange: SchemaFormProps['onFieldChange']
  property: SchemaProperty
}) {
  const value = getFieldValue(command, fieldName, property)
  const required = command.schema.required?.includes(fieldName)
  const inputId = `${command.name}-${fieldName}`

  if (property.enum && property.enum.length > 0) {
    const selectedValue = value === '' ? '' : encodeEnumOption(value)
    return (
      <label className="schema-field" htmlFor={inputId}>
        <span>
          {fieldName}
          {required ? <em>*</em> : null}
        </span>
        <select
          id={inputId}
          value={selectedValue}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => {
            const nextValue = event.target.value
            onFieldChange(command.name, fieldName, nextValue === '' ? '' : decodeEnumOption(nextValue))
          }}
        >
          <option value="">Select a value</option>
          {property.enum.map((option) => (
            <option key={encodeEnumOption(option)} value={encodeEnumOption(option)}>
              {String(option)}
            </option>
          ))}
        </select>
        <FieldHint property={property} />
      </label>
    )
  }

  if (propertyHasType(property, 'boolean')) {
    return (
      <label
        className={property.xDryRun ? 'schema-field checkbox dry-run-field' : 'schema-field checkbox'}
        htmlFor={inputId}
      >
        <input
          id={inputId}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onFieldChange(command.name, fieldName, event.target.checked)
          }
        />
        <span>
          {fieldName}
          {required ? <em>*</em> : null}
        </span>
        <FieldHint property={property} />
      </label>
    )
  }

  if (isStructuredProperty(property)) {
    return (
      <label className="schema-field" htmlFor={inputId}>
        <span>
          {fieldName}
          {required ? <em>*</em> : null}
        </span>
        <textarea
          id={inputId}
          value={String(value)}
          placeholder={propertyHasType(property, 'array') ? '[]' : '{}'}
          rows={5}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            onFieldChange(command.name, fieldName, event.target.value)
          }
        />
        <FieldHint property={property} />
      </label>
    )
  }

  if (propertyHasType(property, 'string') && typeof property.maxLength === 'number' && property.maxLength > 160) {
    return (
      <label className="schema-field" htmlFor={inputId}>
        <span>
          {fieldName}
          {required ? <em>*</em> : null}
        </span>
        <textarea
          id={inputId}
          value={String(value)}
          minLength={property.minLength}
          maxLength={property.maxLength}
          rows={4}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            onFieldChange(command.name, fieldName, event.target.value)
          }
        />
        <FieldHint property={property} />
      </label>
    )
  }

  return (
    <label className="schema-field" htmlFor={inputId}>
      <span>
        {fieldName}
        {required ? <em>*</em> : null}
      </span>
      <input
        id={inputId}
        type={propertyHasType(property, 'number') || propertyHasType(property, 'integer') ? 'number' : 'text'}
        value={String(value)}
        min={property.minimum}
        max={property.maximum}
        minLength={property.minLength}
        maxLength={property.maxLength}
        step={propertyHasType(property, 'integer') ? 1 : undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onFieldChange(command.name, fieldName, event.target.value)
        }
      />
      <FieldHint property={property} />
    </label>
  )
}

export function SchemaForm({
  command,
  getFieldValue,
  onClear,
  onFieldChange,
  onLoadDefaults,
  onLoadPayload,
  recentExecutions,
}: SchemaFormProps) {
  const properties = Object.entries(command.schema.properties || {})
  const recentForCommand = recentExecutions.filter((item) => item.command === command.name).slice(0, 3)

  return (
    <>
      <div className="schema-form">
        {properties.length > 0 ? (
          properties.map(([fieldName, property]) => (
            <SchemaField
              command={command}
              fieldName={fieldName}
              getFieldValue={getFieldValue}
              key={fieldName}
              onFieldChange={onFieldChange}
              property={property}
            />
          ))
        ) : (
          <p className="muted">No payload fields.</p>
        )}
      </div>
      <div className="payload-presets">
        <button type="button" onClick={() => onLoadDefaults(command)}>
          Defaults
        </button>
        <button type="button" onClick={() => onClear(command)}>
          Clear
        </button>
        {recentForCommand.map((item) => (
          <button type="button" key={item.id} onClick={() => onLoadPayload(command, item.payload)}>
            {item.mode === 'task' ? 'Task' : 'Run'} {formatRecentTime(item.ranAt)}
          </button>
        ))}
      </div>
    </>
  )
}
