import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils, type Connection } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppEvent, Session } from '@shared/types'
import { KnownHosts } from '../../src/main/ssh/known-hosts'
import { SshManager } from '../../src/main/ssh/manager'

const RUNTIME = 'rt-jump'

function baseSession(port: number, proxyJump: string | null): Session {
  return {
    id: 's-jump',
    name: 'jump-test',
    folderId: null,
    host: '127.0.0.1',
    port,
    username: 'tester',
    auth: { method: 'password', password: 'anything' },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    proxyJump,
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

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

interface FakeServer {
  port: number
  connections: Set<Connection>
  close(): Promise<void>
}

async function startServer(options: {
  forwarding: boolean
  acceptAuth?: boolean
  credentials?: { username: string; password: string }
}): Promise<FakeServer> {
  const { private: hostKey } = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const connections = new Set<Connection>()
  const acceptAuth = options.acceptAuth ?? true
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', (ctx) => {
      if (options.credentials) {
        if (
          ctx.method === 'password' &&
          ctx.username === options.credentials.username &&
          ctx.password === options.credentials.password
        ) {
          ctx.accept()
        } else {
          ctx.reject(['password'])
        }
        return
      }
      if (acceptAuth) ctx.accept()
      else ctx.reject(['password'])
    })
    connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('shell', (acceptShell) => acceptShell()?.write('shell-ready\r\n'))
    })
    if (options.forwarding) {
      connection.on('tcpip', (accept, _reject, info) => {
        const stream = accept()
        const upstream = net.connect({ host: info.destIP, port: info.destPort }, () => {
          stream.pipe(upstream)
          upstream.pipe(stream)
        })
        upstream.on('error', () => stream.close())
        stream.on('close', () => upstream.destroy())
        stream.on('error', () => upstream.destroy())
      })
      connection.on('request', (accept, reject) => {
        // Accept tcpip-forward requests so the hop can act as a full server.
        accept?.()
        void reject
      })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  return {
    port: (server.address() as AddressInfo).port,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections) connection.end()
        server.close(() => resolve())
      })
  }
}

interface Setup {
  manager: SshManager
  statuses: string[]
  output: string[]
  events: AppEvent[]
}

function setup(): Setup {
  const statuses: string[] = []
  const output: string[] = []
  const events: AppEvent[] = []
  const manager = new SshManager(new KnownHosts(mkdtempSync(join(tmpdir(), 'hshell-jump-'))), (event) => {
    events.push(event)
    if (event.type === 'ssh:status') statuses.push(event.status)
    if (event.type === 'ssh:data') output.push(Buffer.from(event.data).toString('utf8'))
    if (event.type === 'ssh:hostkey') manager.hostKeyDecision(event.prompt.requestId, true)
  })
  return { manager, statuses, output, events }
}

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

