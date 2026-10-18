import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils, type Connection, type ServerChannel } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppEvent, Session } from '@shared/types'
import { KnownHosts } from '../../src/main/ssh/known-hosts'
import { SshManager } from '../../src/main/ssh/manager'

/**
 * Long-running hardening checks. Skipped by default because they intentionally
 * open many connections or move a lot of data:
 *
 *   HSHELL_SOAK=1 npx vitest run tests/integration/soak.test.ts
 *
 * The 100MB SFTP round-trip lives in sftp-transfer.test.ts and is gated by
 * HSHELL_SOAK_FULL=1.
 */
const SOAK = process.env.HSHELL_SOAK === '1'

const SESSION: Session = {
  id: 's-soak',
  name: 'soak-test',
  folderId: null,
  host: '127.0.0.1',
  port: 22,
  username: 'tester',
  auth: { method: 'password', password: 'anything' },
  terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
  createdAt: 0,
  updatedAt: 0
}

async function waitFor(check: () => boolean, timeout = 20_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

interface Harness {
  port: number
  activeConnections: () => number
  maxConnections: () => number
  close: () => Promise<void>
}

async function startServer(onShell?: (stream: ServerChannel) => void): Promise<Harness> {
  const { private: hostKey } = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const connections = new Set<Connection>()
  let peak = 0
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection)
    peak = Math.max(peak, connections.size)
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', (ctx) => ctx.accept())
    connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        if (onShell) onShell(stream)
        else stream?.write('ready\r\n')
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  return {
    port: (server.address() as AddressInfo).port,
    activeConnections: () => connections.size,
    maxConnections: () => peak,
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections) connection.end()
        server.close(() => resolve())
      })
  }
}

interface Setup {
  manager: SshManager
  statuses: Map<string, string>
}

interface SetupOptions {
  onData?: (runtimeId: string, bytes: number, manager: SshManager) => void
}

function setup(options: SetupOptions = {}): Setup {
  const statuses = new Map<string, string>()
  let manager!: SshManager
  manager = new SshManager(
    new KnownHosts(mkdtempSync(join(tmpdir(), 'hshell-soak-'))),
    (event: AppEvent) => {
      if (event.type === 'ssh:status') statuses.set(event.runtimeId, event.status)
      if (event.type === 'ssh:data') {
        options.onData?.(event.runtimeId, event.data.byteLength, manager)
      }
      if (event.type === 'ssh:hostkey') manager.hostKeyDecision(event.prompt.requestId, true)
    }
  )
  return { manager, statuses }
}

function connect(manager: SshManager, runtimeId: string, port: number): Promise<void> {
  return manager.connect({
    runtimeId,
    session: { ...SESSION, port },
    cols: 80,
    rows: 24
  })
}

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

describe.skipIf(!SOAK)('soak: 20 concurrent sessions', () => {
  it('opens and closes 20 sessions over three cycles without leaks', async () => {
    const server = await startServer()
    const { manager, statuses } = setup()
    cleanup.push(() => server.close())

    const runtimeIds = Array.from({ length: 20 }, (_, index) => `rt-soak-${index}`)
    const heapBefore = process.memoryUsage().heapUsed

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await Promise.all(runtimeIds.map((id) => connect(manager, id, server.port)))
      await waitFor(() => runtimeIds.every((id) => statuses.get(id) === 'connected'))
      expect(server.activeConnections()).toBe(20)

      await Promise.all(runtimeIds.map((id) => manager.disconnect(id)))
      await waitFor(() => server.activeConnections() === 0)
      await waitFor(() =>
        runtimeIds.every((id) => ['closed', 'failed'].includes(statuses.get(id) ?? ''))
      )
    }

    expect(server.maxConnections()).toBe(20)
    const internals = manager as unknown as { runtimes: Map<string, unknown> }
    expect(internals.runtimes.size).toBe(0)

    const gc = (globalThis as { gc?: () => void }).gc
    if (gc) {
      gc()
      const growth = process.memoryUsage().heapUsed - heapBefore
      // Generous bound: catches a per-cycle leak while tolerating allocator noise.
      expect(growth).toBeLessThan(64 * 1024 * 1024)
    }
  }, 180_000)
})

describe.skipIf(!SOAK)('soak: terminal backpressure', () => {
  it('bounds unacknowledged output and resumes after acks', async () => {
    const payloadSize = 16 * 1024 * 1024
    const payload = Buffer.alloc(payloadSize, 0x61)
    let started = false
    const server = await startServer((stream) => {
      if (started) return
      started = true
      void (async () => {
        const chunkSize = 64 * 1024
        for (let offset = 0; offset < payload.length; offset += chunkSize) {
          if (!stream.write(payload.subarray(offset, offset + chunkSize))) {
            await once(stream, 'drain')
          }
        }
      })()
    })

    const runtimeId = 'rt-bp'
    let received = 0
    let acked = 0
    let peak = 0
    let gated = true

    const { manager, statuses } = setup({
      onData: (id, bytes, mgr) => {
        if (id !== runtimeId) return
        received += bytes
        if (gated) {
          peak = Math.max(peak, received - acked)
          if (received >= 2 * 1024 * 1024) {
            // Release the gate: acknowledge everything outstanding. The manager
            // should resume the paused channel and finish the transfer.
            gated = false
            acked = received
            mgr.ack(id, received)
          }
        } else {
          acked += bytes
          mgr.ack(id, bytes)
        }
      }
    })
    cleanup.push(() => server.close())
    cleanup.push(() => manager.disconnect(runtimeId))

    await connect(manager, runtimeId, server.port)
    await waitFor(() => statuses.get(runtimeId) === 'connected')

    await waitFor(() => received >= payloadSize, 60_000)
    // The stream must have been paused around the 2MB high-water mark instead
    // of buffering the whole 16MB in memory.
    expect(peak).toBeGreaterThanOrEqual(2 * 1024 * 1024)
    expect(peak).toBeLessThan(8 * 1024 * 1024)
    expect(received).toBe(payloadSize)
    expect(acked).toBe(payloadSize)
  }, 120_000)
})

describe.skipIf(!SOAK)('soak: reconnect storm', () => {
  it('handles concurrent duplicate connects without leaking connections', async () => {
    const server = await startServer()
    const { manager, statuses } = setup()
    cleanup.push(() => server.close())
    cleanup.push(() => manager.disconnect('rt-storm'))

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => connect(manager, 'rt-storm', server.port))
    )
    void attempts
    await waitFor(() => statuses.get('rt-storm') === 'connected')
    // Epoch guards should collapse the duplicate attempts into one connection.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(server.activeConnections()).toBe(1)

    manager.disconnect('rt-storm')
    await waitFor(() => server.activeConnections() === 0)
  }, 60_000)

  it('survives 30 rapid manual connect/disconnect cycles', async () => {
    const server = await startServer()
    const { manager, statuses } = setup()
    cleanup.push(() => server.close())
    cleanup.push(() => manager.disconnect('rt-cycle'))

    for (let cycle = 0; cycle < 30; cycle += 1) {
      await connect(manager, 'rt-cycle', server.port)
      await waitFor(() => statuses.get('rt-cycle') === 'connected')
      manager.disconnect('rt-cycle')
      await waitFor(() => server.activeConnections() === 0)
      await waitFor(() => statuses.get('rt-cycle') === 'closed')
    }

    const internals = manager as unknown as { runtimes: Map<string, unknown> }
    expect(internals.runtimes.size).toBe(0)
    expect(server.maxConnections()).toBe(1)
  }, 120_000)
})
