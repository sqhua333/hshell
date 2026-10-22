import { statSync } from 'node:fs'
import { basename, join, posix } from 'node:path'
import { Client, FileType, type FileInfo } from 'basic-ftp'
import type {
  AppEvent,
  ConnectRequest,
  FileEntry,
  SftpProgressEvent,
  Session
} from '@shared/types'

interface FtpAccess {
  host: string
  port: number
  user: string
  password: string
  secure: boolean
}

interface Runtime {
  runtimeId: string
  session: Session
  access: FtpAccess
  client: Client
  manualClose: boolean
}

interface Transfer {
  runtimeId: string
  direction: SftpProgressEvent['direction']
  cancelled: boolean
}

const CONNECT_TIMEOUT_MS = 20_000

/** Remote paths come from the renderer; reject control characters. */
function safePath(path: string): string {
  const value = String(path ?? '')
  if (/[\u0000\r\n]/.test(value)) throw new Error('远程路径包含非法字符')
  return value || '/'
}

export function joinRemote(dir: string, name: string): string {
  const base = safePath(dir)
  const clean = name.replace(/^\/+/, '')
  if (!clean || /[\u0000\r\n]/.test(clean)) throw new Error('文件名无效')
  if (base === '/' || base === '.') return `/${clean}`
  return posix.join(base, clean)
}

export function toFileEntry(info: FileInfo, dir: string): FileEntry {
  const type =
    info.type === FileType.Directory
      ? 'directory'
      : info.type === FileType.SymbolicLink
        ? 'symlink'
        : info.type === FileType.File
          ? 'file'
          : 'other'
  return {
    name: info.name,
    path: joinRemote(dir, info.name),
    type,
    size: info.size,
    mtime: info.modifiedAt?.getTime() ?? 0,
    mode: 0
  }
}

function friendlyError(error: Error): string {
  const message = error.message || String(error)
  if (/ECONNREFUSED/i.test(message)) return 'FTP 服务器拒绝连接'
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return '找不到 FTP 主机'
  if (/ETIMEDOUT|timeout/i.test(message)) return 'FTP 连接超时'
  if (/530/i.test(message)) return 'FTP 登录失败：用户名或密码错误'
  if (/ECONNRESET|EPIPE/i.test(message)) return 'FTP 连接已断开'
  return message
}

/**
 * FTP / explicit-FTPS backend. It owns one control connection per runtime and
 * maps remote directories onto the same `FileEntry` shape used by SFTP, so the
 * renderer can share the file-transfer UI.
 */
export class FtpManager {
  private runtimes = new Map<string, Runtime>()
  private transfers = new Map<string, Transfer>()

  constructor(private readonly emit: (event: AppEvent) => void) {}

  has(runtimeId: string): boolean {
    return this.runtimes.has(runtimeId)
  }

  async connect(req: ConnectRequest): Promise<void> {
    this.disconnect(req.runtimeId)
    const runtimeId = req.runtimeId
    const session = req.session
    const access: FtpAccess = {
      host: session.host.trim(),
      port: Number(session.port),
      user: session.username || 'anonymous',
      password: session.auth.password ?? '',
      secure: Boolean(session.ftp?.secure)
    }
    this.emit({ type: 'ssh:status', runtimeId, status: 'connecting' })
    if (
      !access.host ||
      !Number.isInteger(access.port) ||
      access.port < 1 ||
      access.port > 65535
    ) {
      this.emit({
        type: 'ssh:status',
        runtimeId,
        status: 'failed',
        message: 'FTP 主机或端口无效'
      })
      return
    }

    const client = new Client(CONNECT_TIMEOUT_MS)
    const rt: Runtime = { runtimeId, session, access, client, manualClose: false }
    this.runtimes.set(runtimeId, rt)
    try {
      await client.access(access)
      if (this.runtimes.get(runtimeId) !== rt) {
        client.close()
        return
      }
      this.emit({ type: 'ssh:status', runtimeId, status: 'connected' })
    } catch (error) {
      if (this.runtimes.get(runtimeId) === rt) {
        this.runtimes.delete(runtimeId)
        client.close()
        this.emit({
          type: 'ssh:status',
          runtimeId,
          status: 'failed',
          message: friendlyError(error as Error)
        })
      }
    }
  }

