import { useState } from 'react'
import {
  isStructuredProperty,
  propertyHasType,
  type CommandMetadata,
  type DraftValue,
  type SchemaProperty,
} from '../types/command'
import { isSchemaScalar, parseNumericDraft } from '../schema-form'

export function formatSchemaDefault(value: unknown) {
  if (value === undefined) {
    return ''
  }

  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function getDefaultValue(property: SchemaProperty): DraftValue {
  if (property.default !== undefined) {
    if (property.enum && isSchemaScalar(property.default) && property.enum.includes(property.default)) {
      return property.default
    }
    if (propertyHasType(property, 'boolean')) {
      return property.default === true
    }

    if (isStructuredProperty(property)) {
      return JSON.stringify(property.default, null, 2)
    }

    return String(property.default)
  }

  return propertyHasType(property, 'boolean') ? false : ''
}

export function useCommandPayloads() {
  const [payloadDrafts, setPayloadDrafts] = useState<Record<string, Record<string, DraftValue>>>({})

  function getFieldValue(command: CommandMetadata, fieldName: string, property: SchemaProperty) {
    return payloadDrafts[command.name]?.[fieldName] ?? getDefaultValue(property)
  }

  function updateField(commandName: string, fieldName: string, value: DraftValue) {
    setPayloadDrafts((drafts) => ({
      ...drafts,
      [commandName]: {
        ...(drafts[commandName] || {}),
        [fieldName]: value,
      },
    }))
  }

  function getDraftFromPayload(command: CommandMetadata, payload: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(command.schema.properties || {}).map(([fieldName, property]) => {
        const payloadValue = payload[fieldName]
        if (payloadValue === undefined) {
          return [fieldName, getDefaultValue(property)]
        }

        if (property.enum && isSchemaScalar(payloadValue)) {
          return [fieldName, payloadValue]
        }

        if (propertyHasType(property, 'boolean')) {
          return [fieldName, payloadValue === true]
        }

        if (isStructuredProperty(property)) {
          return [fieldName, JSON.stringify(payloadValue, null, 2)]
        }

        return [fieldName, String(payloadValue)]
      }),
    ) as Record<string, DraftValue>
  }

  function loadPayloadDraft(command: CommandMetadata, payload: Record<string, unknown>) {
    setPayloadDrafts((drafts) => ({
      ...drafts,
      [command.name]: getDraftFromPayload(command, payload),
    }))
  }

  function loadSchemaDefaults(command: CommandMetadata) {
    loadPayloadDraft(command, {})
  }

  function clearPayloadDraft(command: CommandMetadata) {
    const cleared = Object.fromEntries(
      Object.entries(command.schema.properties || {}).map(([fieldName, property]) => [
        fieldName,
        property.enum ? '' : propertyHasType(property, 'boolean') ? false : '',
      ]),
    ) as Record<string, DraftValue>

    setPayloadDrafts((drafts) => ({
      ...drafts,
      [command.name]: cleared,
    }))
  }

  function buildPayload(command: CommandMetadata) {
    const payload: Record<string, unknown> = {}
    const properties = Object.entries(command.schema.properties || {})
    const required = new Set(command.schema.required || [])

    for (const [fieldName, property] of properties) {
      const rawValue = getFieldValue(command, fieldName, property)

      if (property.enum && rawValue === '') {
        if (required.has(fieldName)) {
          throw new Error(`${command.name}.${fieldName} is required`)
        }
        continue
      }

      if (propertyHasType(property, 'boolean')) {
        payload[fieldName] = Boolean(rawValue)
        continue
      }

      if (isStructuredProperty(property)) {
        const jsonText = String(rawValue).trim()
        if (jsonText === '' && !required.has(fieldName)) {
          continue
        }

        let parsedValue: unknown
        try {
          parsedValue = JSON.parse(jsonText)
        } catch {
          throw new Error(`${command.name}.${fieldName} must be valid JSON`)
        }

        const allowsArray = propertyHasType(property, 'array')
        const allowsObject = propertyHasType(property, 'object')
        const isArray = Array.isArray(parsedValue)
        const isObject = parsedValue !== null && typeof parsedValue === 'object' && !isArray

        if (!((allowsArray && isArray) || (allowsObject && isObject))) {
          const expected = allowsArray && allowsObject ? 'JSON array or object' : allowsArray ? 'JSON array' : 'JSON object'
          throw new Error(`${command.name}.${fieldName} must be a ${expected}`)
        }

        payload[fieldName] = parsedValue
        continue
      }

      if (propertyHasType(property, 'number') || propertyHasType(property, 'integer')) {
        if (rawValue === '' && !required.has(fieldName)) {
          continue
        }

        payload[fieldName] = parseNumericDraft(rawValue, propertyHasType(property, 'integer'), `${command.name}.${fieldName}`)
        continue
      }

      const stringValue = String(rawValue)
      if (stringValue === '' && !required.has(fieldName)) {
        continue
      }

      payload[fieldName] = stringValue
    }

    return payload
  }

  return {
    buildPayload,
    clearPayloadDraft,
    getFieldValue,
    loadPayloadDraft,
    loadSchemaDefaults,
    updateField,
  }
}

