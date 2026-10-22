import { randomUUID } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, posix, resolve } from 'node:path'
import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type SFTPWrapper,
  type FileEntryWithStats as SftpRawEntry
} from 'ssh2'
import type {
  AppEvent,
  AuthConfig,
  ConnectRequest,
  FileEntry,
  RemoteMonitorSample,
  Session,
  TunnelConfig,
  TunnelInfo
} from '@shared/types'
import { parseProxyJump } from '@shared/jump'
import {
  MONITOR_COMMAND,
  parseMonitorOutput,
  type MonitorBaseline
} from '../monitor/remote'
import { resolveLogDirectory, SessionLogger } from '../storage/session-log'
import { ForwardService } from './forward-service'
import { KnownHosts, fingerprintOf, parseKeyAlgorithm } from './known-hosts'
import { buildAuthorizedKeysCommand, type PrivateKeyRecord } from './key-service'
import {
  assertInside,
  isInside,
  joinRemotePath,
  localChildPath,
  normalizeRemotePath,
  sanitizeLocalName
} from './paths'
import { ZmodemController, type ZmodemHost } from './zmodem'

export type KeyResolver = (keyId: string) => PrivateKeyRecord | null

interface PendingHostKey {
  verify: (ok: boolean) => void
  timer: NodeJS.Timeout
  host: string
  port: number
  key: Buffer
  runtimeId: string
}

interface PendingKeyboard {
  requestId: string
  finish: (responses: string[]) => void
  timer: NodeJS.Timeout
  client: Client
}

interface ResolvedJump {
  host: string
  port: number
  username: string
  auth: AuthConfig
}

interface Runtime {
  runtimeId: string
  session: Session
  client: Client | null
  stream: ClientChannel | null
  sftp: SFTPWrapper | null
  cols: number
  rows: number
  manualClose: boolean
  failed: boolean
  authenticated: boolean
  /** Incremented whenever an attempt is abandoned, invalidating callbacks. */
  epoch: number
  /** Consecutive reconnect attempts; reset once a connection is ready. */
  attempt: number
  /** When the current reconnect streak began; null while connected. */
  reconnectStartedAt: number | null
  retryTimer: NodeJS.Timeout | null
  unacked: number
  paused: boolean
  buffer: Buffer[]
  bufferBytes: number
  flushTimer: NodeJS.Timeout | null
  pendingKeyboard: PendingKeyboard | null
  zmodem: ZmodemController | null
  /** Clients for ProxyJump hops, kept alive while the final connection runs. */
  jumpClients: Client[]
  /** forwardOut channels that carry the tunnel through each jump hop. */
  jumpStreams: ClientChannel[]
  /** Session recording, when enabled in the session settings. */
  log: SessionLogger | null
  /** Request id while the terminal is waiting for a password. */
  passwordRequest: string | null
  /** Password typed into the terminal; persisted once authentication succeeds. */
  retryPassword: string | null
  /** Inline prompts shown so far, used to tell the user the password was wrong. */
  passwordAttempts: number
}

interface TransferJob {
  runtimeId: string
  cancelled: boolean
  abort: () => void
}

interface DownloadCounter {
  files: number
}

/**
 * Auto-reconnect is bounded: after this many failed attempts the session is
 * marked as disconnected instead of retrying forever. With the exponential
 * backoff below the whole window is roughly two minutes.
 */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000
const RETRY_MAX_ATTEMPTS = 8
const RETRY_WINDOW_MS = 120_000

export interface ReconnectPolicy {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Give up once this much time has passed since the first drop. */
  windowMs?: number
}
/** Cap monitor exec output; /proc files are a few KiB at most. */
const MONITOR_MAX_OUTPUT = 512 * 1024
const MONITOR_TIMEOUT_MS = 6000

const TRANSFER_CANCELLED = '传输已取消'
const MAX_TRANSFER_DEPTH = 64
const MAX_TRANSFER_FILES = 20_000
const AUTH_ERROR_PATTERN =
  /All configured authentication methods failed|authentication methods failed|Host verification failed|Host denied|Permission denied/i

function isAuthError(err: Error): boolean {
  return AUTH_ERROR_PATTERN.test(err.message || String(err))
}

/**
 * ssh2 reports a rejected password (and every other exhausted auth method)
 * with the same message. Only this text means "asking again can help".
 */
function isPasswordAuthFailure(err: Error): boolean {
  return /All configured authentication methods failed|authentication methods failed/i.test(
    err.message || String(err)
  )
}

const noopZmodemHost: ZmodemHost = {
  pickDownloadDirectory: async () => null,
  pickUploadFiles: async () => null
}

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return resolve(input)
}

function friendlyError(err: Error): string {
  const msg = err.message || String(err)
  if (/All configured authentication methods failed/i.test(msg)) {
    return '认证失败：用户名、密码或密钥不正确'
  }
  if (/Host verification failed|Host denied/i.test(msg)) {
    return '主机密钥校验未通过，连接已中止'
  }
  if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝：目标主机或端口未开放'
  if (/ETIMEDOUT|Timed out/i.test(msg)) return '连接超时，请检查网络与主机地址'
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return '无法解析主机名'
  if (/privateKey|Cannot parse privateKey/i.test(msg)) {
    return '私钥读取失败：文件路径不正确、格式不支持或口令错误'
  }
  return msg
}

/** Run a short command and buffer its stdout, with timeout and size limits. */
function execCapture(client: Client, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    let stream: ClientChannel | null = null
    let timer: NodeJS.Timeout | null = null
    const finish = (error: Error | null, output = ''): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        stream?.close()
      } catch {
        /* the channel may already be gone */
      }
      if (error) reject(error)
      else resolvePromise(output)
    }
    timer = setTimeout(() => finish(new Error('远程监控采集超时')), timeoutMs)
    client.exec(command, (error, channel) => {
      if (error) {
        finish(error)
        return
      }
      stream = channel
      let output = ''
      channel.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > MONITOR_MAX_OUTPUT) finish(new Error('远程监控输出异常'))
      })
      channel.stderr.on('data', () => undefined)
      channel.on('error', (channelError: Error) => finish(channelError))
      channel.on('close', () => finish(null, output))
    })
  })
}

