import { describe, expect, it } from 'vitest'
import { parseQuickConnect } from '../../src/renderer/src/lib/quick-connect'

describe('parseQuickConnect', () => {
  it('parses user@host:port', () => {
    expect(parseQuickConnect('root@10.0.0.1:2222', 'demo')).toEqual({
      username: 'root',
      host: '10.0.0.1',
      port: 2222
    })
  })

  it('defaults user and port', () => {
    expect(parseQuickConnect('example.com', 'demo')).toEqual({
      username: 'demo',
      host: 'example.com',
      port: 22
    })
  })

  it('supports ipv6-like bare host without treating it as a port', () => {
    expect(parseQuickConnect('admin@example.com', 'demo')).toEqual({
      username: 'admin',
      host: 'example.com',
      port: 22
    })
  })

  it('rejects empty input', () => {
    expect(parseQuickConnect('   ', 'demo')).toBeNull()
  })

  it('clamps out-of-range ports', () => {
    expect(parseQuickConnect('host:99999', 'demo')?.port).toBe(65535)
    expect(parseQuickConnect('host:0', 'demo')?.port).toBe(1)
  })
})
