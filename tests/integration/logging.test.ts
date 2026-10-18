import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils, type Connection } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppEvent, LogFormat, Session } from '@shared/types'
import { KnownHosts } from '../../src/main/ssh/known-hosts'
import { SshManager } from '../../src/main/ssh/manager'

const RUNTIME = 'rt-logging'
const RECORDED = 'recorded-line\r\n'

function baseSession(port: number, format: LogFormat): Session {
  return {
    id: 's-logging',
    name: 'logging test',
    folderId: null,
    host: '127.0.0.1',
    port,
    username: 'tester',
    auth: { method: 'password', password: 'anything' },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    logging: { enabled: true, format },
    createdAt: 0,
    updatedAt: 0
  }
}

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function startServer(): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const { private: hostKey } = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const connections = new Set<Connection>()
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', (ctx) => ctx.accept())
    connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        stream?.write(RECORDED)
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections) connection.end()
        server.close(() => resolve())
      })
  }
}

interface Setup {
  manager: SshManager
  logsDir: string
  output: string[]
  statuses: string[]
}

function setup(): Setup {
  const root = mkdtempSync(join(tmpdir(), 'hshell-logging-'))
  const logsDir = join(root, 'logs')
  const output: string[] = []
  const statuses: string[] = []
  const manager = new SshManager(
    new KnownHosts(join(root, 'known-hosts')),
    (event: AppEvent) => {
      if (event.type === 'ssh:status') statuses.push(event.status)
      if (event.type === 'ssh:data') output.push(Buffer.from(event.data).toString('utf8'))
      if (event.type === 'ssh:hostkey') manager.hostKeyDecision(event.prompt.requestId, true)
    },
    undefined,
    undefined,
    logsDir
  )
  return { manager, logsDir, output, statuses }
}

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

async function record(format: LogFormat): Promise<{ content: string; extension: string }> {
  const server = await startServer()
  const { manager, logsDir, output, statuses } = setup()
  cleanup.push(() => server.close())
  cleanup.push(() => manager.disconnect(RUNTIME))

  await manager.connect({
    runtimeId: RUNTIME,
    session: baseSession(server.port, format),
    cols: 80,
    rows: 24
  })
  await waitFor(() => statuses.includes('connected'))
  await waitFor(() => output.join('').includes('recorded-line'))

  manager.disconnect(RUNTIME)
  const files = readdirSync(logsDir)
  expect(files).toHaveLength(1)
  return {
    content: readFileSync(join(logsDir, files[0]), 'utf8'),
    extension: files[0].split('.').pop() ?? ''
  }
}

describe('session logging', () => {
  it('records shell output to a text log and flushes on disconnect', async () => {
    const { content, extension } = await record('text')
    expect(extension).toBe('log')
    expect(content).toContain('recorded-line')
  }, 30_000)

  it('records shell output in asciinema v2 format', async () => {
    const { content, extension } = await record('asciinema')
    expect(extension).toBe('cast')
    const lines = content.trim().split('\n')
    const header = JSON.parse(lines[0]) as { version: number; width: number; height: number }
    expect(header).toMatchObject({ version: 2, width: 80, height: 24 })
    const output = lines
      .slice(1)
      .map((line) => JSON.parse(line) as [number, string, string])
      .filter((event) => event[1] === 'o')
      .map((event) => event[2])
      .join('')
    expect(output).toContain('recorded-line')
  }, 30_000)
})