export class SshManager {
  private runtimes = new Map<string, Runtime>()
  private hostKeyRequests = new Map<string, PendingHostKey>()
  private keyboardRequests = new Map<string, PendingKeyboard>()
  private transfers = new Map<string, TransferJob>()
  private monitorBaselines = new Map<string, MonitorBaseline>()
  private monitorJobs = new Map<string, Promise<RemoteMonitorSample>>()
  private readonly tunnels: ForwardService
  private readonly maxReconnectAttempts: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly reconnectWindowMs: number

  constructor(
    private readonly knownHosts: KnownHosts,
    private readonly emit: (event: AppEvent) => void,
    private readonly zmodemHost: ZmodemHost = noopZmodemHost,
    private readonly resolveKey?: KeyResolver,
    private readonly logsDir?: string,
    reconnect: ReconnectPolicy = {},
    /**
     * Called once a password typed into the terminal has been accepted, so the
     * caller can store it encrypted and mark the session accordingly.
     */
    private readonly onPasswordAccepted?: (session: Session, password: string) => void
  ) {
    this.maxReconnectAttempts = reconnect.maxAttempts ?? RETRY_MAX_ATTEMPTS
    this.retryBaseMs = reconnect.baseDelayMs ?? RETRY_BASE_MS
    this.retryMaxMs = reconnect.maxDelayMs ?? RETRY_MAX_MS
    this.reconnectWindowMs = reconnect.windowMs ?? RETRY_WINDOW_MS
    this.tunnels = new ForwardService((runtimeId) => {
      const rt = this.runtimes.get(runtimeId)
      return rt && rt.authenticated && rt.client ? rt.client : null
    }, emit)
  }

  async connect(req: ConnectRequest): Promise<void> {
    this.disconnect(req.runtimeId)

    const rt: Runtime = {
      runtimeId: req.runtimeId,
      session: req.session,
      client: null,
      stream: null,
      sftp: null,
      cols: Math.max(1, req.cols),
      rows: Math.max(1, req.rows),
      manualClose: false,
      failed: false,
      authenticated: false,
      epoch: 0,
      attempt: 0,
      reconnectStartedAt: null,
      retryTimer: null,
      unacked: 0,
      paused: false,
      buffer: [],
      bufferBytes: 0,
      flushTimer: null,
      pendingKeyboard: null,
      zmodem: null,
      jumpClients: [],
      jumpStreams: [],
      log: null,
      passwordRequest: null,
      retryPassword: null,
      passwordAttempts: 0
    }
    this.runtimes.set(req.runtimeId, rt)
    this.emit({ type: 'ssh:status', runtimeId: rt.runtimeId, status: 'connecting' })
    this.open(rt)
  }

