import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import {
  attachStoredCredentials,
  jumpCredentialId,
  serialLoginCredentialId,
  sessionCredentialId
} from '../../src/main/storage/session-credentials'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-cred',
    name: 'credential-test',
    folderId: null,
    host: '127.0.0.1',
    port: 22,
    username: 'target-user',
    auth: { method: 'password' },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('attachStoredCredentials', () => {
  it('restores the target and per-hop passwords independently', () => {
    const saved = new Map([
      [sessionCredentialId('s-cred'), 'target-secret'],
      [jumpCredentialId('s-cred', 'jump-1'), 'hop-secret']
    ])

    const restored = attachStoredCredentials(
      makeSession({
        jumpHosts: [
          {
            id: 'jump-1',
            host: 'bastion',
            port: 22,
            username: 'jump-user',
            auth: { method: 'password', savePassword: true }
          },
          {
            id: 'jump-2',
            host: 'bastion-2',
            port: 22,
            username: '',
            auth: { method: 'agent' }
          }
        ]
      }),
      { get: (id) => saved.get(id) ?? null }
    )

    expect(restored.auth.password).toBe('target-secret')
    expect(restored.jumpHosts?.[0].auth).toMatchObject({
      method: 'password',
      password: 'hop-secret'
    })
    expect(restored.jumpHosts?.[1].auth?.password).toBeUndefined()
  })

  it('keeps explicit passwords without consulting the store', () => {
    let lookups = 0
    const restored = attachStoredCredentials(
      makeSession({
        auth: { method: 'password', password: 'typed-target' },
        jumpHosts: [
          {
            id: 'jump-1',
            host: 'bastion',
            port: 22,
            username: 'jump-user',
            auth: { method: 'password', password: 'typed-hop' }
          }
        ]
      }),
      {
        get: () => {
          lookups += 1
          return 'saved'
        }
      }
    )

    expect(restored.auth.password).toBe('typed-target')
    expect(restored.jumpHosts?.[0].auth?.password).toBe('typed-hop')
    expect(lookups).toBe(0)
  })

  it('leaves hops that inherit the session auth untouched', () => {
    const restored = attachStoredCredentials(
      makeSession({
        jumpHosts: [{ id: 'jump-1', host: 'bastion', port: 22, username: 'jump-user' }]
      }),
      { get: () => 'saved' }
    )

    expect(restored.auth.password).toBe('saved')
    expect(restored.jumpHosts?.[0].auth).toBeUndefined()
  })

  it('restores a saved serial console login password only when opted in', () => {
    const serial = {
      path: '/dev/ttyUSB0',
      baudRate: 115200,
      dataBits: 8 as const,
      stopBits: 1 as const,
      parity: 'none' as const,
      flowControl: 'none' as const
    }
    const saved = new Map([[serialLoginCredentialId('s-cred'), 'console-secret']])
    const lookup = { get: (id: string) => saved.get(id) ?? null }

    const restored = attachStoredCredentials(
      makeSession({
        connectionType: 'serial',
        serial: { ...serial, login: { enabled: true, username: 'root', savePassword: true } }
      }),
      lookup
    )
    expect(restored.serial?.login?.password).toBe('console-secret')

    const memoryOnly = attachStoredCredentials(
      makeSession({
        connectionType: 'serial',
        serial: { ...serial, login: { enabled: true, username: 'root' } }
      }),
      lookup
    )
    expect(memoryOnly.serial?.login?.password).toBeUndefined()
  })
})
