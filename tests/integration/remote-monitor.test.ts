import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils, type Connection } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppEvent, Session } from '@shared/types'
import { KnownHosts } from '../../src/main/ssh/known-hosts'
import { SshManager } from '../../src/main/ssh/manager'

const SESSION: Session = {
  id: 's-monitor',
  name: 'monitor-test',
  folderId: null,
  host: '127.0.0.1',
  port: 22,
  username: 'tester',
  auth: { method: 'password', password: 'anything' },
  terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
  createdAt: 0,
  updatedAt: 0
}

const RUNTIME = 'rt-monitor'

function output(options: { stat: string; now: string; rx: number; tx: number }): string {
  return [
    '@@stat',
    options.stat,
    'cpu0 50 10 15 425 0 0 0 0 0 0',
    'cpu1 50 10 15 425 0 0 0 0 0 0',
    '@@mem',
    'MemTotal:       16000000 kB',
    'MemAvailable:    6000000 kB',
    'SwapTotal:       4000000 kB',
    'SwapFree:        3900000 kB',
    '@@uptime',
    '123456.78 987654.32',
    '@@net',
    `  eth0: ${options.rx} 0 0 0 0 0 0 0 ${options.tx} 0 0 0 0 0 0 0`,
    '@@load',
    '0.42 0.30 0.20 1/100 1234',
    '@@df',
    'Filesystem     1024-blocks    Used Available Capacity Mounted on',
    '/dev/sda1        134217728 85899346  48318382      64% /',
    '@@now',
    options.now
  ].join('\n')
}

interface FakeSshServer {
  port: number
  close(): Promise<void>
}

async function startSshServer(replies: string[]): Promise<FakeSshServer> {
  const { private: hostKey } = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const connections = new Set<Connection>()
  let index = 0
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', (ctx) => ctx.accept())
    connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('shell', (acceptShell) => acceptShell()?.write('ready\r\n'))
      session.on('exec', (acceptExec) => {
        const stream = acceptExec()
        const reply = replies[Math.min(index, replies.length - 1)]
        index += 1
        stream.write(reply)
        stream.exit(0)
        stream.end()
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

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('remote monitor sampling', () => {
  let server: FakeSshServer | null = null
  let manager: SshManager | null = null

  afterEach(async () => {
    manager?.disconnect(RUNTIME)
    manager = null
    await server?.close()
    server = null
  })

  it('returns parsed values and computes deltas across samples', async () => {
    server = await startSshServer([
      output({
        stat: 'cpu  100 20 30 850 0 0 0 0 0 0',
        now: '1700000000',
        rx: 1_000_000,
        tx: 2_000_000
      }),
      output({
        stat: 'cpu  300 20 30 1150 0 0 0 0 0 0',
        now: '1700000002',
        rx: 1_200_000,
        tx: 2_400_000
      })
    ])
    const statuses: string[] = []
    let instance: SshManager | null = null
    instance = new SshManager(
      new KnownHosts(mkdtempSync(join(tmpdir(), 'hshell-monitor-'))),
      (event: AppEvent) => {
        if (event.type === 'ssh:status') statuses.push(event.status)
        if (event.type === 'ssh:hostkey') instance?.hostKeyDecision(event.prompt.requestId, true)
      }
    )
    manager = instance
    await manager.connect({
      runtimeId: RUNTIME,
      session: { ...SESSION, port: server.port },
      cols: 80,
      rows: 24
    })
    await waitFor(() => statuses.includes('connected'))

    const first = await manager.sampleMonitor(RUNTIME)
    expect(first.cores).toBe(2)
    expect(first.memTotal).toBe(16_000_000 * 1024)
    expect(first.diskTotal).toBe(134_217_728 * 1024)
    expect(first.uptime).toBeCloseTo(123456.78)
    expect(first.cpu).toBe(0)
    expect(first.netDown).toBe(0)

    const second = await manager.sampleMonitor(RUNTIME)
    expect(second.cpu).toBeCloseTo(40)
    expect(second.netDown).toBe(100_000)
    expect(second.netUp).toBe(200_000)
    expect(second.timestamp).toBe(1_700_000_002_000)
  })

  it('rejects sampling when the runtime is not connected', async () => {
    manager = new SshManager(
      new KnownHosts(mkdtempSync(join(tmpdir(), 'hshell-monitor-'))),
      () => undefined
    )
    await expect(manager.sampleMonitor('missing')).rejects.toThrow(/未连接/)
  })
})
