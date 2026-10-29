import { describe, expect, it } from 'vitest'
import type { AiBindAddress, AiMcpInfo } from '@shared/types'
import {
  ANY_HOST,
  LOOPBACK,
  defaultEndpointHost,
  endpointHosts,
  endpointUrl,
  initialEndpointHost,
  isPlausibleHost,
  normalizeEndpointHost
} from '../../src/renderer/src/lib/mcp-endpoint'

const BINDINGS: AiBindAddress[] = [
  { name: 'Ethernet', address: '10.55.67.94' },
  { name: 'VMware Network Adapter VMnet8', address: '192.168.179.1' }
]

function info(overrides: Partial<AiMcpInfo> = {}): AiMcpInfo {
  return {
    url: 'http://10.55.67.94:62645/mcp',
    token: 'token',
    host: ANY_HOST,
    port: 62645,
    ...overrides
  }
}

describe('MCP client address', () => {
  it('keeps the listen address and the client address separate', () => {
    const any = info()
    expect(endpointHosts(any, BINDINGS)).toEqual([
      LOOPBACK,
      '10.55.67.94',
      '192.168.179.1'
    ])
    expect(endpointUrl(any, '192.168.179.1')).toBe('http://192.168.179.1:62645/mcp')

    const nic = info({ host: '10.55.67.94', url: 'http://10.55.67.94:62645/mcp' })
    expect(endpointHosts(nic, BINDINGS)).toEqual(['10.55.67.94'])
    expect(endpointHosts(info({ host: LOOPBACK }), BINDINGS)).toEqual([LOOPBACK])
  })

  it('accepts pasted URLs and strips the scheme, port and path', () => {
    expect(normalizeEndpointHost('http://10.0.2.2:62645/mcp')).toBe('10.0.2.2')
    expect(normalizeEndpointHost('10.0.2.2:62645')).toBe('10.0.2.2')
    expect(normalizeEndpointHost('  mcp.example.com  ')).toBe('mcp.example.com')
    expect(normalizeEndpointHost('[::1]:62645')).toBe('[::1]')
  })

  it('only accepts bare host names and addresses', () => {
    expect(isPlausibleHost('10.0.2.2')).toBe(true)
    expect(isPlausibleHost('mcp.internal')).toBe(true)
    expect(isPlausibleHost('[::1]')).toBe(true)
    expect(isPlausibleHost('')).toBe(false)
    expect(isPlausibleHost('two words')).toBe(false)
    expect(isPlausibleHost('http://host')).toBe(false)
  })

  it('prefers a saved address that still reaches the current binding', () => {
    expect(initialEndpointHost(info(), BINDINGS, '192.168.179.1')).toEqual({
      host: '192.168.179.1',
      custom: ''
    })
    expect(defaultEndpointHost(info())).toBe('10.55.67.94')
  })

  it('restores custom NAT or hostname entries only when the server is exposed', () => {
    expect(initialEndpointHost(info(), BINDINGS, '10.0.2.2')).toEqual({
      host: 'custom',
      custom: '10.0.2.2'
    })
    expect(initialEndpointHost(info(), BINDINGS, 'mcp.example.com')).toEqual({
      host: 'custom',
      custom: 'mcp.example.com'
    })
    // A loopback binding cannot be reached through a custom address.
    expect(
      initialEndpointHost(info({ host: LOOPBACK, url: 'http://127.0.0.1:62645/mcp' }), BINDINGS, '10.0.2.2')
    ).toEqual({ host: LOOPBACK, custom: '' })
  })
})
