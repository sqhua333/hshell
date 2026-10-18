import { mkdtempSync } from 'node:fs'
import {
  createServer as createHttpServer,
  get as httpGetRaw,
  type Server as HttpServer
} from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils, type Connection } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppEvent, Session, TunnelInfo } from '@shared/types'
import { KnownHosts } from '../../src/main/ssh/known-hosts'
import { SshManager } from '../../src/main/ssh/manager'

const SESSION: Session = {
  id: 's-tunnel',
  name: 'tunnel-test',
  folderId: null,
  host: '127.0.0.1',
  port: 22,
  username: 'tester',
  auth: { method: 'password', password: 'anything' },
  terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
  createdAt: 0,
  updatedAt: 0
}

const RUNTIME = 'rt-tunnel'

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

async function listen(server: net.Server | HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return (server.address() as AddressInfo).port
}

function closeServer(server: net.Server | HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

interface Readable {
  data: Buffer
  ended: boolean
  read(bytes: number): Promise<Buffer>
  untilEnd(): Promise<string>
}

/** Tiny buffered reader for the SOCKS handshake and HTTP response. */
function readerOf(socket: net.Socket): Readable {
  const state: Readable = {
    data: Buffer.alloc(0),
    ended: false,
    read: async (bytes: number) => {
      while (state.data.length < bytes && !state.ended) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const result = state.data.subarray(0, bytes)
      state.data = state.data.subarray(bytes)
      return Buffer.from(result)
    },
    untilEnd: async () => {
      while (!state.ended) await new Promise((resolve) => setTimeout(resolve, 10))
      return state.data.toString('utf8')
    }
  }
  socket.on('data', (chunk: Buffer) => {
    state.data = Buffer.concat([state.data, chunk])
  })
  socket.on('end', () => {
    state.ended = true
  })
  socket.on('close', () => {
    state.ended = true
  })
  socket.on('error', () => {
    state.ended = true
  })
  return state
}

interface FakeSshServer {
  port: number
  connections: Set<Connection>
  close(): Promise<void>
}

async function startSshServer(): Promise<FakeSshServer> {
  const { private: hostKey } = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const connections = new Set<Connection>()
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', (ctx) => ctx.accept())

    connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('shell', (acceptShell) => acceptShell()?.write('ready\r\n'))
    })

    // direct-tcpip: local (-L) and dynamic (-D) forwards reach this handler.
    connection.on('tcpip', (accept, _reject, info) => {
      const stream = accept()
      const upstream = net.connect(
        { host: info.destIP, port: info.destPort },
        () => {
          stream.pipe(upstream)
          upstream.pipe(stream)
        }
      )
      upstream.on('error', () => stream.close())
      stream.on('close', () => upstream.destroy())
      stream.on('error', () => upstream.destroy())
    })

    // Accept tcpip-forward / cancel-tcpip-forward global requests.
    connection.on('request', (accept, reject, name) => {
      if (name === 'tcpip-forward' || name === 'cancel-tcpip-forward') accept?.()
      else reject?.()
    })
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

function setup(port: number): {
  manager: SshManager
  events: AppEvent[]
  statuses: string[]
  tunnels: TunnelInfo[]
  connect: () => Promise<void>
} {
  const events: AppEvent[] = []
  const statuses: string[] = []
  const tunnels: TunnelInfo[] = []
  const manager = new SshManager(
    new KnownHosts(mkdtempSync(join(tmpdir(), 'hshell-tunnel-'))),
    (event) => {
      events.push(event)
      if (event.type === 'ssh:status') statuses.push(event.status)
      if (event.type === 'tunnel:status') tunnels.push(event)
      if (event.type === 'ssh:hostkey') manager.hostKeyDecision(event.prompt.requestId, true)
    }
  )
  return {
    manager,
    events,
    statuses,
    tunnels,
    connect: () =>
      manager.connect({
        runtimeId: RUNTIME,
        session: { ...SESSION, port },
        cols: 80,
        rows: 24
      })
  }
}

function httpGet(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpGetRaw({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => resolve(body))
    })
    request.on('error', reject)
  })
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function defer(cleanup: () => Promise<void> | void): void {
  cleanups.push(cleanup)
}

