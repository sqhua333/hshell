import { SerialPort } from 'serialport'
import type {
  AppEvent,
  ConnectRequest,
  SerialOptions,
  SerialPortInfo,
  Session
} from '@shared/types'
import { resolveLogDirectory, SessionLogger } from '../storage/session-log'
import { ZmodemController, type ZmodemHost } from '../ssh/zmodem'

interface Runtime {
  runtimeId: string
  session: Session
  options: SerialOptions
  port: SerialPort | null
  manualClose: boolean
  failed: boolean
  unacked: number
  paused: boolean
  buffer: Buffer[]
  bufferBytes: number
  flushTimer: NodeJS.Timeout | null
  zmodem: ZmodemController | null
  log: SessionLogger | null
}

const noopZmodemHost: ZmodemHost = {
  pickDownloadDirectory: async () => null,
  pickUploadFiles: async () => null
}

const HIGH_WATER = 2 * 1024 * 1024
const LOW_WATER = 512 * 1024
const FLUSH_MS = 8
const PASTE_CHUNK = 32 * 1024

/** Reject device paths that could confuse the serial backend. */
export function normalizeSerialOptions(input: SerialOptions | undefined): SerialOptions {
  if (!input) throw new Error('串口会话缺少设备配置')
  const path = input.path.trim()
  if (!path) throw new Error('请输入串口设备路径')
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error('串口设备路径包含非法字符')
  const baudRate = Number(input.baudRate)
  if (!Number.isInteger(baudRate) || baudRate < 50 || baudRate > 4_000_000) {
    throw new Error('波特率必须是 50 到 4000000 之间的整数')
  }
  const dataBits = Number(input.dataBits)
  if (![5, 6, 7, 8].includes(dataBits)) throw new Error('数据位必须是 5、6、7 或 8')
  const stopBits = Number(input.stopBits)
  if (![1, 1.5, 2].includes(stopBits)) throw new Error('停止位必须是 1、1.5 或 2')
  if (!['none', 'even', 'odd', 'mark', 'space'].includes(input.parity)) {
    throw new Error('不支持的校验方式')
  }
  if (!['none', 'rtscts', 'xonxoff'].includes(input.flowControl)) {
    throw new Error('不支持的流控方式')
  }
  return {
    path,
    baudRate,
    dataBits: dataBits as SerialOptions['dataBits'],
    stopBits: stopBits as SerialOptions['stopBits'],
    parity: input.parity,
    flowControl: input.flowControl,
    dtr: typeof input.dtr === 'boolean' ? input.dtr : undefined,
    rts: typeof input.rts === 'boolean' ? input.rts : undefined
  }
}

function friendlyError(error: Error, path: string): string {
  const message = error.message || String(error)
  if (/ENOENT|No such file|cannot open|File not found/i.test(message)) {
    return `找不到串口设备：${path}`
  }
  if (/EACCES|Permission denied|Access denied/i.test(message)) {
    return process.platform === 'linux'
      ? `没有访问 ${path} 的权限；请将当前用户加入 dialout 组（sudo usermod -aG dialout $USER）后重新登录`
      : `没有访问 ${path} 的权限`
  }
  if (/EBUSY|Resource busy|already open|being used/i.test(message)) {
    return `串口设备 ${path} 已被其他程序占用`
  }
  return message
}

/** List serial ports without opening them. */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const ports = await SerialPort.list()
  return ports.map((port) => ({
    path: port.path,
    manufacturer: port.manufacturer,
    serialNumber: port.serialNumber,
    pnpId: port.pnpId,
    locationId: port.locationId,
    vendorId: port.vendorId,
    productId: port.productId
  }))
}

/**
 * Serial-port backend with the same runtime/event contract as `SshManager`.
 * The renderer talks to it through the `ssh:*` IPC channels.
 */
export class SerialManager {
  private runtimes = new Map<string, Runtime>()

  constructor(
    private readonly emit: (event: AppEvent) => void,
    private readonly zmodemHost: ZmodemHost = noopZmodemHost,
    private readonly logsDir?: string
  ) {}

  has(runtimeId: string): boolean {
    return this.runtimes.has(runtimeId)
  }

