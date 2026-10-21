import { describe, expect, it } from 'vitest'
import {
  isLocalSession,
  isNonSshSession,
  isSerialSession,
  sessionTarget
} from '@shared/session'
import type { Session } from '@shared/types'
import { localShellTitle } from '../../src/renderer/src/lib/local-session'

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    name: '本地终端',
    folderId: null,
    host: 'localhost',
    port: 1,
    username: 'tester',
    auth: { method: 'agent' },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    connectionType: 'local',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('local session helpers', () => {
  it('identifies local sessions and treats them as non-SSH', () => {
    expect(isLocalSession(session())).toBe(true)
    expect(isSerialSession(session())).toBe(false)
    expect(isNonSshSession(session())).toBe(true)
    expect(isNonSshSession(session({ connectionType: 'serial' }))).toBe(true)
    expect(isNonSshSession(session({ connectionType: 'ssh' }))).toBe(false)
    expect(isNonSshSession(null)).toBe(false)
  })

  it('uses the tab name as the target instead of a host', () => {
    expect(sessionTarget(session({ name: '本地终端 2' }))).toBe('本地终端 2')
    expect(sessionTarget(session({ connectionType: 'ssh', host: '10.0.0.2', username: 'root' }))).toBe(
      'root@10.0.0.2:1'
    )
  })
})

describe('localShellTitle', () => {
  it('numbers additional local shells', () => {
    expect(localShellTitle('本地终端', [])).toBe('本地终端')
    expect(localShellTitle('本地终端', ['本地终端'])).toBe('本地终端 2')
    expect(localShellTitle('本地终端', ['本地终端', '本地终端 2'])).toBe('本地终端 3')
    expect(localShellTitle('本地终端', ['本地终端', '本地终端 3'])).toBe('本地终端 2')
  })
})
