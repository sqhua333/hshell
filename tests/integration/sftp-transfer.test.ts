import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import { Server, utils, type SFTPWrapper } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppEvent, Session, SftpProgressEvent } from '@shared/types'
import { KnownHosts } from '../../src/main/ssh/known-hosts'
import { SshManager } from '../../src/main/ssh/manager'

const OK = 0
const EOF = 1
const NO_SUCH_FILE = 2
const FAILURE = 4

interface FakeNode {
  type: 'file' | 'directory'
  data: Buffer
  mode: number
  mtime: number
}

function sha(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Minimal in-memory SFTP server covering the operations used by transfers. */
function installFakeSftp(
  sftp: SFTPWrapper,
  files: Map<string, FakeNode>,
  delayMs: number
): void {
  const handles = new Map<string, { path: string; readdirDone?: boolean }>()
  const norm = (path: string): string => posix.normalize(path)

  const attrsOf = (node: FakeNode): {
    mode: number
    uid: number
    gid: number
    size: number
    atime: number
    mtime: number
  } => ({
    // Include the POSIX file-type bits so the client's Stats helpers work.
    mode: node.mode | (node.type === 'directory' ? 0o040000 : 0o100000),
    uid: 0,
    gid: 0,
    size: node.type === 'file' ? node.data.length : 0,
    atime: Math.floor(node.mtime / 1000),
    mtime: Math.floor(node.mtime / 1000)
  })

  const later = (task: () => void): void => {
    if (delayMs > 0) setTimeout(task, delayMs)
    else task()
  }

  const newHandle = (entry: { path: string }): Buffer => {
    const handle = Buffer.from(randomUUID().replace(/-/g, ''), 'hex')
    handles.set(handle.toString('hex'), entry)
    return handle
  }

  sftp.on('OPEN', (reqId, filename, flags) => {
    const path = norm(filename)
    const node = files.get(path)
    const wantRead = (flags & 0x01) !== 0
    if (wantRead) {
      if (!node || node.type !== 'file') {
        sftp.status(reqId, NO_SUCH_FILE)
        return
      }
      sftp.handle(reqId, newHandle({ path }))
      return
    }
    if ((flags & 0x20) !== 0 && node) {
      sftp.status(reqId, FAILURE)
      return
    }
    if (!files.has(posix.dirname(path))) {
      sftp.status(reqId, NO_SUCH_FILE)
      return
    }
    files.set(path, { type: 'file', data: Buffer.alloc(0), mode: 0o600, mtime: Date.now() })
    sftp.handle(reqId, newHandle({ path }))
  })

  sftp.on('WRITE', (reqId, handle, offset, data) => {
    const entry = handles.get(handle.toString('hex'))
    if (!entry) {
      sftp.status(reqId, FAILURE)
      return
    }
    later(() => {
      const node = files.get(entry.path)
      if (!node || node.type !== 'file') {
        sftp.status(reqId, NO_SUCH_FILE)
        return
      }
      const required = offset + data.length
      if (required > node.data.length) {
        // Grow geometrically: copying the whole file on every 32KB write is
        // O(n²) and makes the 100MB soak test take minutes.
        const capacity = node.data.buffer.byteLength
        if (required > capacity) {
          const grown = Buffer.alloc(Math.max(capacity * 2, required, 1024 * 1024))
          node.data.copy(grown)
          node.data = grown.subarray(0, required)
        } else {
          node.data = Buffer.from(node.data.buffer, node.data.byteOffset, required)
        }
      }
      data.copy(node.data, offset)
      sftp.status(reqId, OK)
    })
  })

  sftp.on('READ', (reqId, handle, offset, length) => {
    const entry = handles.get(handle.toString('hex'))
    if (!entry) {
      sftp.status(reqId, FAILURE)
      return
    }
    later(() => {
      const node = files.get(entry.path)
      if (!node || node.type !== 'file') {
        sftp.status(reqId, NO_SUCH_FILE)
        return
      }
      if (offset >= node.data.length) {
        sftp.status(reqId, EOF)
        return
      }
      sftp.data(reqId, node.data.subarray(offset, offset + length))
    })
  })

  sftp.on('FSTAT', (reqId, handle) => {
    const entry = handles.get(handle.toString('hex'))
    const node = entry ? files.get(entry.path) : undefined
    if (!node) {
      sftp.status(reqId, NO_SUCH_FILE)
      return
    }
    sftp.attrs(reqId, attrsOf(node))
  })

  sftp.on('STAT', (reqId, path) => {
    const node = files.get(norm(path))
    if (!node) sftp.status(reqId, NO_SUCH_FILE)
    else sftp.attrs(reqId, attrsOf(node))
  })

  sftp.on('LSTAT', (reqId, path) => {
    const node = files.get(norm(path))
    if (!node) sftp.status(reqId, NO_SUCH_FILE)
    else sftp.attrs(reqId, attrsOf(node))
  })

  sftp.on('CLOSE', (reqId, handle) => {
    handles.delete(handle.toString('hex'))
    sftp.status(reqId, OK)
  })

  sftp.on('OPENDIR', (reqId, path) => {
    const node = files.get(norm(path))
    if (!node || node.type !== 'directory') {
      sftp.status(reqId, NO_SUCH_FILE)
      return
    }
    sftp.handle(reqId, newHandle({ path: norm(path) }))
  })

  sftp.on('READDIR', (reqId, handle) => {
    const entry = handles.get(handle.toString('hex'))
    if (!entry) {
      sftp.status(reqId, FAILURE)
      return
    }
    if (entry.readdirDone) {
      sftp.status(reqId, EOF)
      return
    }
    entry.readdirDone = true
    const base = entry.path === '/' ? '/' : `${entry.path}/`
    const names = [...files.keys()]
      .filter((path) => {
        if (path === entry.path || !path.startsWith(base)) return false
        return !path.slice(base.length).includes('/')
      })
      .map((path) => {
        const node = files.get(path)!
        return {
          filename: basename(path),
          longname: basename(path),
          attrs: attrsOf(node)
        }
      })
    sftp.name(reqId, names)
  })

  sftp.on('REMOVE', (reqId, path) => {
    const target = norm(path)
    const node = files.get(target)
    if (!node || node.type !== 'file') sftp.status(reqId, NO_SUCH_FILE)
    else {
      files.delete(target)
      sftp.status(reqId, OK)
    }
  })

  sftp.on('MKDIR', (reqId, path) => {
    const target = norm(path)
    if (files.has(target) || !files.has(posix.dirname(target))) {
      sftp.status(reqId, FAILURE)
      return
    }
    files.set(target, { type: 'directory', data: Buffer.alloc(0), mode: 0o755, mtime: Date.now() })
    sftp.status(reqId, OK)
  })

  sftp.on('RMDIR', (reqId, path) => {
    const target = norm(path)
    if (!files.has(target)) sftp.status(reqId, NO_SUCH_FILE)
    else {
      files.delete(target)
      sftp.status(reqId, OK)
    }
  })

  sftp.on('RENAME', (reqId, from, to) => {
    const source = norm(from)
    const target = norm(to)
    if (!files.has(source)) {
      sftp.status(reqId, NO_SUCH_FILE)
      return
    }
    for (const [path, node] of [...files.entries()]) {
      if (path !== source && !path.startsWith(`${source}/`)) continue
      files.delete(path)
      files.set(target + path.slice(source.length), node)
    }
    sftp.status(reqId, OK)
  })

  sftp.on('SETSTAT', (reqId, path, attrs) => {
    const node = files.get(norm(path))
    if (!node) {
      sftp.status(reqId, NO_SUCH_FILE)
      return
    }
    if (attrs.mode) node.mode = attrs.mode & 0o7777
    sftp.status(reqId, OK)
  })

  sftp.on('FSETSTAT', (reqId, handle, attrs) => {
    const entry = handles.get(handle.toString('hex'))
    const node = entry ? files.get(entry.path) : undefined
    if (!node) {
      sftp.status(reqId, NO_SUCH_FILE)
      return
    }
    if (attrs.mode) node.mode = attrs.mode & 0o7777
    sftp.status(reqId, OK)
  })
}

async function startServer(delayMs = 0): Promise<{
  port: number
  files: Map<string, FakeNode>
  close: () => Promise<void>
}> {
  const files = new Map<string, FakeNode>()
  const now = Date.now()
  files.set('/', { type: 'directory', data: Buffer.alloc(0), mode: 0o755, mtime: now })
  files.set('/home', { type: 'directory', data: Buffer.alloc(0), mode: 0o755, mtime: now })
  files.set('/home/tester', {
    type: 'directory',
    data: Buffer.alloc(0),
    mode: 0o755,
    mtime: now
  })

  const { private: hostKey } = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const connections = new Set<import('ssh2').Connection>()
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', (ctx) => ctx.accept())
    connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('shell', (acceptShell) => {
        acceptShell()?.write('ready\r\n')
      })
      session.on('sftp', (acceptSftp) => {
        const sftp = acceptSftp()
        installFakeSftp(sftp, files, delayMs)
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  return {
    port: (server.address() as AddressInfo).port,
    files,
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections) connection.end()
        server.close(() => resolve())
      })
  }
}