  /** Build the ssh2 config for a target host, including the auth method. */
  private connectionOptions(
    rt: Runtime,
    target: { host: string; port: number; username: string },
    auth: AuthConfig = rt.session.auth
  ): ConnectConfig {
    const options: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        this.verifyHostKey(rt, key, verify, target.host, target.port)
      }
    }

    switch (auth.method) {
      case 'password':
        options.password = auth.password ?? ''
        break
      case 'key': {
        if (auth.keyId) {
          const record = this.resolveKey?.(auth.keyId)
          if (!record) throw new Error('密钥不存在或保险库已锁定')
          options.privateKey = record.privateKey
          if (record.passphrase) options.passphrase = record.passphrase
          break
        }
        const keyPath = expandHome(auth.keyPath || '~/.ssh/id_rsa')
        options.privateKey = readFileSyncSafely(keyPath)
        if (auth.password) options.passphrase = auth.password
        break
      }
      case 'agent':
        if (process.env.SSH_AUTH_SOCK) options.agent = process.env.SSH_AUTH_SOCK
        break
      case 'keyboard-interactive':
        break
    }

    return options
  }

  /**
   * Resolve the jump chain. Structured `jumpHosts` win; each hop may carry
   * its own auth. Legacy `proxyJump` strings reuse the session auth.
   */
  private resolveJumps(rt: Runtime): ResolvedJump[] {
    const { session } = rt
    if (session.jumpHosts && session.jumpHosts.length > 0) {
      return session.jumpHosts.map((jump) => ({
        host: jump.host,
        port: jump.port,
        username: jump.username || session.username,
        auth: jump.auth ?? session.auth
      }))
    }
    return parseProxyJump(session.proxyJump).map((hop) => ({
      host: hop.host,
      port: hop.port,
      username: hop.username ?? session.username,
      auth: session.auth
    }))
  }

  /** Open (or re-open) the SSH connection for a runtime. */
  private open(rt: Runtime): void {
    if (rt.manualClose) return
    const epoch = ++rt.epoch
    rt.authenticated = false
    this.closeJump(rt)

    let hops: ResolvedJump[]
    try {
      hops = this.resolveJumps(rt)
    } catch (err) {
      this.fail(rt, (err as Error).message)
      return
    }

    const target = {
      host: rt.session.host,
      port: rt.session.port,
      username: rt.session.username
    }
    if (hops.length === 0) {
      let options: ConnectConfig
      try {
        options = this.connectionOptions(rt, target)
      } catch (err) {
        // Missing/unreadable key files are configuration problems: retrying
        // cannot help.
        this.fail(rt, friendlyError(err as Error))
        return
      }
      this.startClient(rt, options, epoch)
      return
    }
    this.openJumpHop(rt, hops, 0, null, epoch)
  }

  /** Connect through one ProxyJump hop, then continue to the next or final host. */
  private openJumpHop(
    rt: Runtime,
    hops: ResolvedJump[],
    index: number,
    sock: ClientChannel | null,
    epoch: number
  ): void {
    const hop = hops[index]
    let options: ConnectConfig
    try {
      options = this.connectionOptions(
        rt,
        { host: hop.host, port: hop.port, username: hop.username },
        hop.auth
      )
    } catch (err) {
      this.fail(rt, friendlyError(err as Error))
      return
    }
    if (sock) options.sock = sock

    const client = new Client()
    rt.jumpClients.push(client)
    let ready = false

    this.attachKeyboardInteractive(rt, client, epoch, `跳板机 ${hop.host}`)

    client.on('ready', () => {
      if (rt.epoch !== epoch) {
        client.end()
        return
      }
      ready = true
      const next =
        index + 1 < hops.length
          ? { host: hops[index + 1].host, port: hops[index + 1].port }
          : { host: rt.session.host, port: rt.session.port }
      client.forwardOut('127.0.0.1', 0, next.host, next.port, (err, stream) => {
        if (rt.epoch !== epoch) {
          stream?.close()
          return
        }
        if (err) {
          this.fail(
            rt,
            `跳板机 ${hop.host} 转发到 ${next.host}:${next.port} 失败：${friendlyError(err)}`
          )
          return
        }
        rt.jumpStreams.push(stream)
        stream.on('close', () => {
          rt.jumpStreams = rt.jumpStreams.filter((item) => item !== stream)
        })

        if (index + 1 < hops.length) {
          this.openJumpHop(rt, hops, index + 1, stream, epoch)
          return
        }

        let finalOptions: ConnectConfig
        try {
          finalOptions = this.connectionOptions(rt, {
            host: rt.session.host,
            port: rt.session.port,
            username: rt.session.username
          })
        } catch (error) {
          this.fail(rt, friendlyError(error as Error))
          return
        }
        finalOptions.sock = stream
        this.startClient(rt, finalOptions, epoch)
      })
    })

    client.on('error', (err) => {
      if (rt.epoch !== epoch) return
      this.fail(rt, `跳板机 ${hop.host}：${friendlyError(err)}`)
    })

    client.on('close', () => {
      if (rt.epoch !== epoch) return
      if (!ready && !rt.failed && !rt.manualClose) {
        this.fail(rt, `无法连接到跳板机 ${hop.host}`)
      }
    })

    try {
      client.connect(options)
    } catch (err) {
      this.fail(rt, friendlyError(err as Error))
    }
  }

  private attachKeyboardInteractive(
    rt: Runtime,
    client: Client,
    epoch: number,
    label = '键盘交互认证'
  ): void {
    client.on('keyboard-interactive', (_name, instructions, _lang, prompts, finish) => {
      if (rt.epoch !== epoch) {
        finish([])
        return
      }
      const requestId = randomUUID()
      const timer = setTimeout(() => {
        this.keyboardRequests.delete(requestId)
        if (rt.pendingKeyboard) rt.pendingKeyboard.finish([])
        rt.pendingKeyboard = null
        this.fail(rt, '键盘交互认证超时')
        try {
          client.end()
        } catch {
          /* ignore */
        }
      }, 120000)
      rt.pendingKeyboard = { requestId, finish, timer, client }
      this.keyboardRequests.set(requestId, rt.pendingKeyboard)
      this.emit({
        type: 'ssh:keyboard-interactive',
        runtimeId: rt.runtimeId,
        prompt: {
          requestId,
          name: label,
          instructions: instructions || '',
          prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo !== false }))
        }
      })
    })
  }

  /** Attach listeners to the final client and open its shell. */
  private startClient(rt: Runtime, options: ConnectConfig, epoch: number): void {
    const { session } = rt
    const client = new Client()
    rt.client = client
    rt.authenticated = false
    let ready = false
    // Distinguishes an explicit remote shutdown from a transport failure:
    // ssh2 reports SSH_MSG_DISCONNECT as an error with a numeric reason, while
    // a clean QUIT/FIN surfaces as `close` without a preceding error.
    let sawError = false

    client.on('banner', (message) => {
      void message
    })

    this.attachKeyboardInteractive(rt, client, epoch)

    client.on('ready', () => {
      if (rt.epoch !== epoch) {
        client.end()
        return
      }
      ready = true
      rt.authenticated = true
      // A password typed into the terminal worked: store it encrypted and mark
      // the session so later connections do not ask again.
      if (rt.retryPassword !== null) {
        const password = rt.retryPassword
        rt.retryPassword = null
        rt.passwordAttempts = 0
        try {
          this.onPasswordAccepted?.(rt.session, password)
        } catch {
          /* saving credentials must never break the connection */
        }
      }
      const wasReconnect = rt.attempt > 0
      rt.attempt = 0
      rt.reconnectStartedAt = null
      this.emit({ type: 'ssh:status', runtimeId: rt.runtimeId, status: 'connected' })
      if (wasReconnect) {
        this.emit({
          type: 'ssh:notice',
          runtimeId: rt.runtimeId,
          level: 'info',
          message: '已重新连接到主机'
        })
      }
      client.shell(
        {
          term: session.terminal.term || 'xterm-256color',
          cols: rt.cols,
          rows: rt.rows,
          width: 0,
          height: 0
        },
        (err, stream) => {
          // A dead attempt may report its failure after a reconnect has been
          // scheduled; never let that stale callback fail the runtime.
          if (rt.epoch !== epoch) {
            stream?.close()
            return
          }
          if (err) {
            this.fail(rt, `无法打开终端：${err.message}`)
            return
          }
          if (rt.client !== client) {
            stream.close()
            return
          }
          rt.stream = stream
          this.startLog(rt)
          rt.zmodem = new ZmodemController({
            writeRemote: (data) => {
              try {
                rt.stream?.write(Buffer.from(data))
              } catch {
                /* channel may be closing */
              }
            },
            writeTerminal: (data) => {
              const output = Buffer.from(data)
              // Terminal output only: ZMODEM protocol bytes never reach the log.
              rt.log?.write(output)
              this.pushData(rt, output)
            },
            status: (update) => {
              this.emit({ type: 'zmodem:status', runtimeId: rt.runtimeId, ...update })
            },
            remoteWritableLength: () => rt.stream?.writableLength ?? 0,
            host: this.zmodemHost
          })
          stream.on('data', (chunk: Buffer) => {
            if (rt.stream !== stream) return
            if (rt.zmodem) {
              rt.zmodem.feed(chunk)
            } else {
              rt.log?.write(chunk)
              this.pushData(rt, chunk)
            }
          })
          stream.stderr.on('data', (chunk: Buffer) => {
            if (rt.stream !== stream) return
            rt.log?.write(chunk)
            this.pushData(rt, chunk)
          })
          stream.on('close', () => {
            if (rt.stream !== stream) return
            rt.stream = null
            rt.zmodem?.dispose()
            rt.zmodem = null
            this.closeLog(rt)
            this.flushData(rt)
          })
          stream.on('error', (streamErr: Error) => {
            this.emit({
              type: 'ssh:notice',
              runtimeId: rt.runtimeId,
              level: 'error',
              message: streamErr.message
            })
          })
        }
      )
    })

    client.on('error', (err) => {
      if (rt.client !== client) return
      sawError = true
      const message = friendlyError(err)
      if (isAuthError(err)) {
        // Password auth: keep the runtime alive and ask in the terminal
        // instead of ending with a failure dialog.
        if (isPasswordAuthFailure(err) && rt.session.auth.method === 'password') {
          this.requestPassword(rt, client)
          return
        }
        this.fail(rt, message)
        try {
          client.end()
        } catch {
          /* ignore */
        }
        return
      }
      // SSH_MSG_DISCONNECT carries a numeric reason code. The host explicitly
      // said it is going away, so do not keep retrying.
      if (typeof (err as { code?: unknown }).code === 'number') {
        this.stopReconnecting(rt, `主机已断开连接：${message}`)
        return
      }
      // Transport-level failures are retried with exponential backoff.
      this.handleDisconnect(rt, message)
    })

    client.on('close', () => {
      if (rt.client !== client) return
      rt.client = null
      rt.authenticated = false
      rt.stream = null
      rt.sftp = null
      rt.zmodem?.dispose()
      rt.zmodem = null
      this.closeLog(rt)
      this.flushData(rt)
      this.tunnels.stopRuntime(rt.runtimeId)
      this.closeJump(rt)
      if (rt.manualClose || rt.failed) return
      // A clean close without a socket/protocol error is an explicit
      // disconnect (for example ssh2's BY_APPLICATION or the peer shutting
      // down its end). Only transport errors are worth reconnecting.
      if (!sawError) {
        this.stopReconnecting(rt, ready ? '主机已关闭连接' : '主机拒绝了连接')
        return
      }
      this.handleDisconnect(rt, ready ? '连接已断开' : '无法建立连接')
    })

    try {
      client.connect(options)
    } catch (err) {
      this.fail(rt, friendlyError(err as Error))
    }
  }

  /** Schedule an exponential-backoff reconnect for a dropped connection. */
  private handleDisconnect(rt: Runtime, message: string): void {
    if (rt.manualClose || rt.failed || rt.retryTimer) return

    // Invalidate every callback belonging to the dead connection before
    // scheduling the next attempt.
    rt.epoch += 1
    this.closeLog(rt)
    this.closeJump(rt)
    const now = Date.now()
    rt.reconnectStartedAt ??= now
    rt.attempt += 1
    if (
      rt.attempt > this.maxReconnectAttempts ||
      now - rt.reconnectStartedAt >= this.reconnectWindowMs
    ) {
      this.stopReconnecting(rt, '自动重连超时，已停止重试')
      return
    }
    const backoff = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (rt.attempt - 1))
    const delay = backoff + Math.floor(Math.random() * 250)
    this.emit({
      type: 'ssh:status',
      runtimeId: rt.runtimeId,
      status: 'reconnecting',
      message: `${message}，${Math.max(1, Math.round(delay / 1000))} 秒后第 ${rt.attempt} 次重试`
    })

    rt.retryTimer = setTimeout(() => {
      rt.retryTimer = null
      if (rt.manualClose || !this.runtimes.has(rt.runtimeId)) return
      this.open(rt)
    }, delay)
  }

  /**
   * Retry budget exhausted: tear the runtime down and report `closed` so the
   * terminal shows the manual "Reconnect" button instead of silently keeping
   * a reconnecting session alive forever.
   */
  private stopReconnecting(rt: Runtime, message: string): void {
    if (rt.manualClose || rt.failed) return
    // `failed` also tells late client/stream callbacks to stand down.
    rt.failed = true
    rt.epoch += 1
    if (rt.retryTimer) {
      clearTimeout(rt.retryTimer)
      rt.retryTimer = null
    }
    this.tunnels.stopRuntime(rt.runtimeId)
    this.closeLog(rt)
    rt.zmodem?.dispose()
    rt.zmodem = null
    this.closeJump(rt)
    const client = rt.client
    rt.client = null
    rt.stream = null
    rt.sftp = null
    rt.authenticated = false
    this.flushData(rt)
    try {
      client?.end()
    } catch {
      /* ignore */
    }
    this.emit({ type: 'ssh:status', runtimeId: rt.runtimeId, status: 'closed', message })
  }

  private verifyHostKey(
    rt: Runtime,
    key: Buffer,
    verify: (ok: boolean) => void,
    host: string,
    port: number
  ): void {
    const existing = this.knownHosts.lookup(host, port, key)
    if (existing.state === 'known') {
      verify(true)
      return
    }
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      this.hostKeyRequests.delete(requestId)
      verify(false)
    }, 60000)
    const pending: PendingHostKey = { verify, timer, host, port, key, runtimeId: rt.runtimeId }
    this.hostKeyRequests.set(requestId, pending)
    this.emit({
      type: 'ssh:hostkey',
      runtimeId: rt.runtimeId,
      prompt: {
        requestId,
        host,
        port,
        algorithm: parseKeyAlgorithm(key),
        fingerprint: fingerprintOf(key),
        changed: existing.state === 'changed',
        oldFingerprint: existing.oldFingerprint
      }
    })
  }

  hostKeyDecision(requestId: string, accept: boolean): void {
    const pending = this.hostKeyRequests.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.hostKeyRequests.delete(requestId)
    if (accept) {
      this.knownHosts.save(pending.host, pending.port, pending.key)
      pending.verify(true)
    } else {
      pending.verify(false)
    }
  }

  keyboardInteractive(requestId: string, responses?: string[], cancel?: boolean): void {
    const pending = this.keyboardRequests.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.keyboardRequests.delete(requestId)
    const rt = this.runtimes.get(this.findRuntimeByKeyboard(pending) ?? '')
    if (rt) rt.pendingKeyboard = null
    if (cancel) {
      if (rt) this.fail(rt, '认证已取消')
      pending.finish([])
      try {
        pending.client.end()
      } catch {
        /* ignore */
      }
      return
    }
    pending.finish(responses ?? [])
  }

  private findRuntimeByKeyboard(pending: PendingKeyboard): string | undefined {
    for (const [id, rt] of this.runtimes) {
      if (rt.pendingKeyboard === pending) return id
    }
    return undefined
  }

  /**
   * Password authentication failed. Drop the dead attempt but keep the runtime
   * so the renderer can collect a new password inline in the terminal.
   */
  private requestPassword(rt: Runtime, client: Client): void {
    // Everything the failed attempt reports from now on is irrelevant.
    rt.epoch += 1
    rt.authenticated = false
    rt.passwordAttempts += 1
    rt.retryPassword = null
    const requestId = randomUUID()
    rt.passwordRequest = requestId
    // Nulling the client makes the close/error handlers stand down; the next
    // attempt builds a fresh client (and fresh jump hops).
    if (rt.client === client) rt.client = null
    this.closeJump(rt)
    try {
      client.end()
    } catch {
      /* already closing */
    }
    this.emit({
      type: 'ssh:password-request',
      runtimeId: rt.runtimeId,
      prompt: {
        requestId,
        host: rt.session.host,
        username: rt.session.username,
        attempt: rt.passwordAttempts
      }
    })
  }

  /** Retry authentication with a password typed into the terminal. */
  providePassword(requestId: string, password: string): void {
    const rt = this.findRuntimeByPasswordRequest(requestId)
    if (!rt) return
    rt.passwordRequest = null
    rt.retryPassword = password
    rt.session = {
      ...rt.session,
      auth: { ...rt.session.auth, method: 'password', password }
    }
    this.open(rt)
  }

  /** The user pressed Ctrl+C while the inline password prompt was open. */
  cancelPassword(requestId: string): void {
    const rt = this.findRuntimeByPasswordRequest(requestId)
    if (!rt) return
    rt.passwordRequest = null
    rt.retryPassword = null
    this.fail(rt, '认证失败：已取消输入密码')
  }

  private findRuntimeByPasswordRequest(requestId: string): Runtime | undefined {
    for (const rt of this.runtimes.values()) {
      if (rt.passwordRequest === requestId) return rt
    }
    return undefined
  }

  /** Append a public key to the remote user's authorized_keys. */
  async installPublicKey(runtimeId: string, publicKey: string): Promise<void> {
    const rt = this.runtimes.get(runtimeId)
    const client = rt?.client
    if (!rt || !client || !rt.authenticated) throw new Error('SSH 会话未连接')
    const command = buildAuthorizedKeysCommand(publicKey)

    await new Promise<void>((resolvePromise, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err)
          return
        }
        let stderr = ''
        stream.on('data', () => undefined)
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        stream.on('error', reject)
        stream.on('close', (code: number | null) => {
          if (code === 0) resolvePromise()
          else reject(new Error(stderr.trim() || `安装公钥失败（退出码 ${code ?? '未知'}）`))
        })
      })
    })
  }

  async startTunnel(config: TunnelConfig): Promise<TunnelInfo> {
    const rt = this.runtimes.get(config.runtimeId)
    if (!rt || !rt.authenticated || !rt.client) {
      throw new Error('SSH 会话未连接，无法启动端口转发')
    }
    return await this.tunnels.start(config)
  }

  stopTunnel(id: string): void {
    this.tunnels.stop(id)
  }

  listTunnels(runtimeId: string): TunnelInfo[] {
    return this.tunnels.list(runtimeId)
  }

  /**
   * Sample host resources over an existing SSH connection. Overlapping polls
   * for the same runtime share one in-flight exec so a slow host cannot queue
   * up channels.
   */
  sampleMonitor(runtimeId: string): Promise<RemoteMonitorSample> {
    const pending = this.monitorJobs.get(runtimeId)
    if (pending) return pending
    const job = this.collectMonitor(runtimeId).finally(() => {
      if (this.monitorJobs.get(runtimeId) === job) this.monitorJobs.delete(runtimeId)
    })
    this.monitorJobs.set(runtimeId, job)
    return job
  }

  private async collectMonitor(runtimeId: string): Promise<RemoteMonitorSample> {
    const rt = this.runtimes.get(runtimeId)
    if (!rt || !rt.authenticated || !rt.client) {
      throw new Error('SSH 会话未连接，无法读取远程监控')
    }
    const raw = await execCapture(rt.client, MONITOR_COMMAND, MONITOR_TIMEOUT_MS)
    const reading = parseMonitorOutput(raw, Date.now(), this.monitorBaselines.get(runtimeId))
    this.monitorBaselines.set(runtimeId, reading.baseline)
    return reading.sample
  }

  write(runtimeId: string, data: string): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt?.stream) return
    // Chunk large pastes to avoid overwhelming the channel.
    const buf = Buffer.from(data, 'utf8')
    const CHUNK = 32 * 1024
    for (let offset = 0; offset < buf.length; offset += CHUNK) {
      rt.stream.write(buf.subarray(offset, offset + CHUNK))
    }
  }

  resize(runtimeId: string, cols: number, rows: number): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt) return
    rt.cols = Math.max(1, cols)
    rt.rows = Math.max(1, rows)
    try {
      rt.stream?.setWindow(rt.rows, rt.cols, 0, 0)
    } catch {
      /* stream may be closing */
    }
  }

  ack(runtimeId: string, bytes: number): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt) return
    rt.unacked = Math.max(0, rt.unacked - Math.max(0, bytes))
    if (rt.paused && rt.unacked < 512 * 1024) {
      rt.paused = false
      rt.stream?.resume()
    }
  }

  disconnect(runtimeId: string): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt) return
    // Invalidate callbacks that belong to an in-flight connection attempt.
    rt.epoch += 1
    for (const job of this.transfers.values()) {
      if (job.runtimeId !== runtimeId) continue
      job.cancelled = true
      job.abort()
    }
    rt.manualClose = true
    this.tunnels.stopRuntime(runtimeId)
    this.closeLog(rt)
    rt.zmodem?.dispose()
    rt.zmodem = null
    if (rt.retryTimer) {
      clearTimeout(rt.retryTimer)
      rt.retryTimer = null
    }
    if (rt.pendingKeyboard) {
      clearTimeout(rt.pendingKeyboard.timer)
      this.keyboardRequests.delete(rt.pendingKeyboard.requestId)
      rt.pendingKeyboard = null
    }
    for (const [requestId, pending] of this.hostKeyRequests) {
      if (pending.runtimeId !== runtimeId) continue
      clearTimeout(pending.timer)
      this.hostKeyRequests.delete(requestId)
      pending.verify(false)
    }
    if (rt.flushTimer) {
      clearTimeout(rt.flushTimer)
      rt.flushTimer = null
    }
    this.closeJump(rt)
    this.flushData(rt)
    try {
      rt.stream?.close()
    } catch {
      /* ignore */
    }
    try {
      rt.client?.end()
    } catch {
      /* ignore */
    }
    rt.stream = null
    rt.sftp = null
    rt.client = null
    this.monitorBaselines.delete(runtimeId)
    this.monitorJobs.delete(runtimeId)
    this.runtimes.delete(runtimeId)
    this.emit({ type: 'ssh:status', runtimeId, status: 'closed' })
  }

  private fail(rt: Runtime, message: string): void {
    if (rt.failed) return
    rt.failed = true
    // Any callback still in flight belongs to the attempt that just failed.
    rt.epoch += 1
    this.tunnels.stopRuntime(rt.runtimeId)
    for (const job of this.transfers.values()) {
      if (job.runtimeId !== rt.runtimeId) continue
      job.cancelled = true
      job.abort()
    }
    this.closeLog(rt)
    rt.zmodem?.dispose()
    rt.zmodem = null
    if (rt.retryTimer) {
      clearTimeout(rt.retryTimer)
      rt.retryTimer = null
    }
    this.closeJump(rt)
    this.emit({ type: 'ssh:status', runtimeId: rt.runtimeId, status: 'failed', message })
  }

  private startLog(rt: Runtime): void {
    const config = rt.session.logging
    if (!config?.enabled || !this.logsDir || rt.log) return
    try {
      const directory = resolveLogDirectory(config.directory, this.logsDir)
      rt.log = new SessionLogger(directory, `${rt.session.name}-${rt.runtimeId}`, {
        format: config.format,
        timestamps: config.timestamps,
        cols: rt.cols,
        rows: rt.rows,
        term: rt.session.terminal.term
      })
    } catch (err) {
      this.emit({
        type: 'ssh:notice',
        runtimeId: rt.runtimeId,
        level: 'error',
        message: `无法创建会话日志：${(err as Error).message}`
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

  /** Close every ProxyJump client and forwarding channel held by a runtime. */
  private closeJump(rt: Runtime): void {
    for (const stream of rt.jumpStreams) {
      try {
        stream.close()
      } catch {
        /* ignore */
      }
    }
    rt.jumpStreams = []
    for (const client of rt.jumpClients) {
      try {
        client.end()
      } catch {
        /* ignore */
      }
    }
    rt.jumpClients = []
  }

  private pushData(rt: Runtime, chunk: Buffer): void {
    rt.buffer.push(chunk)
    rt.bufferBytes += chunk.length
    rt.unacked += chunk.length
    if (!rt.flushTimer) {
      rt.flushTimer = setTimeout(() => this.flushData(rt), 8)
    }
    if (rt.unacked > 2 * 1024 * 1024 && !rt.paused) {
      rt.paused = true
      try {
        rt.stream?.pause()
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

  // ---------------------------------------------------------------- SFTP

  private async getSftp(runtimeId: string): Promise<SFTPWrapper> {
    const rt = this.runtimes.get(runtimeId)
    if (!rt?.client) throw new Error('SSH 会话未连接')
    if (rt.sftp) return rt.sftp
    const client = rt.client
    return await new Promise<SFTPWrapper>((resolvePromise, reject) => {
      client.sftp((err, sftp) => {
        if (err) reject(err)
        else {
          rt.sftp = sftp
          resolvePromise(sftp)
        }
      })
    })
  }

  async sftpHome(runtimeId: string): Promise<string> {
    const sftp = await this.getSftp(runtimeId)
    return await new Promise<string>((resolvePromise, reject) => {
      sftp.realpath('.', (err, path) => (err ? reject(err) : resolvePromise(path)))
    })
  }

  /**
   * Directory the SFTP remote pane opens in: the host's desktop folder when it
   * exists, otherwise the login home. Localized desktops (e.g. Chinese `桌面`)
   * are covered so the pane lands somewhere useful on non-English hosts.
   */
  async sftpStartDir(runtimeId: string): Promise<string> {
    const home = await this.sftpHome(runtimeId)
    const sftp = await this.getSftp(runtimeId)
    for (const name of ['Desktop', '桌面']) {
      const candidate = home === '/' ? `/${name}` : posix.join(home, name)
      const isDir = await new Promise<boolean>((resolvePromise) => {
        sftp.stat(candidate, (err, attrs) => {
          if (err || !attrs) {
            resolvePromise(false)
            return
          }
          resolvePromise(typeof attrs.isDirectory === 'function' ? attrs.isDirectory() : false)
        })
      })
      if (isDir) return candidate
    }
    return home
  }

  async sftpList(runtimeId: string, path: string): Promise<FileEntry[]> {
    const sftp = await this.getSftp(runtimeId)
    const dir = normalizeRemotePath(path)
    const entries = await new Promise<SftpRawEntry[]>((resolvePromise, reject) => {
      sftp.readdir(dir, (err, list) => (err ? reject(err) : resolvePromise(list)))
    })
    return entries
      .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
      .map((entry) => {
        const attrs = entry.attrs
        const isDir = typeof attrs.isDirectory === 'function' ? attrs.isDirectory() : false
        const isLink = typeof attrs.isSymbolicLink === 'function' ? attrs.isSymbolicLink() : false
        return {
          name: entry.filename,
          path: dir === '/' ? `/${entry.filename}` : posix.join(dir, entry.filename),
          type: isDir ? 'directory' : isLink ? 'symlink' : 'file',
          size: attrs.size ?? 0,
          mtime: (attrs.mtime ?? 0) * 1000,
          mode: attrs.mode ?? 0
        } as FileEntry
      })
      .sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (b.type === 'directory' && a.type !== 'directory') return 1
        return a.name.localeCompare(b.name)
      })
  }

  async sftpMkdir(runtimeId: string, path: string): Promise<void> {
    const sftp = await this.getSftp(runtimeId)
    const dir = normalizeRemotePath(path)
    await new Promise<void>((resolvePromise, reject) => {
      sftp.mkdir(dir, (err) => (err ? reject(err) : resolvePromise()))
    })
  }

  async sftpRemove(runtimeId: string, path: string, isDir: boolean): Promise<void> {
    const sftp = await this.getSftp(runtimeId)
    const target = normalizeRemotePath(path)
    await new Promise<void>((resolvePromise, reject) => {
      const done = (err: Error | null | undefined): void => (err ? reject(err) : resolvePromise())
      if (isDir) sftp.rmdir(target, done)
      else sftp.unlink(target, done)
    })
  }

  async sftpRename(runtimeId: string, from: string, to: string): Promise<void> {
    const sftp = await this.getSftp(runtimeId)
    const source = normalizeRemotePath(from)
    const target = normalizeRemotePath(to)
    await new Promise<void>((resolvePromise, reject) => {
      sftp.rename(source, target, (err) => (err ? reject(err) : resolvePromise()))
    })
  }

  async sftpChmod(runtimeId: string, path: string, mode: number): Promise<void> {
    const sftp = await this.getSftp(runtimeId)
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new Error('权限值无效，应为 0 到 07777 的八进制数')
    }
    const target = normalizeRemotePath(path)
    await new Promise<void>((resolvePromise, reject) => {
      sftp.chmod(target, mode, (err) => (err ? reject(err) : resolvePromise()))
    })
  }

  async upload(
    runtimeId: string,
    localPaths: string[],
    remoteDir: string,
    transferId = `sftp-${randomUUID()}`
  ): Promise<void> {
    const sftp = await this.getSftp(runtimeId)
    if (this.transfers.has(transferId)) throw new Error('传输 ID 已在使用')
    const dir = normalizeRemotePath(remoteDir)
    const job: TransferJob = { runtimeId, cancelled: false, abort: () => undefined }
    this.transfers.set(transferId, job)
    let uploaded = 0
    try {
      for (const localPath of localPaths) {
        if (job.cancelled) throw new Error(TRANSFER_CANCELLED)
        uploaded += await this.uploadPath(sftp, job, transferId, runtimeId, localPath, dir, 0)
      }
      this.emitTransfer(runtimeId, transferId, 'upload', 'complete', '', uploaded, uploaded)
    } catch (error) {
      const cancelled = job.cancelled || (error as Error).message === TRANSFER_CANCELLED
      this.emitTransfer(
        runtimeId,
        transferId,
        'upload',
        cancelled ? 'cancelled' : 'error',
        '',
        uploaded,
        uploaded,
        (error as Error).message
      )
      throw new Error(cancelled ? TRANSFER_CANCELLED : (error as Error).message)
    } finally {
      this.transfers.delete(transferId)
      job.abort = () => undefined
    }
  }

  private async uploadPath(
    sftp: SFTPWrapper,
    job: TransferJob,
    transferId: string,
    runtimeId: string,
    localPath: string,
    remoteDir: string,
    depth: number
  ): Promise<number> {
    if (depth > MAX_TRANSFER_DEPTH) throw new Error('目录层级过深，已中止上传')
    const stats = lstatSync(localPath)
    // Never follow local symlinks: they can point outside the selected tree.
    if (stats.isSymbolicLink()) return 0
    const remotePath = joinRemotePath(remoteDir, sanitizeLocalName(basename(localPath)))
    if (stats.isDirectory()) {
      await mkdirRemote(sftp, remotePath)
      let total = 0
      for (const child of readdirSync(localPath)) {
        if (job.cancelled) throw new Error(TRANSFER_CANCELLED)
        total += await this.uploadPath(
          sftp,
          job,
          transferId,
          runtimeId,
          join(localPath, child),
          remotePath,
          depth + 1
        )
      }
      return total
    }
    if (!stats.isFile()) return 0

    const name = basename(localPath)
    const total = stats.size
    const tempPath = `${remotePath.slice(0, remotePath.lastIndexOf('/'))}/.hshell-upload-${randomUUID().slice(0, 8)}`
    this.emitTransfer(runtimeId, transferId, 'upload', 'running', name, 0, total)

    await this.pipeUpload(sftp, job, transferId, runtimeId, localPath, tempPath, remotePath, name, total)
    return total
  }

  private pipeUpload(
    sftp: SFTPWrapper,
    job: TransferJob,
    transferId: string,
    runtimeId: string,
    localPath: string,
    tempPath: string,
    targetPath: string,
    name: string,
    total: number
  ): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      let settled = false
      let transferred = 0
      let lastEmit = 0
      const read = createReadStream(localPath)
      const write = sftp.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })

      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        job.abort = () => undefined
        if (!error) {
          resolvePromise()
          return
        }
        sftp.unlink(tempPath, () => reject(error))
      }

      job.abort = () => {
        read.destroy()
        write.destroy()
      }

      read.on('data', (chunk: Buffer) => {
        if (job.cancelled) {
          read.destroy()
          write.destroy()
          finish(new Error(TRANSFER_CANCELLED))
          return
        }
        transferred += chunk.length
        const now = Date.now()
        if (now - lastEmit >= 100) {
          lastEmit = now
          this.emitTransfer(
            runtimeId,
            transferId,
            'upload',
            'running',
            name,
            transferred,
            total
          )
        }
      })
      read.on('error', (error: Error) => finish(error))
      write.on('error', (error: Error) => finish(error))
      write.on('close', () => {
        if (settled) return
        if (job.cancelled) {
          finish(new Error(TRANSFER_CANCELLED))
          return
        }
        this.renameRemoteReplacing(sftp, tempPath, targetPath, (error) => {
          if (error) finish(error)
          else {
            this.emitTransfer(runtimeId, transferId, 'upload', 'running', name, total, total)
            finish()
          }
        })
      })
      read.pipe(write)
    })
  }

  async download(
    runtimeId: string,
    remotePaths: string[],
    localDir: string,
    transferId = `sftp-${randomUUID()}`
  ): Promise<void> {
    const sftp = await this.getSftp(runtimeId)
    if (this.transfers.has(transferId)) throw new Error('传输 ID 已在使用')
    mkdirSync(localDir, { recursive: true })
    const root = realpathSync(localDir)
    const job: TransferJob = { runtimeId, cancelled: false, abort: () => undefined }
    this.transfers.set(transferId, job)
    const counter: DownloadCounter = { files: 0 }
    let downloaded = 0
    try {
      for (const remotePath of remotePaths) {
        if (job.cancelled) throw new Error(TRANSFER_CANCELLED)
        downloaded += await this.downloadPath(
          sftp,
          job,
          transferId,
          runtimeId,
          normalizeRemotePath(remotePath),
          root,
          root,
          0,
          counter
        )
      }
      this.emitTransfer(runtimeId, transferId, 'download', 'complete', '', downloaded, downloaded)
    } catch (error) {
      const cancelled = job.cancelled || (error as Error).message === TRANSFER_CANCELLED
      this.emitTransfer(
        runtimeId,
        transferId,
        'download',
        cancelled ? 'cancelled' : 'error',
        '',
        downloaded,
        downloaded,
        (error as Error).message
      )
      throw new Error(cancelled ? TRANSFER_CANCELLED : (error as Error).message)
    } finally {
      this.transfers.delete(transferId)
      job.abort = () => undefined
    }
  }

  private async downloadPath(
    sftp: SFTPWrapper,
    job: TransferJob,
    transferId: string,
    runtimeId: string,
    remotePath: string,
    localDir: string,
    root: string,
    depth: number,
    counter: DownloadCounter
  ): Promise<number> {
    if (depth > MAX_TRANSFER_DEPTH) throw new Error('远程目录层级过深，已中止下载')
    counter.files += 1
    if (counter.files > MAX_TRANSFER_FILES) throw new Error('远程文件数量过多，已中止下载')

    const stats = await this.lstatRemote(sftp, remotePath)
    if (stats.isSymbolicLink()) return 0
    const target = localChildPath(localDir, remotePath, root)

    if (stats.isDirectory()) {
      this.ensureLocalDir(root, target)
      const children = await new Promise<SftpRawEntry[]>((resolvePromise, reject) => {
        sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolvePromise(list)))
      })
      let total = 0
      for (const child of children) {
        if (child.filename === '.' || child.filename === '..') continue
        if (job.cancelled) throw new Error(TRANSFER_CANCELLED)
        const isLink =
          typeof child.attrs.isSymbolicLink === 'function' && child.attrs.isSymbolicLink()
        if (isLink) continue
        const childPath = joinRemotePath(remotePath, child.filename)
        total += await this.downloadPath(
          sftp,
          job,
          transferId,
          runtimeId,
          childPath,
          target,
          root,
          depth + 1,
          counter
        )
      }
      return total
    }
    if (!stats.isFile()) return 0

    const name = sanitizeLocalName(basename(remotePath))
    const total = stats.size ?? 0
    const tempPath = resolve(localDir, `.hshell-download-${randomUUID().slice(0, 8)}`)
    assertInside(root, tempPath)
    this.emitTransfer(runtimeId, transferId, 'download', 'running', name, 0, total)

    await this.pipeDownload(sftp, job, transferId, runtimeId, remotePath, tempPath, target, name, total)
    return total
  }

  private pipeDownload(
    sftp: SFTPWrapper,
    job: TransferJob,
    transferId: string,
    runtimeId: string,
    remotePath: string,
    tempPath: string,
    targetPath: string,
    name: string,
    total: number
  ): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      let settled = false
      let transferred = 0
      let lastEmit = 0
      const read = sftp.createReadStream(remotePath)
      const write = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })

      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        job.abort = () => undefined
        if (error) {
          try {
            unlinkSync(tempPath)
          } catch {
            /* may not exist yet */
          }
          reject(error)
          return
        }
        try {
          if (existsSync(targetPath)) unlinkSync(targetPath)
          renameSync(tempPath, targetPath)
          resolvePromise()
        } catch (renameError) {
          try {
            unlinkSync(tempPath)
          } catch {
            /* ignore */
          }
          reject(renameError as Error)
        }
      }

      job.abort = () => {
        read.destroy()
        write.destroy()
      }

      read.on('data', (chunk: Buffer) => {
        if (job.cancelled) {
          read.destroy()
          write.destroy()
          finish(new Error(TRANSFER_CANCELLED))
          return
        }
        transferred += chunk.length
        const now = Date.now()
        if (now - lastEmit >= 100) {
          lastEmit = now
          this.emitTransfer(
            runtimeId,
            transferId,
            'download',
            'running',
            name,
            transferred,
            total
          )
        }
      })
      read.on('error', (error: Error) => finish(error))
      write.on('error', (error) => finish(error))
      write.on('close', () => {
        if (settled) return
        if (job.cancelled) {
          finish(new Error(TRANSFER_CANCELLED))
          return
        }
        this.emitTransfer(runtimeId, transferId, 'download', 'running', name, total, total)
        finish()
      })
      read.pipe(write)
    })
  }

  /** Cancel any running SFTP transfer by its renderer-supplied id. */
  cancelTransfer(transferId: string): void {
    const job = this.transfers.get(transferId)
    if (!job) return
    job.cancelled = true
    job.abort()
  }

  private renameRemoteReplacing(
    sftp: SFTPWrapper,
    from: string,
    to: string,
    done: (error?: Error) => void
  ): void {
    sftp.rename(from, to, (error) => {
      if (!error) {
        done()
        return
      }
      // Some servers refuse to overwrite; remove the destination first.
      sftp.unlink(to, () => {
        sftp.rename(from, to, (retryError) => done(retryError ?? undefined))
      })
    })
  }

  private lstatRemote(
    sftp: SFTPWrapper,
    path: string
  ): Promise<{
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
    size?: number
  }> {
    return new Promise((resolvePromise, reject) => {
      sftp.lstat(path, (error, stats) => (error ? reject(error) : resolvePromise(stats)))
    })
  }

  private ensureLocalDir(root: string, target: string): void {
    assertInside(root, target)
    if (existsSync(target)) {
      const stats = lstatSync(target)
      if (stats.isSymbolicLink()) throw new Error('本地目标包含符号链接，已中止下载')
      if (!stats.isDirectory()) throw new Error('本地目标已存在且不是目录')
      if (!isInside(root, realpathSync(target))) {
        throw new Error('本地目标超出允许的目录')
      }
      return
    }
    mkdirSync(target, { recursive: true })
  }

  private emitTransfer(
    runtimeId: string,
    transferId: string,
    direction: 'upload' | 'download',
    phase: 'running' | 'complete' | 'cancelled' | 'error',
    fileName: string,
    transferred: number,
    total: number,
    message?: string
  ): void {
    this.emit({
      type: 'sftp:progress',
      transferId,
      runtimeId,
      direction,
      phase,
      fileName,
      transferred,
      total,
      ...(message ? { message } : {})
    })
  }
}

function readFileSyncSafely(path: string): Buffer {
  if (!existsSync(path)) throw new Error(`私钥文件不存在：${path}`)
  return readFileSync(path)
}

function mkdirRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    sftp.mkdir(path, (err) => {
      if (!err) return resolvePromise()
      // Directory may already exist; verify with stat.
      sftp.stat(path, (statErr, stats) => {
        if (!statErr && stats.isDirectory()) resolvePromise()
        else reject(err)
      })
    })
  })
}