describe('ProxyJump', () => {
  it('connects through a jump host and opens the shell on the target', async () => {
    const final = await startServer({ forwarding: false })
    const hop = await startServer({ forwarding: true })
    const { manager, statuses, output } = setup()
    cleanup.push(() => final.close())
    cleanup.push(() => hop.close())
    cleanup.push(() => manager.disconnect(RUNTIME))

    await manager.connect({
      runtimeId: RUNTIME,
      session: baseSession(final.port, `tester@127.0.0.1:${hop.port}`),
      cols: 80,
      rows: 24
    })

    await waitFor(() => statuses.includes('connected'))
    await waitFor(() => output.join('').includes('shell-ready'))
    expect(statuses).not.toContain('failed')
    expect(hop.connections.size).toBe(1)
    expect(final.connections.size).toBe(1)
  }, 30_000)

  it('uses per-hop credentials that differ from the target', async () => {
    const final = await startServer({
      forwarding: false,
      credentials: { username: 'target-user', password: 'target-secret' }
    })
    const hop = await startServer({
      forwarding: true,
      credentials: { username: 'jump-user', password: 'jump-secret' }
    })
    const { manager, statuses, output } = setup()
    cleanup.push(() => final.close())
    cleanup.push(() => hop.close())
    cleanup.push(() => manager.disconnect(RUNTIME))

    const session = baseSession(final.port, null)
    session.username = 'target-user'
    session.auth = { method: 'password', password: 'target-secret' }
    session.jumpHosts = [
      {
        id: 'jump-1',
        host: '127.0.0.1',
        port: hop.port,
        username: 'jump-user',
        auth: { method: 'password', password: 'jump-secret' }
      }
    ]

    await manager.connect({ runtimeId: RUNTIME, session, cols: 80, rows: 24 })

    await waitFor(() => statuses.includes('connected'))
    await waitFor(() => output.join('').includes('shell-ready'))
    expect(statuses).not.toContain('failed')
    expect(hop.connections.size).toBe(1)
    expect(final.connections.size).toBe(1)
  }, 30_000)

  it('fails at the hop when its own password is wrong', async () => {
    const final = await startServer({
      forwarding: false,
      credentials: { username: 'target-user', password: 'target-secret' }
    })
    const hop = await startServer({
      forwarding: true,
      credentials: { username: 'jump-user', password: 'jump-secret' }
    })
    const { manager, statuses, events } = setup()
    cleanup.push(() => final.close())
    cleanup.push(() => hop.close())
    cleanup.push(() => manager.disconnect(RUNTIME))

    const session = baseSession(final.port, null)
    session.username = 'target-user'
    session.auth = { method: 'password', password: 'target-secret' }
    session.jumpHosts = [
      {
        id: 'jump-1',
        host: '127.0.0.1',
        port: hop.port,
        username: 'jump-user',
        auth: { method: 'password', password: 'wrong-secret' }
      }
    ]

    await manager.connect({ runtimeId: RUNTIME, session, cols: 80, rows: 24 })

    await waitFor(() => statuses.includes('failed'))
    expect(
      events.some(
        (event) =>
          event.type === 'ssh:status' &&
          event.status === 'failed' &&
          /跳板机/.test(event.message ?? '')
      )
    ).toBe(true)
    expect(final.connections.size).toBe(0)
  }, 30_000)

  it('tears down the jump hop when the target rejects authentication', async () => {
    const final = await startServer({ forwarding: false, acceptAuth: false })
    const hop = await startServer({ forwarding: true })
    const { manager, statuses, events } = setup()
    cleanup.push(() => final.close())
    cleanup.push(() => hop.close())
    cleanup.push(() => manager.disconnect(RUNTIME))

    await manager.connect({
      runtimeId: RUNTIME,
      session: baseSession(final.port, `tester@127.0.0.1:${hop.port}`),
      cols: 80,
      rows: 24
    })

    // A rejected password is not fatal anymore: the runtime waits for the
    // terminal prompt while the jump hop is torn down.
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'ssh:password-request' && event.prompt.attempt === 1
      )
    )
    await waitFor(() => hop.connections.size === 0 && final.connections.size === 0)
    expect(statuses).not.toContain('reconnecting')
    expect(statuses).not.toContain('failed')
    expect(final.connections.size).toBe(0)
  }, 30_000)

  it('fails fast on an unparseable ProxyJump value', async () => {
    const final = await startServer({ forwarding: false })
    const { manager, statuses, events } = setup()
    cleanup.push(() => final.close())
    cleanup.push(() => manager.disconnect(RUNTIME))

    await manager.connect({
      runtimeId: RUNTIME,
      session: baseSession(final.port, 'bad host'),
      cols: 80,
      rows: 24
    })

    await waitFor(() => statuses.includes('failed'))
    expect(events.some((event) => event.type === 'ssh:status' && /ProxyJump/.test(event.message ?? ''))).toBe(
      true
    )
    expect(final.connections.size).toBe(0)
  }, 30_000)
})
