import net from 'node:net'
import type { AppEvent, ConnectRequest, Session } from '@shared/types'
import { resolveLogDirectory, SessionLogger } from '../storage/session-log'
import { encodeTelnetInput, TelnetProtocol } from './protocol'

interface Runtime {
  runtimeId: string
  session: Session
  socket: net.Socket | null
  protocol: TelnetProtocol
  manualClose: boolean
  failed: boolean
  unacked: number
  paused: boolean
  buffer: Buffer[]
  bufferBytes: number
  flushTimer: NodeJS.Timeout | null
  log: SessionLogger | null
  sentUser: boolean
  sentPassword: boolean
  probe: string
}

const HIGH_WATER = 2 * 1024 * 1024
const LOW_WATER = 512 * 1024
const FLUSH_MS = 8
const CONNECT_TIMEOUT_MS = 15_000

function friendlyError(error: Error, host: string, port: number): string {
  const message = error.message || String(error)
  if (/ECONNREFUSED/i.test(message)) return `无法连接到 ${host}:${port}：连接被拒绝`
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return `找不到主机：${host}`
  if (/ETIMEDOUT|timeout/i.test(message)) return `连接 ${host}:${port} 超时`
  if (/EHOSTUNREACH|ENETUNREACH/i.test(message)) return `无法访问 ${host}:${port}`
  if (/ECONNRESET|EPIPE/i.test(message)) return 'Telnet 连接已被对端重置'
  return message
}

/**
 * Telnet backend with the same runtime/event contract as the SSH, serial and
 * local backends. Input is passed through the telnet codec so option
 * negotiation never reaches the terminal.
 */
export class TelnetManager {
  private runtimes = new Map<string, Runtime>()

  constructor(
    private readonly emit: (event: AppEvent) => void,
    private readonly logsDir?: string
  ) {}

  has(runtimeId: string): boolean {
    return this.runtimes.has(runtimeId)
  }

  async connect(req: ConnectRequest): Promise<void> {
    this.disconnect(req.runtimeId)
    const runtimeId = req.runtimeId
    const session = req.session
    const host = session.host.trim()
    const port = Number(session.port)
    this.emit({ type: 'ssh:status', runtimeId, status: 'connecting' })

    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      this.emit({
        type: 'ssh:status',
        runtimeId,
        status: 'failed',
        message: 'Telnet 主机或端口无效'
      })
      return
    }

    let sendToSocket: (data: Buffer) => void = () => undefined
    const protocol = new TelnetProtocol({
      send: (data) => sendToSocket(data),
      terminalType: session.telnet?.terminalType || session.terminal.term
    })
    const rt: Runtime = {
      runtimeId,
      session,
      socket: null,
      protocol,
      manualClose: false,
      failed: false,
      unacked: 0,
      paused: false,
      buffer: [],
      bufferBytes: 0,
      flushTimer: null,
      log: null,
      sentUser: false,
      sentPassword: false,
      probe: ''
    }
    this.runtimes.set(runtimeId, rt)

