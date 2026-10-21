import { describe, expect, it } from 'vitest'
import type { AppEvent, ConnectRequest, Session } from '@shared/types'
import { LocalShellManager, resolveDefaultShell } from '../../src/main/local/manager'

const SESSION: Session = {
  id: 'local-test',
  name: '本地终端',
  folderId: null,
  host: 'localhost',
  port: 1,
  username: 'tester',
  auth: { method: 'agent' },
  connectionType: 'local',
  terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
  createdAt: 0,
  updatedAt: 0
}

const RUNTIME = 'rt-local-test'

function request(): ConnectRequest {
  return { runtimeId: RUNTIME, session: SESSION, cols: 80, rows: 24 }
}

async function waitFor(check: () => boolean, timeout = 8000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('LocalShellManager', () => {
  it('spawns the default shell, forwards data and applies resize', async () => {
    const events: AppEvent[] = []
    const manager = new LocalShellManager(
      (event) => events.push(event),
      { file: '/bin/sh', args: [] }
    )
    const output = (): string =>
      events
        .filter((event) => event.type === 'ssh:data')
        .map((event) => Buffer.from((event as { data: Uint8Array }).data).toString('utf8'))
        .join('')
    const statuses = (): string[] =>
      events
        .filter((event) => event.type === 'ssh:status')
        .map((event) => (event as { status: string }).status)

    await manager.connect(request())
    expect(manager.has(RUNTIME)).toBe(true)
    await waitFor(() => statuses().includes('connected'))

    manager.resize(RUNTIME, 100, 30)
    manager.write(RUNTIME, "printf 'LOCAL_PTY_%s\\n' OK; stty size\n")
    await waitFor(() => output().includes('LOCAL_PTY_OK') && /\b30 100\b/.test(output()))

    manager.disconnect(RUNTIME)
    expect(manager.has(RUNTIME)).toBe(false)
    expect(statuses().at(-1)).toBe('closed')
  })

  it('reports the exit code when the shell exits on its own', async () => {
    const events: AppEvent[] = []
    const manager = new LocalShellManager(
      (event) => events.push(event),
      { file: '/bin/sh', args: [] }
    )
    await manager.connect(request())
    manager.write(RUNTIME, 'exit 7\n')
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'ssh:status' &&
          event.status === 'closed' &&
          /退出码 7/.test(event.message ?? '')
      )
    )
    expect(manager.has(RUNTIME)).toBe(false)
  })

  it('does not treat a manually closed shell as an unexpected exit', async () => {
    const events: AppEvent[] = []
    const manager = new LocalShellManager(
      (event) => events.push(event),
      { file: '/bin/sh', args: [] }
    )
    await manager.connect(request())
    manager.disconnect(RUNTIME)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const closed = events.filter(
      (event) => event.type === 'ssh:status' && event.status === 'closed'
    )
    expect(closed).toHaveLength(1)
    expect(closed[0]).not.toHaveProperty('message')
  })
})

describe('resolveDefaultShell', () => {
  it('uses the configured shell on Unix with a login flag', () => {
    expect(resolveDefaultShell('linux', { SHELL: '/bin/sh' })).toEqual({
      file: '/bin/sh',
      args: ['-l']
    })
  })

  it('ignores a missing or relative Unix shell', () => {
    const spec = resolveDefaultShell('linux', { SHELL: 'not-a-path' })
    expect(spec.file.startsWith('/')).toBe(true)
    expect(spec.args).toEqual(['-l'])
  })

  it('uses COMSPEC on Windows', () => {
    expect(resolveDefaultShell('win32', { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' })).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: []
    })
  })
})
