import net from 'node:net'
import type { Client, ClientChannel } from 'ssh2'
import type { AppEvent, TunnelConfig, TunnelInfo, TunnelPhase } from '@shared/types'

interface TunnelEntry {
  config: TunnelConfig
  phase: TunnelPhase
  client: Client
  server: net.Server | null
  sockets: Set<net.Socket>
  channels: Set<ClientChannel>
  /** Listener registered on the SSH client for remote (-R) connections. */
  remoteHandler: ((info: { destPort: number }, accept: () => ClientChannel) => void) | null
  remoteForwarded: boolean
  stopped: boolean
}

/** SOCKS5 reply codes used by the dynamic forwarder. */
const SOCKS_SUCCEEDED = 0x00
const SOCKS_GENERAL_FAILURE = 0x01
const SOCKS_NETWORK_UNREACHABLE = 0x03
const SOCKS_HOST_UNREACHABLE = 0x04
const SOCKS_CONNECTION_REFUSED = 0x05
const SOCKS_TTL_EXPIRED = 0x06
const SOCKS_COMMAND_UNSUPPORTED = 0x07
const SOCKS_ADDRESS_UNSUPPORTED = 0x08

function tunnelError(message: string, code?: string): string {
  if (code === 'EADDRINUSE') return `${message}：端口已被占用`
  if (code === 'EACCES') return `${message}：没有权限绑定该端口`
  if (code === 'EADDRNOTAVAIL') return `${message}：绑定地址不可用`
  return message
}

function socksReplyCode(error: NodeJS.ErrnoException): number {
  switch (error.code) {
    case 'ECONNREFUSED':
      return SOCKS_CONNECTION_REFUSED
    case 'EHOSTUNREACH':
      return SOCKS_HOST_UNREACHABLE
    case 'ENETUNREACH':
      return SOCKS_NETWORK_UNREACHABLE
    case 'ETIMEDOUT':
      return SOCKS_TTL_EXPIRED
    default:
      return SOCKS_GENERAL_FAILURE
  }
}

function formatIpv6(bytes: Buffer): string {
  const groups: string[] = []
  for (let offset = 0; offset < 16; offset += 2) {
    groups.push(bytes.readUInt16BE(offset).toString(16))
  }
  return groups.join(':')
}

/**
 * Owns the listeners/channels of every port-forwarding rule for one process.
 * It never touches Electron APIs so it can be exercised in headless tests.
 */
export class ForwardService {
  private entries = new Map<string, TunnelEntry>()

  constructor(
    private readonly resolveClient: (runtimeId: string) => Client | null,
    private readonly emit: (event: AppEvent) => void
  ) {}

  list(runtimeId: string): TunnelInfo[] {
    return [...this.entries.values()]
      .filter((entry) => entry.config.runtimeId === runtimeId)
      .map((entry) => this.info(entry))
  }

  async start(config: TunnelConfig): Promise<TunnelInfo> {
    if (this.entries.has(config.id)) throw new Error('转发规则已存在')
    if (config.tunnelType === 'remote') {
      const duplicate = [...this.entries.values()].some(
        (entry) =>
          entry.config.runtimeId === config.runtimeId &&
          entry.config.tunnelType === 'remote' &&
          entry.config.bindHost === config.bindHost &&
          entry.config.bindPort === config.bindPort
      )
      if (duplicate) throw new Error('该远端地址已有转发规则')
    }
    const client = this.resolveClient(config.runtimeId)
    if (!client) throw new Error('SSH 会话未连接，无法启动端口转发')

    const entry: TunnelEntry = {
      config: { ...config },
      phase: 'starting',
      client,
      server: null,
      sockets: new Set(),
      channels: new Set(),
      remoteHandler: null,
      remoteForwarded: false,
      stopped: false
    }
    this.entries.set(config.id, entry)
    this.setPhase(entry, 'starting')

    try {
      if (config.tunnelType === 'remote') {
        await this.startRemote(entry)
      } else if (config.tunnelType === 'dynamic') {
        await this.startServer(entry, (socket) => this.handleSocks(entry, socket))
      } else {
        await this.startServer(entry, (socket) => this.handleLocal(entry, socket))
      }
    } catch (error) {
      this.entries.delete(config.id)
      const message = tunnelError(
        (error as Error).message || '端口转发启动失败',
        (error as NodeJS.ErrnoException).code
      )
      this.emit({ type: 'tunnel:status', ...this.info(entry), phase: 'error', message })
      throw new Error(message)
    }
    return this.info(entry)
  }