    const socket = net.createConnection({ host, port })
    rt.socket = socket
    sendToSocket = (data) => {
      if (rt.socket !== socket) return
      try {
        socket.write(data)
      } catch {
        /* the socket may be closing */
      }
    }
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 30_000)
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (rt.socket !== socket) return
      socket.destroy(new Error('Telnet 连接超时'))
    })

    socket.on('connect', () => {
      if (rt.socket !== socket) return
      socket.setTimeout(0)
      protocol.start()
      protocol.setWindowSize(req.cols, req.rows)
      this.startLog(rt)
      this.emit({ type: 'ssh:status', runtimeId, status: 'connected' })
    })

    socket.on('data', (chunk: Buffer) => {
      if (rt.socket !== socket) return
      const data = protocol.feed(chunk)
      if (!data.length) return
      rt.log?.write(data)
      this.maybeAutoLogin(rt, data)
      this.pushData(rt, data)
    })

    socket.on('error', (error: Error) => {
      if (rt.socket !== socket || rt.manualClose) return
      this.fail(rt, friendlyError(error, host, port))
    })

    socket.on('close', () => {
      if (rt.socket !== socket) return
      rt.socket = null
      this.flushData(rt)
      this.closeLog(rt)
      if (rt.manualClose || rt.failed) return
      this.runtimes.delete(runtimeId)
      this.emit({
        type: 'ssh:status',
        runtimeId,
        status: 'closed',
        message: 'Telnet 连接已断开'
      })
    })
  }

  write(runtimeId: string, data: string): void {
    const rt = this.runtimes.get(runtimeId)
    const socket = rt?.socket
    if (!rt || !socket || !data) return
    const buffer = encodeTelnetInput(data)
    for (let offset = 0; offset < buffer.length; offset += 32 * 1024) {
      socket.write(buffer.subarray(offset, offset + 32 * 1024), (error) => {
        if (!error) return
        this.emit({
          type: 'ssh:notice',
          runtimeId,
          level: 'warn',
          message: `Telnet 写入失败：${error.message}`
        })
      })
    }
  }

  resize(runtimeId: string, cols: number, rows: number): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt?.socket) return
    rt.protocol.setWindowSize(cols, rows)
  }

  ack(runtimeId: string, bytes: number): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt) return
    rt.unacked = Math.max(0, rt.unacked - Math.max(0, bytes))
    if (rt.paused && rt.unacked < LOW_WATER) {
      rt.paused = false
      try {
        rt.socket?.resume()
      } catch {
        /* ignore */
      }
    }
  }

  disconnect(runtimeId: string): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt) return
    rt.manualClose = true
    this.flushData(rt)
    this.closeLog(rt)
    const socket = rt.socket
    rt.socket = null
    this.runtimes.delete(runtimeId)
    try {
      socket?.destroy()
    } catch {
      /* ignore */
    }
    this.emit({ type: 'ssh:status', runtimeId, status: 'closed' })
  }

  private fail(rt: Runtime, message: string): void {
    if (rt.failed) return
    rt.failed = true
    this.flushData(rt)
    this.closeLog(rt)
    const socket = rt.socket
    rt.socket = null
    this.runtimes.delete(rt.runtimeId)
    try {
      socket?.destroy()
    } catch {
      /* ignore */
    }
    this.emit({ type: 'ssh:status', runtimeId: rt.runtimeId, status: 'failed', message })
  }

  /** Send the configured credentials once each, when the host prompts. */
  private maybeAutoLogin(rt: Runtime, data: Buffer): void {
    if (!rt.session.telnet?.autoLogin) return
    rt.probe = `${rt.probe}${data.toString('utf8')}`.slice(-4096)
    const username = rt.session.username
    const password = rt.session.auth.password ?? ''
    if (!rt.sentUser && username && /(?:login|username)\s*[:：]\s*$/i.test(rt.probe)) {
      rt.sentUser = true
      rt.probe = ''
      this.write(rt.runtimeId, `${username}\r`)
      return
    }
    if (!rt.sentPassword && password && /password\s*[:：]\s*$/i.test(rt.probe)) {
      rt.sentPassword = true
      rt.probe = ''
      this.write(rt.runtimeId, `${password}\r`)
    }
  }

  private pushData(rt: Runtime, chunk: Buffer): void {
    rt.buffer.push(chunk)
    rt.bufferBytes += chunk.length
    rt.unacked += chunk.length
    if (!rt.flushTimer) {
      rt.flushTimer = setTimeout(() => this.flushData(rt), FLUSH_MS)
    }
    if (rt.unacked > HIGH_WATER && !rt.paused) {
      rt.paused = true
      try {
        rt.socket?.pause()
      } catch {
        /* ignore */
      }
    }
  }

  private flushData(rt: Runtime): void {
    if (rt.flushTimer) {
      clearTimeout(rt.flushTimer)
      rt.flushTimer = null
    }
    if (!rt.bufferBytes) return
    const merged = Buffer.concat(rt.buffer, rt.bufferBytes)
    rt.buffer = []
    rt.bufferBytes = 0
    this.emit({ type: 'ssh:data', runtimeId: rt.runtimeId, data: new Uint8Array(merged) })
  }

  private startLog(rt: Runtime): void {
    const config = rt.session.logging
    if (!config?.enabled || !this.logsDir || rt.log) return
    try {
      const directory = resolveLogDirectory(config.directory, this.logsDir)
      rt.log = new SessionLogger(directory, `${rt.session.name}-${rt.runtimeId}`, {
        format: config.format,
        timestamps: config.timestamps,
        cols: 80,
        rows: 24,
        term: rt.session.terminal.term
      })
    } catch (error) {
      this.emit({
        type: 'ssh:notice',
        runtimeId: rt.runtimeId,
        level: 'error',
        message: `无法创建会话日志：${(error as Error).message}`
      })
    }
  }

  private closeLog(rt: Runtime): void {
    const log = rt.log
    rt.log = null
    if (!log) return
    try {
      log.close()
    } catch {
      /* ignore */
    }
  }
}
