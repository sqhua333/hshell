import { describe, expect, it } from 'vitest'
import type { SerialOptions, Session } from '@shared/types'
import {
  isSerialSession,
  serialFrame,
  serialTarget,
  sessionTarget
} from '@shared/session'
import { normalizeSerialOptions } from '../../src/main/serial/manager'

const BASE: SerialOptions = {
  path: '/dev/ttyUSB0',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none'
}

describe('normalizeSerialOptions', () => {
  it('accepts a typical 8N1 configuration and trims the path', () => {
    expect(normalizeSerialOptions({ ...BASE, path: '  /dev/ttyUSB0  ' })).toEqual({
      ...BASE,
      dtr: undefined,
      rts: undefined
    })
  })

  it('accepts every supported framing and flow-control value', () => {
    for (const dataBits of [5, 6, 7, 8] as const) {
      for (const stopBits of [1, 1.5, 2] as const) {
        for (const parity of ['none', 'even', 'odd', 'mark', 'space'] as const) {
          const result = normalizeSerialOptions({ ...BASE, dataBits, stopBits, parity })
          expect(result.dataBits).toBe(dataBits)
          expect(result.stopBits).toBe(stopBits)
          expect(result.parity).toBe(parity)
        }
      }
    }
    for (const flowControl of ['none', 'rtscts', 'xonxoff'] as const) {
      expect(normalizeSerialOptions({ ...BASE, flowControl }).flowControl).toBe(flowControl)
    }
  })

  it('keeps explicit modem control line states', () => {
    expect(normalizeSerialOptions({ ...BASE, dtr: false, rts: true })).toMatchObject({
      dtr: false,
      rts: true
    })
  })

  it('rejects a missing or blank device path', () => {
    expect(() => normalizeSerialOptions(undefined)).toThrow('缺少设备配置')
    expect(() => normalizeSerialOptions({ ...BASE, path: '   ' })).toThrow('请输入串口设备路径')
  })

  it('rejects control characters in the device path', () => {
    expect(() => normalizeSerialOptions({ ...BASE, path: '/dev/tty\u0000USB0' })).toThrow(
      '非法字符'
    )
  })

  it.each([49, 4_000_001, 115200.5, Number.NaN])('rejects baud rate %s', (baudRate) => {
    expect(() => normalizeSerialOptions({ ...BASE, baudRate })).toThrow('波特率')
  })

  it('rejects an unsupported data-bit count', () => {
    expect(() =>
      normalizeSerialOptions({ ...BASE, dataBits: 9 as unknown as SerialOptions['dataBits'] })
    ).toThrow('数据位')
  })

  it('rejects an unsupported stop-bit count', () => {
    expect(() =>
      normalizeSerialOptions({ ...BASE, stopBits: 3 as unknown as SerialOptions['stopBits'] })
    ).toThrow('停止位')
  })

  it('rejects unknown parity and flow control', () => {
    expect(() =>
      normalizeSerialOptions({ ...BASE, parity: 'weird' as SerialOptions['parity'] })
    ).toThrow('校验')
    expect(() =>
      normalizeSerialOptions({ ...BASE, flowControl: 'dtr' as SerialOptions['flowControl'] })
    ).toThrow('流控')
  })
})

describe('serial session helpers', () => {
  const session: Session = {
    id: 's1',
    name: 'router console',
    folderId: null,
    host: '/dev/ttyUSB0',
    port: 1,
    username: 'serial',
    auth: { method: 'agent' },
    connectionType: 'serial',
    serial: BASE,
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    createdAt: 0,
    updatedAt: 0
  }

  it('formats framing and target strings', () => {
    expect(serialFrame(BASE)).toBe('8N1')
    expect(serialFrame({ ...BASE, dataBits: 7, parity: 'even', stopBits: 2 })).toBe('7E2')
    expect(serialTarget(BASE)).toBe('/dev/ttyUSB0 · 115200 8N1')
  })

  it('detects serial sessions', () => {
    expect(isSerialSession(session)).toBe(true)
    expect(isSerialSession({ connectionType: 'ssh' })).toBe(false)
    expect(isSerialSession(null)).toBe(false)
    expect(isSerialSession(undefined)).toBe(false)
  })

  it('uses the serial target for serial sessions and SSH notation otherwise', () => {
    expect(sessionTarget(session)).toBe('/dev/ttyUSB0 · 115200 8N1')
    expect(
      sessionTarget({
        ...session,
        connectionType: undefined,
        serial: undefined,
        username: 'root',
        host: 'example.com',
        port: 2222
      })
    ).toBe('root@example.com:2222')
    // A serial session without options (legacy/hand-edited data) falls back.
    expect(sessionTarget({ ...session, serial: undefined })).toBe('serial@/dev/ttyUSB0:1')
  })
})