  write(_runtimeId: string, _data: string): void {
    /* FTP sessions have no terminal input. */
  }

  resize(_runtimeId: string, _cols: number, _rows: number): void {
    /* no window size for a file-transfer session */
  }

  ack(_runtimeId: string, _bytes: number): void {
    /* no terminal stream */
  }

  disconnect(runtimeId: string): void {
    const rt = this.runtimes.get(runtimeId)
    if (!rt) return
    rt.manualClose = true
    this.runtimes.delete(runtimeId)
    for (const [id, transfer] of this.transfers) {
      if (transfer.runtimeId === runtimeId) {
        transfer.cancelled = true
        this.transfers.delete(id)
      }
    }
    try {
      rt.client.close()
    } catch {
      /* ignore */
    }
    this.emit({ type: 'ssh:status', runtimeId, status: 'closed' })
  }

  async home(runtimeId: string): Promise<string> {
    return (await this.ready(runtimeId)).client.pwd()
  }

  async startDir(runtimeId: string): Promise<string> {
    return (await this.ready(runtimeId)).client.pwd()
  }

  async list(runtimeId: string, path: string): Promise<FileEntry[]> {
    const dir = safePath(path)
    const client = (await this.ready(runtimeId)).client
    try {
      const entries = await client.list(dir === '.' ? undefined : dir)
      return entries
        .filter((info) => info.name !== '.' && info.name !== '..')
        .map((info) => toFileEntry(info, dir))
        .sort((a, b) => {
          if (a.type === 'directory' && b.type !== 'directory') return -1
          if (b.type === 'directory' && a.type !== 'directory') return 1
          return a.name.localeCompare(b.name)
        })
    } catch (error) {
      throw new Error(`FTP 目录读取失败：${friendlyError(error as Error)}`)
    }
  }

  async mkdir(runtimeId: string, path: string): Promise<void> {
    const client = (await this.ready(runtimeId)).client
    await this.command(client, `MKD ${safePath(path)}`)
  }

  async remove(runtimeId: string, path: string, isDir: boolean): Promise<void> {
    const client = (await this.ready(runtimeId)).client
    const target = safePath(path)
    if (isDir) {
      await this.command(client, `RMD ${target}`)
      return
    }
    try {
      await client.remove(target)
    } catch (error) {
      throw new Error(`FTP 删除失败：${friendlyError(error as Error)}`)
    }
  }

  async rename(runtimeId: string, from: string, to: string): Promise<void> {
    const client = (await this.ready(runtimeId)).client
    try {
      await client.rename(safePath(from), safePath(to))
    } catch (error) {
      throw new Error(`FTP 重命名失败：${friendlyError(error as Error)}`)
    }
  }

  async chmod(runtimeId: string, path: string, mode: number): Promise<void> {
    const client = (await this.ready(runtimeId)).client
    const value = mode.toString(8)
    await this.command(client, `SITE CHMOD ${value} ${safePath(path)}`)
  }