describe('port forwarding', () => {
  it('serves HTTP through a local forward and cleans up on stop', async () => {
    const http = createHttpServer((_req, res) => res.end('tunnel-ok'))
    const targetPort = await listen(http)
    defer(() => closeServer(http))
    const sshServer = await startSshServer()
    defer(() => sshServer.close())
    const { manager, statuses, connect } = setup(sshServer.port)
    defer(() => manager.disconnect(RUNTIME))

    await connect()
    await waitFor(() => statuses.includes('connected'))

    const bindPort = await freePort()
    const info = await manager.startTunnel({
      id: 't-local',
      runtimeId: RUNTIME,
      tunnelType: 'local',
      bindHost: '127.0.0.1',
      bindPort,
      targetHost: '127.0.0.1',
      targetPort
    })
    expect(info.phase).toBe('active')

    expect(await httpGet(bindPort)).toBe('tunnel-ok')
    expect(manager.listTunnels(RUNTIME)).toHaveLength(1)

    manager.stopTunnel('t-local')
    expect(manager.listTunnels(RUNTIME)).toHaveLength(0)
    await expect(
      new Promise((resolve, reject) => {
        const socket = net.connect(bindPort, '127.0.0.1')
        socket.once('connect', () => {
          socket.destroy()
          resolve('connected')
        })
        socket.once('error', reject)
      })
    ).rejects.toBeTruthy()
  }, 30_000)

  it('proxies CONNECT requests through the SOCKS5 dynamic forward', async () => {
    const http = createHttpServer((_req, res) => res.end('socks-ok'))
    const targetPort = await listen(http)
    defer(() => closeServer(http))
    const sshServer = await startSshServer()
    defer(() => sshServer.close())
    const { manager, statuses, connect } = setup(sshServer.port)
    defer(() => manager.disconnect(RUNTIME))

    await connect()
    await waitFor(() => statuses.includes('connected'))

    const bindPort = await freePort()
    await manager.startTunnel({
      id: 't-socks',
      runtimeId: RUNTIME,
      tunnelType: 'dynamic',
      bindHost: '127.0.0.1',
      bindPort
    })

    const socket = net.connect(bindPort, '127.0.0.1')
    defer(() => socket.destroy())
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    const reader = readerOf(socket)

    socket.write(Buffer.from([0x05, 0x01, 0x00]))
    expect([...(await reader.read(2))]).toEqual([0x05, 0x00])

    const host = Buffer.from('127.0.0.1')
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
        host,
        Buffer.from([targetPort >> 8, targetPort & 0xff])
      ])
    )
    const reply = await reader.read(10)
    expect(reply[0]).toBe(0x05)
    expect(reply[1]).toBe(0x00)

    socket.write('GET / HTTP/1.1\r\nHost: tunnel\r\nConnection: close\r\n\r\n')
    expect(await reader.untilEnd()).toContain('socks-ok')
  }, 30_000)

  it('forwards a remote connection back to a local service', async () => {
    const sshServer = await startSshServer()
    defer(() => sshServer.close())
    const { manager, statuses, connect } = setup(sshServer.port)
    defer(() => manager.disconnect(RUNTIME))

    let upstreamPayload = ''
    const target = net.createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        upstreamPayload += chunk.toString()
        socket.end('pong')
      })
    })
    const targetPort = await listen(target)
    defer(() => closeServer(target))

    await connect()
    await waitFor(() => statuses.includes('connected'))

    const bindPort = await freePort()
    await manager.startTunnel({
      id: 't-remote',
      runtimeId: RUNTIME,
      tunnelType: 'remote',
      bindHost: '127.0.0.1',
      bindPort,
      targetHost: '127.0.0.1',
      targetPort
    })

    await waitFor(() => sshServer.connections.size === 1)
    const connection = [...sshServer.connections][0]
    const response = await new Promise<string>((resolve, reject) => {
      // The SSH server simulates an inbound connection on the requested port.
      connection.forwardOut('127.0.0.1', bindPort, '127.0.0.1', 0, (error, stream) => {
        if (error) {
          reject(error)
          return
        }
        let body = ''
        stream.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        stream.on('end', () => resolve(body))
        stream.on('close', () => resolve(body))
        stream.write('ping')
      })
    })

    expect(upstreamPayload).toBe('ping')
    expect(response).toBe('pong')
  }, 30_000)

  it('reports a port conflict with a clear error', async () => {
    const sshServer = await startSshServer()
    defer(() => sshServer.close())
    const { manager, statuses, connect } = setup(sshServer.port)
    defer(() => manager.disconnect(RUNTIME))

    const blocker = net.createServer()
    const bindPort = await listen(blocker)
    defer(() => closeServer(blocker))

    await connect()
    await waitFor(() => statuses.includes('connected'))

    await expect(
      manager.startTunnel({
        id: 't-conflict',
        runtimeId: RUNTIME,
        tunnelType: 'local',
        bindHost: '127.0.0.1',
        bindPort,
        targetHost: '127.0.0.1',
        targetPort: 9
      })
    ).rejects.toThrow('端口已被占用')
    expect(manager.listTunnels(RUNTIME)).toHaveLength(0)
  }, 30_000)
})