const SESSION: Session = {
  id: 's-sftp',
  name: 'sftp-test',
  folderId: null,
  host: '127.0.0.1',
  port: 22,
  username: 'tester',
  auth: { method: 'password', password: 'anything' },
  terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
  createdAt: 0,
  updatedAt: 0
}

const RUNTIME = 'rt-sftp'

function setup(port: number): {
  manager: SshManager
  events: AppEvent[]
  progress: SftpProgressEvent[]
  statuses: string[]
  connect: () => Promise<void>
} {
  const events: AppEvent[] = []
  const progress: SftpProgressEvent[] = []
  const statuses: string[] = []
  const manager = new SshManager(
    new KnownHosts(mkdtempSync(join(tmpdir(), 'hshell-sftp-'))),
    (event) => {
      events.push(event)
      if (event.type === 'sftp:progress') progress.push(event)
      if (event.type === 'ssh:status') statuses.push(event.status)
      if (event.type === 'ssh:hostkey') manager.hostKeyDecision(event.prompt.requestId, true)
    }
  )
  return {
    manager,
    events,
    progress,
    statuses,
    connect: () =>
      manager.connect({
        runtimeId: RUNTIME,
        session: { ...SESSION, port },
        cols: 80,
        rows: 24
      })
  }
}

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hshell-transfer-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SFTP transfers', () => {
  it('uploads atomically and downloads with matching checksums', async () => {
    const server = await startServer()
    const { manager, progress, statuses, connect } = setup(server.port)
    const sourceDir = tempDir()
    const downloadDir = tempDir()
    const content = randomBytes(300 * 1024)
    const sourcePath = join(sourceDir, 'payload.bin')
    writeFileSync(sourcePath, content)

    try {
      await connect()
      await waitFor(() => statuses.includes('connected'))

      await manager.upload(RUNTIME, [sourcePath], '/home/tester', 'up-roundtrip')
      const uploaded = server.files.get('/home/tester/payload.bin')
      expect(uploaded?.type).toBe('file')
      expect(sha(uploaded!.data)).toBe(sha(content))
      expect(
        [...server.files.keys()].some((path) => path.includes('.hshell-upload-'))
      ).toBe(false)

      const remoteData = randomBytes(180 * 1024)
      server.files.set('/home/tester/remote.bin', {
        type: 'file',
        data: remoteData,
        mode: 0o644,
        mtime: Date.now()
      })
      await manager.download(RUNTIME, ['/home/tester/remote.bin'], downloadDir, 'down-roundtrip')
      const downloadedPath = join(downloadDir, 'remote.bin')
      expect(existsSync(downloadedPath)).toBe(true)
      expect(sha(readFileSync(downloadedPath))).toBe(sha(remoteData))
      expect(readdirSync(downloadDir).some((name) => name.startsWith('.hshell-download-'))).toBe(
        false
      )

      await manager.sftpChmod(RUNTIME, '/home/tester/payload.bin', 0o640)
      expect(server.files.get('/home/tester/payload.bin')?.mode).toBe(0o640)

      const phases = progress.map((event) => event.phase)
      expect(phases).toContain('running')
      expect(phases).toContain('complete')
      expect(progress.some((event) => event.transferred > 0)).toBe(true)
    } finally {
      manager.disconnect(RUNTIME)
      await server.close()
    }
  }, 30_000)

  // Set HSHELL_SOAK_FULL=1 to run the 100MB round-trip.
  it.skipIf(process.env.HSHELL_SOAK_FULL !== '1')(
    'moves 100MB up and down with matching checksums',
    async () => {
      const server = await startServer()
      const { manager, statuses, connect } = setup(server.port)
      const sourceDir = tempDir()
      const downloadDir = tempDir()
      const size = 100 * 1024 * 1024
      let content: Buffer | null = randomBytes(size)
      const digest = sha(content)
      const sourcePath = join(sourceDir, 'big.bin')
      writeFileSync(sourcePath, content)
      const rssBefore = process.memoryUsage().rss

      try {
        await connect()
        await waitFor(() => statuses.includes('connected'))

        await manager.upload(RUNTIME, [sourcePath], '/home/tester', 'soak-up')
        const uploaded = server.files.get('/home/tester/big.bin')
        expect(uploaded?.type).toBe('file')
        expect(uploaded!.data.length).toBe(size)
        expect(sha(uploaded!.data)).toBe(digest)
        expect([...server.files.keys()].some((path) => path.includes('.hshell-upload-'))).toBe(
          false
        )
        content = null

        await manager.download(
          RUNTIME,
          ['/home/tester/big.bin'],
          downloadDir,
          'soak-down'
        )
        const downloaded = readFileSync(join(downloadDir, 'big.bin'))
        expect(downloaded.length).toBe(size)
        expect(sha(downloaded)).toBe(digest)
        expect(readdirSync(downloadDir).some((name) => name.startsWith('.hshell-download-'))).toBe(
          false
        )

        // The transfer pipeline streams in chunks; a full copy of both files in
        // extra heap would push growth well past this bound.
        const growth = process.memoryUsage().rss - rssBefore
        expect(growth).toBeLessThan(400 * 1024 * 1024)
      } finally {
        manager.disconnect(RUNTIME)
        await server.close()
      }
    },
    600_000
  )

  it('cancels an upload and removes the temporary file', async () => {
    const server = await startServer(40)
    const { manager, progress, statuses, connect } = setup(server.port)
    const sourceDir = tempDir()
    const content = randomBytes(2 * 1024 * 1024)
    const sourcePath = join(sourceDir, 'large.bin')
    writeFileSync(sourcePath, content)

    try {
      await connect()
      await waitFor(() => statuses.includes('connected'))

      const upload = manager.upload(RUNTIME, [sourcePath], '/home/tester', 'up-cancel')
      await waitFor(() =>
        progress.some(
          (event) =>
            event.transferId === 'up-cancel' &&
            event.phase === 'running' &&
            event.transferred > 0
        )
      )
      manager.cancelTransfer('up-cancel')
      await expect(upload).rejects.toThrow('传输已取消')

      await waitFor(
        () => ![...server.files.keys()].some((path) => path.includes('.hshell-upload-'))
      )
      expect(server.files.has('/home/tester/large.bin')).toBe(false)
      expect(progress.some((event) => event.phase === 'cancelled')).toBe(true)
    } finally {
      manager.disconnect(RUNTIME)
      await server.close()
    }
  }, 30_000)

  it('cancels a download and removes the local temporary file', async () => {
    const server = await startServer(30)
    const { manager, progress, statuses, connect } = setup(server.port)
    const downloadDir = tempDir()
    const data = randomBytes(2 * 1024 * 1024)
    server.files.set('/home/tester/big.bin', {
      type: 'file',
      data,
      mode: 0o644,
      mtime: Date.now()
    })

    try {
      await connect()
      await waitFor(() => statuses.includes('connected'))

      const download = manager.download(RUNTIME, ['/home/tester/big.bin'], downloadDir, 'down-cancel')
      await waitFor(() =>
        progress.some(
          (event) =>
            event.transferId === 'down-cancel' &&
            event.phase === 'running' &&
            event.transferred > 0
        )
      )
      manager.cancelTransfer('down-cancel')
      await expect(download).rejects.toThrow('传输已取消')

      await waitFor(
        () => !readdirSync(downloadDir).some((name) => name.startsWith('.hshell-download-'))
      )
      expect(existsSync(join(downloadDir, 'big.bin'))).toBe(false)
      expect(progress.some((event) => event.phase === 'cancelled')).toBe(true)
    } finally {
      manager.disconnect(RUNTIME)
      await server.close()
    }
  }, 30_000)
})
