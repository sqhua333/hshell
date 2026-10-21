import { existsSync } from 'node:fs'
import os from 'node:os'
import type { IPty } from 'node-pty'
import type { AppEvent, ConnectRequest } from '@shared/types'

const HIGH_WATER = 2 * 1024 * 1024
const LOW_WATER = 512 * 1024
const FLUSH_MS = 8

export interface ShellSpec {
  file: string
  args: string[]
}

type PtyModule = typeof import('node-pty')

let ptyModule: PtyModule | null = null
let ptyLoadError: Error | null = null

/**
 * Load the native PTY module lazily. A missing or incompatible prebuild must
 * only break the local-terminal feature, not the whole application at startup.
 */
function loadPty(): PtyModule {
  if (ptyModule) return ptyModule
  if (ptyLoadError) throw ptyLoadError
  try {
    // The main bundle keeps production dependencies external, so the packaged
    // prebuilds are resolved from node_modules (unpacked from the ASAR).
    ptyModule = require('node-pty') as PtyModule
    return ptyModule
  } catch (error) {
    ptyLoadError = new Error(
      `无法加载本地终端组件：${(error as Error).message}。请确认已安装 node-pty 且当前平台的预编译文件已随应用打包。`
    )
    throw ptyLoadError
  }
}

/**
 * The shell a new local terminal starts: the user's login shell on Unix and
 * the system command processor on Windows. The renderer cannot influence this
 * path, so an IPC request cannot turn into an arbitrary process spawn.
 */
export function resolveDefaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): ShellSpec {
  if (platform === 'win32') {
    return { file: env.COMSPEC?.trim() || 'cmd.exe', args: [] }
  }
  const preferred = env.SHELL?.trim() ?? ''
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const file =
    preferred.startsWith('/') && existsSync(preferred)
      ? preferred
      : existsSync(fallback)
        ? fallback
        : '/bin/sh'
  // Terminal applications start a login shell so the user's normal profile is
  // loaded even when HShell itself was launched by a desktop environment.
  return { file, args: ['-l'] }
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  // Do not leak Electron's own role switch into the child shell.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  env.TERM = 'xterm-256color'
  env.TERM_PROGRAM = 'HShell'
  if (!env.COLORTERM) env.COLORTERM = 'truecolor'
  return env
}

function clampDimension(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1000, Math.max(1, Math.floor(value))) : fallback
}

function friendlyError(error: Error): string {
  const message = error.message || String(error)
  if (/Failed to load native module|Cannot find module|not a valid Win32 application/i.test(message)) {
    return `无法加载本地终端组件：${message}`
  }
  if (/EACCES|Permission denied|Access denied/i.test(message)) {
    return `没有启动本地终端的权限：${message}`
  }
  return message
}

interface Runtime {
  runtimeId: string
  pty: IPty | null
  manualClose: boolean
  unacked: number
  paused: boolean
  buffer: Buffer[]
  bufferBytes: number
  flushTimer: NodeJS.Timeout | null
}

/**
 * Local-shell backend with the same runtime/event contract as `SshManager`
 * and `SerialManager`, so the renderer can use the existing `ssh:*` IPC
 * channels, backpressure and terminal handling unchanged.
 */
export class LocalShellManager {
  private runtimes = new Map<string, Runtime>()

  constructor(
    private readonly emit: (event: AppEvent) => void,
    private readonly shell: ShellSpec = resolveDefaultShell()
  ) {}

  has(runtimeId: string): boolean {
    return this.runtimes.has(runtimeId)
  }

  async connect(req: ConnectRequest): Promise<void> {
    this.disconnect(req.runtimeId)
    const runtimeId = req.runtimeId
    this.emit({ type: 'ssh:status', runtimeId, status: 'connecting' })

    let proc: IPty
    try {
      const pty = loadPty()
      proc = pty.spawn(this.shell.file, this.shell.args, {
        name: 'xterm-256color',
        cols: clampDimension(req.cols, 80),
        rows: clampDimension(req.rows, 24),
        cwd: os.homedir(),
        env: shellEnv()
      })
    } catch (error) {
      this.emit({
        type: 'ssh:status',
        runtimeId,
        status: 'failed',
        message: friendlyError(error as Error)
      })
      return
    }

    const rt: Runtime = {
      runtimeId,
      pty: proc,
      manualClose: false,
      unacked: 0,
      paused: false,
      buffer: [],
      bufferBytes: 0,
      flushTimer: null
    }
    this.runtimes.set(runtimeId, rt)

    proc.onData((data: string) => {
      if (rt.pty !== proc || !data) return
      this.pushData(rt, Buffer.from(data, 'utf8'))
    })

    proc.onExit(({ exitCode, signal }) => {
      // `disconnect` already detached the runtime; ignore the late exit event.
      if (rt.pty !== proc) return
      rt.pty = null
      this.flushData(rt)
      this.runtimes.delete(runtimeId)
      if (rt.manualClose) return
      this.emit({
        type: 'ssh:status',
        runtimeId,
        status: 'closed',
        message:
          signal && signal !== 0
            ? `本地终端已被信号 ${signal} 结束`
            : `本地终端已退出（退出码 ${exitCode}）`
      })
    })

    this.emit({ type: 'ssh:status', runtimeId, status: 'connected' })
  }

  write(runtimeId: string, data: string): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt?.pty || !data) return
    try {
      rt.pty.write(data)
    } catch (error) {
      this.emit({
        type: 'ssh:notice',
        runtimeId,
        level: 'warn',
        message: `本地终端写入失败：${(error as Error).message}`
      })
    }
  }

  resize(runtimeId: string, cols: number, rows: number): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt?.pty) return
    try {
      rt.pty.resize(clampDimension(cols, 80), clampDimension(rows, 24))
    } catch {
      /* the shell may have exited between the IPC call and this resize */
    }
  }

  ack(runtimeId: string, bytes: number): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt) return
    rt.unacked = Math.max(0, rt.unacked - Math.max(0, bytes))
    if (rt.paused && rt.unacked < LOW_WATER) {
      rt.paused = false
      try {
        rt.pty?.resume()
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
    const proc = rt.pty
    rt.pty = null
    this.runtimes.delete(runtimeId)
    try {
      proc?.kill()
    } catch {
      /* the process may already be gone */
    }
    this.emit({ type: 'ssh:status', runtimeId, status: 'closed' })
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
        rt.pty?.pause()
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
}
