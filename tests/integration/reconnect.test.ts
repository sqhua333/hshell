import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils, type Connection } from 'ssh2'
import { describe, expect, it } from 'vitest'
import type { AppEvent, Session } from '@shared/types'
import { KnownHosts } from '../../src/main/ssh/known-hosts'
import { SshManager, type ReconnectPolicy } from '../../src/main/ssh/manager'

const SESSION: Session = {
  id: 's-reconnect',
  name: 'reconnect-test',
  folderId: null,
  host: '127.0.0.1',
  port: 22,
  username: 'tester',
  auth: { method: 'password', password: 'anything' },
  terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
  createdAt: 0,
  updatedAt: 0
}

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function startServer(acceptAuth: boolean): Promise<{
  port: number
  /** Graceful end: sends SSH_MSG_DISCONNECT (BY_APPLICATION). */
  dropConnections: () => void
  /** Abrupt transport failure: resets the TCP connection (ECONNRESET). */
  resetConnections: () => void
  /** Stop accepting new connections but leave existing sockets alone. */
  stopAccepting: () => void
  close: () => Promise<void>
}> {
  const { private: hostKey } = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const connections = new Set<Connection>()
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', (ctx) => {
      if (acceptAuth) ctx.accept()
      else ctx.reject(['password'])
    })
    // Register the session handler immediately: a fast client may open its
    // session channel in the same packet as authentication success, before a
    // deferred `ready` handler could attach this listener.
    connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        stream?.write('hello\r\n')
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const port = (server.address() as AddressInfo).port
  return {
    port,
    dropConnections: () => {
      for (const connection of connections) connection.end()
    },
    resetConnections: () => {
      for (const connection of connections) {
        const socket = (
          connection as unknown as {
            _sock?: { resetAndDestroy?: () => void; destroy: () => void }
          }
        )._sock
        if (!socket) continue
        if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy()
        else socket.destroy()
      }
    },
    stopAccepting: () => {
      try {
        server.close()
      } catch {
        /* already closed */
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections) connection.end()
        server.close(() => resolve())
      })
  }
}

function setup(
  port: number,
  reconnect?: ReconnectPolicy
): {
  manager: SshManager
  events: AppEvent[]
  statuses: string[]
  connect: () => Promise<void>
} {
  const events: AppEvent[] = []
  const statuses: string[] = []
  const manager = new SshManager(
    new KnownHosts(mkdtempSync(join(tmpdir(), 'hshell-reconnect-'))),
    (event) => {
      events.push(event)
      if (event.type === 'ssh:status') statuses.push(event.status)
      if (event.type === 'ssh:hostkey') manager.hostKeyDecision(event.prompt.requestId, true)
    },
    undefined,
    undefined,
    undefined,
    reconnect
  )

  return {
    manager,
    events,
    statuses,
    connect: () =>
      manager.connect({
        runtimeId: 'rt-reconnect',
        session: { ...SESSION, port },
        cols: 80,
        rows: 24
      })
  }
}

describe('SshManager reconnect', () => {
  it('reconnects after the transport drops', async () => {
    const server = await startServer(true)
    const { manager, events, statuses, connect } = setup(server.port)
    try {
      await connect()
      await waitFor(() => statuses.filter((status) => status === 'connected').length === 1)

      server.resetConnections()
      await waitFor(() => statuses.includes('reconnecting'))
      await waitFor(() => statuses.filter((status) => status === 'connected').length === 2)

      expect(
        events.some((event) => event.type === 'ssh:notice' && event.message === '已重新连接到主机')
      ).toBe(true)
    } finally {
      manager.disconnect('rt-reconnect')
      await server.close()
    }
  }, 20_000)

  it('disconnects immediately when the host closes the connection explicitly', async () => {
    const server = await startServer(true)
    const { manager, statuses, connect } = setup(server.port)
    try {
      await connect()
      await waitFor(() => statuses.includes('connected'))
      // An explicit SSH disconnect is a final answer: no backoff, no retry.
      server.dropConnections()
      await waitFor(() => statuses.includes('closed'), 5_000)
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(statuses).not.toContain('reconnecting')
      expect(statuses.at(-1)).toBe('closed')
    } finally {
      manager.disconnect('rt-reconnect')
      await server.close()
    }
  }, 20_000)

  it('stops retrying and reports closed after the reconnect budget', async () => {
    const server = await startServer(true)
    const { manager, statuses, connect } = setup(server.port, {
      maxAttempts: 2,
      baseDelayMs: 20,
      maxDelayMs: 40
    })
    try {
      await connect()
      await waitFor(() => statuses.includes('connected'))
      // The device vanishes: the open connection resets and the port stops
      // accepting, so every retry fails at the transport level.
      server.resetConnections()
      server.stopAccepting()
      await waitFor(() => statuses.includes('closed'), 10_000)
      expect(statuses.filter((status) => status === 'reconnecting').length).toBe(2)
      const settled = [...statuses]
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(statuses).toEqual(settled)
    } finally {
      manager.disconnect('rt-reconnect')
      await server.close()
    }
  }, 20_000)

  it('does not retry when authentication fails', async () => {
    const server = await startServer(false)
    const { manager, statuses, connect } = setup(server.port)
    try {
      await connect()
      await waitFor(() => statuses.includes('failed'))
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(statuses).not.toContain('reconnecting')
    } finally {
      manager.disconnect('rt-reconnect')
      await server.close()
    }
  }, 20_000)
})