  async upload(
    runtimeId: string,
    localPaths: string[],
    remoteDir: string,
    transferId?: string
  ): Promise<void> {
    const rt = await this.ready(runtimeId)
    const id = transferId ?? `ftp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const transfer: Transfer = { runtimeId, direction: 'upload', cancelled: false }
    this.transfers.set(id, transfer)
    try {
      for (const localPath of localPaths) {
        if (transfer.cancelled) return
        const name = basename(localPath)
        let total = 0
        try {
          total = statSync(localPath).size
        } catch {
          total = 0
        }
        let target: string
        try {
          target = joinRemote(remoteDir, name)
        } catch (error) {
          this.emitProgress(id, runtimeId, 'upload', 'error', name, 0, total, (error as Error).message)
          throw error
        }
        rt.client.trackProgress((info) => {
          if (transfer.cancelled || info.type !== 'upload') return
          this.emitProgress(id, runtimeId, 'upload', 'running', name, info.bytes, total)
        })
        try {
          await rt.client.uploadFrom(localPath, target)
          if (transfer.cancelled) return
          this.emitProgress(id, runtimeId, 'upload', 'complete', name, total, total)
        } catch (error) {
          if (transfer.cancelled) return
          const message = friendlyError(error as Error)
          this.emitProgress(id, runtimeId, 'upload', 'error', name, 0, total, message)
          throw new Error(`FTP 上传失败：${message}`)
        } finally {
          rt.client.trackProgress()
        }
      }
    } finally {
      this.transfers.delete(id)
    }
  }

  async download(
    runtimeId: string,
    remotePaths: string[],
    localDir: string,
    transferId?: string
  ): Promise<void> {
    const rt = await this.ready(runtimeId)
    const id = transferId ?? `ftp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const transfer: Transfer = { runtimeId, direction: 'download', cancelled: false }
    this.transfers.set(id, transfer)
    try {
      for (const remotePath of remotePaths) {
        if (transfer.cancelled) return
        const target = safePath(remotePath)
        const name = posix.basename(target)
        const destination = join(localDir, name)
        let total = 0
        try {
          total = await rt.client.size(target)
        } catch {
          total = 0
        }
        rt.client.trackProgress((info) => {
          if (transfer.cancelled || info.type !== 'download') return
          this.emitProgress(id, runtimeId, 'download', 'running', name, info.bytes, total)
        })
        try {
          await rt.client.downloadTo(destination, target)
          if (transfer.cancelled) return
          this.emitProgress(id, runtimeId, 'download', 'complete', name, total, total)
        } catch (error) {
          if (transfer.cancelled) return
          const message = friendlyError(error as Error)
          this.emitProgress(id, runtimeId, 'download', 'error', name, 0, total, message)
          throw new Error(`FTP 下载失败：${message}`)
        } finally {
          rt.client.trackProgress()
        }
      }
    } finally {
      this.transfers.delete(id)
    }
  }

  cancel(transferId: string): void {
    const transfer = this.transfers.get(transferId)
    if (!transfer) return
    transfer.cancelled = true
    const rt = this.runtimes.get(transfer.runtimeId)
    // basic-ftp has no per-transfer abort; closing the control connection is
    // the supported way to stop the data socket. The next operation reconnects.
    try {
      rt?.client.close()
    } catch {
      /* ignore */
    }
    this.emit({
      type: 'sftp:progress',
      transferId,
      runtimeId: transfer.runtimeId,
      direction: transfer.direction,
      phase: 'cancelled',
      fileName: '',
      transferred: 0,
      total: 0
    })
  }

  /** Reconnect transparently after a cancelled transfer closed the client. */
  private async ready(runtimeId: string): Promise<Runtime> {
    const rt = this.runtimes.get(runtimeId)
    if (!rt) throw new Error('FTP 会话未连接')
    if (rt.client.closed) {
      try {
        await rt.client.access(rt.access)
      } catch (error) {
        throw new Error(`FTP 重新连接失败：${friendlyError(error as Error)}`)
      }
      if (this.runtimes.get(runtimeId) !== rt) throw new Error('FTP 会话已关闭')
      this.emit({ type: 'ssh:status', runtimeId, status: 'connected' })
    }
    return rt
  }

  private async command(client: Client, command: string): Promise<void> {
    try {
      await client.send(command)
    } catch (error) {
      throw new Error(`FTP 命令失败：${friendlyError(error as Error)}`)
    }
  }

  private emitProgress(
    transferId: string,
    runtimeId: string,
    direction: SftpProgressEvent['direction'],
    phase: SftpProgressEvent['phase'],
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
      message
    })
  }
}