  async connect(req: ConnectRequest): Promise<void> {
    this.disconnect(req.runtimeId)
    this.emit({ type: 'ssh:status', runtimeId: req.runtimeId, status: 'connecting' })

    let options: SerialOptions
    try {
      options = normalizeSerialOptions(req.session.serial)
    } catch (error) {
      this.emit({
        type: 'ssh:status',
        runtimeId: req.runtimeId,
        status: 'failed',
        message: (error as Error).message
      })
      return
    }

    const rt: Runtime = {
      runtimeId: req.runtimeId,
      session: req.session,
      options,
      port: null,
      manualClose: false,
      failed: false,
      unacked: 0,
      paused: false,
      buffer: [],
      bufferBytes: 0,
      flushTimer: null,
      zmodem: null,
      log: null
    }
    this.runtimes.set(rt.runtimeId, rt)

    const flow =
      options.flowControl === 'rtscts'
        ? { rtscts: true }
        : options.flowControl === 'xonxoff'
          ? { xon: true, xoff: true, xany: false }
          : {}

    let port: SerialPort
    try {
      port = new SerialPort({
        path: options.path,
        baudRate: options.baudRate,
        dataBits: options.dataBits,
        stopBits: options.stopBits,
        parity: options.parity,
        autoOpen: false,
        lock: true,
        ...flow
      })
    } catch (error) {
      this.fail(rt, friendlyError(error as Error, options.path))
      return
    }
    rt.port = port

    port.on('data', (chunk: Buffer) => {
      if (rt.port !== port) return
      if (rt.zmodem) rt.zmodem.feed(chunk)
      else {
        rt.log?.write(chunk)
        this.pushData(rt, chunk)
      }
    })
    port.on('error', (error: Error) => {
      if (rt.port !== port || rt.manualClose) return
      this.fail(rt, friendlyError(error, options.path))
    })
    port.on('close', () => {
      if (rt.port !== port) return
      rt.port = null
      this.releaseStreams(rt)
      if (rt.manualClose || rt.failed) return
      this.emit({
        type: 'ssh:status',
        runtimeId: rt.runtimeId,
        status: 'closed',
        message: '串口连接已断开'
      })
      this.runtimes.delete(rt.runtimeId)
    })

    port.open((error) => {
      if (rt.manualClose || this.runtimes.get(rt.runtimeId) !== rt) {
        if (port.isOpen) port.close(() => undefined)
        return
      }
      if (error) {
        this.fail(rt, friendlyError(error, options.path))
        return
      }

      // Modem control lines are not supported by every adapter (and not by
      // PTYs), so a failure here must not abort the connection.
      if (options.dtr !== undefined || options.rts !== undefined) {
        port.set(
          {
            ...(options.dtr !== undefined ? { dtr: options.dtr } : {}),
            ...(options.rts !== undefined ? { rts: options.rts } : {})
          },
          () => undefined
        )
      }

      this.startLog(rt)
      rt.zmodem = new ZmodemController({
        writeRemote: (data) => {
          try {
            port.write(Buffer.from(data))
          } catch {
            /* port may be closing */
          }
        },
        writeTerminal: (data) => {
          const output = Buffer.from(data)
          rt.log?.write(output)
          this.pushData(rt, output)
        },
        status: (update) => {
          this.emit({ type: 'zmodem:status', runtimeId: rt.runtimeId, ...update })
        },
        remoteWritableLength: () => port.writableLength,
        host: this.zmodemHost
      })
      this.emit({ type: 'ssh:status', runtimeId: rt.runtimeId, status: 'connected' })
    })
  }

  write(runtimeId: string, data: string): void {
    const rt = this.runtimes.get(runtimeId)
    const port = rt?.port
    if (!rt || !port?.isOpen) return
    const buffer = Buffer.from(data, 'utf8')
    for (let offset = 0; offset < buffer.length; offset += PASTE_CHUNK) {
      port.write(buffer.subarray(offset, offset + PASTE_CHUNK), (error) => {
        if (!error) return
        this.emit({
          type: 'ssh:notice',
          runtimeId,
          level: 'warn',
          message: `串口写入失败：${error.message}`
        })
      })
    }
  }

  /** Serial links have no window size; the call keeps the API uniform. */
  resize(_runtimeId: string, _cols: number, _rows: number): void {
    /* no-op */
  }

  ack(runtimeId: string, bytes: number): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt) return
    rt.unacked = Math.max(0, rt.unacked - Math.max(0, bytes))
    if (rt.paused && rt.unacked < LOW_WATER) {
      rt.paused = false
      try {
        rt.port?.resume()
      } catch {
        /* ignore */
      }
    }
  }

  disconnect(runtimeId: string): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt) return
    rt.manualClose = true
    this.releaseStreams(rt)
    const port = rt.port
    rt.port = null
    if (port) {
      try {
        if (port.isOpen) port.close(() => undefined)
      } catch {
        /* ignore */
      }
    }
    this.runtimes.delete(runtimeId)
    this.emit({ type: 'ssh:status', runtimeId, status: 'closed' })
  }

  private fail(rt: Runtime, message: string): void {
    if (rt.failed) return
    rt.failed = true
    this.releaseStreams(rt)
    const port = rt.port
    rt.port = null
    if (port) {
      try {
        if (port.isOpen) port.close(() => undefined)
      } catch {
        /* ignore */
      }
    }
    this.runtimes.delete(rt.runtimeId)
    this.emit({ type: 'ssh:status', runtimeId: rt.runtimeId, status: 'failed', message })
  }

  /** Flush buffered output and shut down ZMODEM/logging for a runtime. */
  private releaseStreams(rt: Runtime): void {
    this.flushData(rt)
    rt.zmodem?.dispose()
    rt.zmodem = null
    this.closeLog(rt)
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
        rt.port?.pause()
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