  stop(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.teardown(entry)
    this.emit({ type: 'tunnel:status', ...this.info(entry), phase: 'stopped', message: '已停止' })
  }

  stopRuntime(runtimeId: string): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.config.runtimeId !== runtimeId) continue
      this.entries.delete(id)
      this.teardown(entry)
      this.emit({
        type: 'tunnel:status',
        ...this.info(entry),
        phase: 'stopped',
        message: '会话已断开'
      })
    }
  }

  dispose(): void {
    for (const [id, entry] of [...this.entries]) {
      this.entries.delete(id)
      this.teardown(entry)
    }
  }

  private info(entry: TunnelEntry): TunnelInfo {
    return { ...entry.config, phase: entry.phase }
  }

  private setPhase(entry: TunnelEntry, phase: TunnelPhase, message?: string): void {
    entry.phase = phase
    this.emit({ type: 'tunnel:status', ...this.info(entry), phase, message })
  }

  private startServer(entry: TunnelEntry, onSocket: (socket: net.Socket) => void): Promise<void> {
    const { bindHost, bindPort } = entry.config
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        if (entry.stopped) {
          socket.destroy()
          return
        }
        entry.sockets.add(socket)
        socket.on('close', () => entry.sockets.delete(socket))
        socket.on('error', () => socket.destroy())
        onSocket(socket)
      })
      entry.server = server
      server.once('error', (error) => {
        entry.server = null
        reject(error)
      })
      server.listen(bindPort, bindHost, () => {
        entry.server = server
        this.setPhase(entry, 'active', `监听 ${bindHost}:${bindPort}`)
        resolve()
      })
      // Report later failures (for example the listener being closed externally).
      server.on('error', (error) => {
        if (entry.stopped || entry.phase !== 'active') return
        this.setPhase(entry, 'error', tunnelError(error.message, (error as NodeJS.ErrnoException).code))
      })
    })
  }

  private startRemote(entry: TunnelEntry): Promise<void> {
    const { client, config } = entry
    return new Promise((resolve, reject) => {
      client.forwardIn(config.bindHost, config.bindPort, (error) => {
        if (entry.stopped) return
        if (error) {
          reject(error)
          return
        }
        entry.remoteForwarded = true

        const handler = (
          info: { destPort: number },
          accept: () => ClientChannel
        ): void => {
          if (entry.stopped || info.destPort !== config.bindPort) return
          if (!config.targetHost || !config.targetPort) return
          let channel: ClientChannel
          try {
            channel = accept()
          } catch {
            return
          }
          entry.channels.add(channel)
          channel.on('close', () => entry.channels.delete(channel))
          channel.on('error', () => channel.close())

          const upstream = net.connect(
            { host: config.targetHost, port: config.targetPort },
            () => {
              channel.pipe(upstream)
              upstream.pipe(channel)
            }
          )
          entry.sockets.add(upstream)
          upstream.on('close', () => entry.sockets.delete(upstream))
          upstream.on('error', () => {
            channel.close()
          })
          channel.on('close', () => upstream.destroy())
        }

        entry.remoteHandler = handler as TunnelEntry['remoteHandler']
        client.on('tcp connection', handler)
        this.setPhase(entry, 'active', `远端监听 ${config.bindHost}:${config.bindPort}`)
        resolve()
      })
    })
  }

  private teardown(entry: TunnelEntry): void {
    entry.stopped = true
    entry.phase = 'stopped'
    if (entry.server) {
      entry.server.close()
      entry.server = null
    }
    for (const socket of entry.sockets) socket.destroy()
    entry.sockets.clear()
    for (const channel of entry.channels) {
      try {
        channel.close()
      } catch {
        /* channel may already be closed */
      }
    }
    entry.channels.clear()

    const { client, config } = entry
    if (entry.remoteHandler) {
      client.removeListener('tcp connection', entry.remoteHandler)
      entry.remoteHandler = null
    }
    if (entry.remoteForwarded) {
      entry.remoteForwarded = false
      try {
        client.unforwardIn(config.bindHost, config.bindPort, () => undefined)
      } catch {
        /* connection already gone */
      }
    }
  }

  private pipeChannel(socket: net.Socket, channel: ClientChannel): void {
    socket.pipe(channel)
    channel.pipe(socket)
    channel.on('close', () => socket.destroy())
    channel.on('error', () => socket.destroy())
    socket.on('close', () => {
      try {
        channel.close()
      } catch {
        /* ignore */
      }
    })
  }

  private handleLocal(entry: TunnelEntry, socket: net.Socket): void {
    const { client, config } = entry
    if (!config.targetHost || !config.targetPort) {
      socket.destroy()
      return
    }
    client.forwardOut(
      socket.remoteAddress ?? '127.0.0.1',
      socket.remotePort ?? 0,
      config.targetHost,
      config.targetPort,
      (error, channel) => {
        if (error) {
          this.emit({
            type: 'ssh:notice',
            runtimeId: config.runtimeId,
            level: 'warn',
            message: `转发到 ${config.targetHost}:${config.targetPort} 失败：${error.message}`
          })
          socket.destroy()
          return
        }
        if (entry.stopped) {
          channel.close()
          socket.destroy()
          return
        }
        entry.channels.add(channel)
        channel.on('close', () => entry.channels.delete(channel))
        this.pipeChannel(socket, channel)
      }
    )
  }

  /**
   * Minimal SOCKS5 server (RFC 1928) supporting only CONNECT with IPv4,
   * domain names and IPv6 destinations.
   */
  private handleSocks(entry: TunnelEntry, socket: net.Socket): void {
    const { client } = entry
    let buffer = Buffer.alloc(0)
    let stage: 'greeting' | 'request' | 'connecting' | 'connected' = 'greeting'

    const failWith = (code: number): void => {
      try {
        socket.end(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      } catch {
        socket.destroy()
      }
    }

    const onData = (chunk: Buffer): void => {
      if (stage === 'connected' || stage === 'connecting') return
      buffer = Buffer.concat([buffer, chunk])
      // A SOCKS5 handshake is tiny; anything bigger is not a valid client.
      if (buffer.length > 8192) {
        socket.destroy()
        return
      }

      if (stage === 'greeting') {
        if (buffer.length < 2) return
        if (buffer[0] !== 0x05) {
          socket.destroy()
          return
        }
        const count = buffer[1]
        if (buffer.length < 2 + count) return
        const methods = buffer.subarray(2, 2 + count)
        buffer = buffer.subarray(2 + count)
        if (!methods.includes(0x00)) {
          socket.end(Buffer.from([0x05, 0xff]))
          return
        }
        socket.write(Buffer.from([0x05, 0x00]))
        stage = 'request'
      }

      if (stage === 'request') {
        if (buffer.length < 4) return
        if (buffer[0] !== 0x05) {
          socket.destroy()
          return
        }
        const command = buffer[1]
        const addressType = buffer[3]
        let headerLength: number
        let host: string
        if (addressType === 0x01) {
          headerLength = 4 + 4 + 2
          if (buffer.length < headerLength) return
          host = Array.from(buffer.subarray(4, 8)).join('.')
        } else if (addressType === 0x03) {
          if (buffer.length < 5) return
          const length = buffer[4]
          headerLength = 5 + length + 2
          if (buffer.length < headerLength) return
          host = buffer.toString('utf8', 5, 5 + length)
        } else if (addressType === 0x04) {
          headerLength = 4 + 16 + 2
          if (buffer.length < headerLength) return
          host = formatIpv6(buffer.subarray(4, 20))
        } else {
          failWith(SOCKS_ADDRESS_UNSUPPORTED)
          return
        }

        const port = buffer.readUInt16BE(headerLength - 2)
        const leftover = buffer.subarray(headerLength)
        buffer = Buffer.alloc(0)

        if (command !== 0x01) {
          failWith(SOCKS_COMMAND_UNSUPPORTED)
          return
        }
        if (!host) {
          failWith(SOCKS_HOST_UNREACHABLE)
          return
        }

        stage = 'connecting'
        socket.removeListener('data', onData)
        client.forwardOut(
          socket.remoteAddress ?? '127.0.0.1',
          socket.remotePort ?? 0,
          host,
          port,
          (error, channel) => {
            if (error) {
              failWith(socksReplyCode(error as NodeJS.ErrnoException))
              return
            }
            if (entry.stopped) {
              channel.close()
              socket.destroy()
              return
            }
            stage = 'connected'
            entry.channels.add(channel)
            channel.on('close', () => entry.channels.delete(channel))
            socket.write(Buffer.from([0x05, SOCKS_SUCCEEDED, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            if (leftover.length > 0) channel.write(leftover)
            this.pipeChannel(socket, channel)
          }
        )
      }
    }

    socket.on('data', onData)
    socket.on('error', () => socket.destroy())
  }
}
