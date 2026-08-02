import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BridgeCallError,
  BridgeProtocolError,
  formatBridgeError,
  parseBridgeResponse,
  useEditorBridge,
} from './bridge'

afterEach(() => {
  delete window.ue
})

describe('parseBridgeResponse', () => {
  it('rejects invalid JSON with method context', () => {
    expect(() => parseBridgeResponse('listtasks', '<html>failure</html>')).toThrowError(
      new BridgeProtocolError('listtasks', 'response is not valid JSON: <html>failure</html>', '<html>failure</html>'),
    )
  })

  it.each([null, false, 0])('accepts a successful response containing result %j', (result) => {
    expect(parseBridgeResponse('executecommand', JSON.stringify({ id: null, ok: true, result }))).toEqual({
      id: null,
      ok: true,
      result,
    })
  })

  it.each([null, [], 42, 'value'])('rejects non-object JSON value %j', (value) => {
    expect(() => parseBridgeResponse('listtasks', JSON.stringify(value))).toThrow(
      'response must be a JSON object',
    )
  })

  it('bounds the response preview attached to protocol errors', () => {
    const rawResponse = 'x'.repeat(500)
    let protocolError: unknown
    try {
      parseBridgeResponse('gettask', rawResponse)
    } catch (error) {
      protocolError = error
    }

    expect(protocolError).toBeInstanceOf(BridgeProtocolError)
    expect((protocolError as BridgeProtocolError).responsePreview).toHaveLength(201)
    expect((protocolError as BridgeProtocolError).responsePreview?.endsWith('…')).toBe(true)
  })

  it.each([
    ['non-string response', undefined, 'response must be a JSON string'],
    ['missing ok', { id: null, result: {} }, 'field "ok" must be a boolean'],
    ['invalid id', { id: 42, ok: true, result: {} }, 'field "id" must be a string or null'],
    ['missing result', { id: null, ok: true }, 'missing field "result"'],
    ['missing error', { id: null, ok: false }, 'missing object field "error"'],
    [
      'invalid error fields',
      { id: null, ok: false, error: { code: '', message: '' } },
      'requires non-empty "error.code"',
    ],
    [
      'invalid details',
      { id: null, ok: false, error: { code: 'bad', message: 'failed', details: [1] } },
      '"error.details" must be an array of strings',
    ],
    [
      'invalid traceback',
      { id: null, ok: false, error: { code: 'bad', message: 'failed', traceback: [] } },
      '"error.traceback" must be a string',
    ],
  ])('rejects a malformed envelope: %s', (_label, response, expectedMessage) => {
    const rawResponse = response === undefined ? response : JSON.stringify(response)
    expect(() => parseBridgeResponse('gettask', rawResponse)).toThrow(expectedMessage)
  })
})

describe('useEditorBridge', () => {
  it('becomes ready when Unreal publishes a delayed JavaScript binding', () => {
    const { result } = renderHook(() => useEditorBridge())
    expect(result.current.bridgeReady).toBe(false)

    window.ue = {
      editorwebui: {
        executecommand: vi.fn(),
        startcommand: vi.fn(),
        gettask: vi.fn(),
        listtasks: vi.fn(),
        removetask: vi.fn(),
        canceltask: vi.fn(),
        getwebuisettings: vi.fn(),
        setwebuisettings: vi.fn(),
      },
    }

    act(() => {
      document.dispatchEvent(new CustomEvent('ue:ready'))
    })

    expect(result.current.bridgeReady).toBe(true)
  })

  it('uses shared validation and preserves structured bridge errors', async () => {
    window.ue = {
      editorwebui: {
        executecommand: vi.fn(async () => JSON.stringify({
          id: 'req-1',
          ok: false,
          error: { code: 'invalid_payload', message: 'Payload failed.', details: ['name is required'] },
        })),
        startcommand: vi.fn(async () => '{not json'),
        gettask: vi.fn(),
        listtasks: vi.fn(),
        removetask: vi.fn(),
        canceltask: vi.fn(),
        getwebuisettings: vi.fn(),
        setwebuisettings: vi.fn(),
      },
    }
    const log = vi.fn()
    const { result } = renderHook(() => useEditorBridge(log))

    let callError: unknown
    await act(async () => {
      try {
        await result.current.callBridge('executecommand', '{}')
      } catch (error) {
        callError = error
      }
    })

    expect(callError).toBeInstanceOf(BridgeCallError)
    expect(callError).toMatchObject({
      methodName: 'executecommand',
      code: 'invalid_payload',
      details: ['name is required'],
      requestId: 'req-1',
    })
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('error id=req-1 code=invalid_payload'))

    await expect(result.current.callBridgeQuiet('startcommand', '{}')).rejects.toMatchObject({
      name: 'BridgeProtocolError',
      methodName: 'startcommand',
    })
    expect(log).toHaveBeenCalledOnce()
  })

  it('logs bounded response metadata instead of serializing successful payloads', async () => {
    const secret = 'do-not-copy-this-result'.repeat(100)
    window.ue = {
      editorwebui: {
        executecommand: vi.fn(async () => JSON.stringify({ id: 'req-2', ok: true, result: { secret } })),
        startcommand: vi.fn(),
        gettask: vi.fn(),
        listtasks: vi.fn(),
        removetask: vi.fn(),
        canceltask: vi.fn(),
        getwebuisettings: vi.fn(),
        setwebuisettings: vi.fn(),
      },
    }
    const log = vi.fn()
    const { result } = renderHook(() => useEditorBridge(log))

    await act(async () => {
      await result.current.callBridge('executecommand', '{}')
    })

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^executecommand -> ok id=req-2 result=object\(1: secret\) chars=\d+$/))
    expect(log.mock.calls[0][0]).not.toContain(secret)
  })
})

describe('formatBridgeError', () => {
  it('includes structured error context for user-visible failures', () => {
    expect(formatBridgeError(new BridgeCallError('executecommand', 'invalid_payload', 'Payload failed.', ['name is required'], 'req-3'))).toBe(
      '[invalid_payload] Payload failed. — name is required (request req-3)',
    )
  })
})
