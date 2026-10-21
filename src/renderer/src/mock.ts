import type {
  AppEvent,
  FileEntry,
  Folder,
  HshellApi,
  KeyMetadata,
  Session,
  SshStatus,
  TunnelInfo,
  WindowLayout
} from '@shared/types'

const HOME = '/home/demo'
const USERNAME = 'demo'

function mkSession(
  id: string,
  name: string,
  folderId: string | null,
  host: string,
  username: string,
  color: string,
  method: Session['auth']['method']
): Session {
  const now = Date.now()
  return {
    id,
    name,
    folderId,
    host,
    port: 22,
    username,
    auth: method === 'key' ? { method, keyPath: '~/.ssh/id_ed25519' } : { method },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    color,
    createdAt: now,
    updatedAt: now
  }
}

const folders: Folder[] = [
  { id: 'f-local', name: '本地与测试', parentId: null, sortOrder: 0 },
  { id: 'f-prod', name: '生产环境（示例）', parentId: null, sortOrder: 1 }
]

const sessions: Session[] = [
  mkSession('s-local', 'localhost', 'f-local', '127.0.0.1', USERNAME, '#2a6fd6', 'key'),
  mkSession('s-demo-web', 'web-prod-01（示例）', 'f-prod', '10.0.0.11', 'root', '#d97706', 'agent'),
  mkSession('s-demo-db', 'db-prod-01（示例）', 'f-prod', '10.0.0.12', 'root', '#059669', 'password')
]

const mockKeys: KeyMetadata[] = [
  {
    id: 'key-demo',
    label: 'demo@hshell',
    algorithm: 'ed25519',
    bits: 256,
    fingerprint: 'SHA256:5J3m6Y0Rk8oQ2p4sV7wX1nB9cD3fG6hJ8kL0mN2pQ4=',
    publicKey:
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyFingerprintForPreviewOnly hshell@demo',
    hasPassphrase: false,
    createdAt: Date.now() - 86_400_000
  }
]

const mockTunnels = new Map<string, TunnelInfo>()
let mockLayout: WindowLayout = { tabs: [], activeIndex: 0 }

const listeners = new Set<(event: AppEvent) => void>()
function emit(event: AppEvent): void {
  listeners.forEach((listener) => listener(event))
}

const encoder = new TextEncoder()
function send(runtimeId: string, text: string): void {
  emit({ type: 'ssh:data', runtimeId, data: encoder.encode(text) })
}
function status(runtimeId: string, value: SshStatus, message?: string): void {
  emit({ type: 'ssh:status', runtimeId, status: value, message })
}

// --------------------------------------------------------------- file trees

function makeEntry(
  path: string,
  type: FileEntry['type'],
  size = 0,
  mtime = Date.now(),
  mode?: number
): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    name,
    path,
    type,
    size,
    mtime,
    mode: mode ?? (type === 'directory' ? 0o755 : 0o644)
  }
}

function buildRemoteTree(): Map<string, FileEntry> {
  const tree = new Map<string, FileEntry>()
  const add = (path: string, type: FileEntry['type'], size = 0): void => {
    tree.set(path, makeEntry(path, type, size))
  }
  add(`${HOME}`, 'directory')
  add(`${HOME}/Desktop`, 'directory')
  add(`${HOME}/projects`, 'directory')
  add(`${HOME}/projects/hshell`, 'directory')
  add(`${HOME}/projects/hshell/src`, 'directory')
  add(`${HOME}/projects/hshell/src/main.ts`, 'file', 5120)
  add(`${HOME}/projects/hshell/src/App.tsx`, 'file', 18432)
  add(`${HOME}/projects/hshell/package.json`, 'file', 1024)
  add(`${HOME}/projects/hshell/PLAN.md`, 'file', 12800)
  add(`${HOME}/projects/README.md`, 'file', 860)
  add(`${HOME}/notes.txt`, 'file', 1240)
  add(`${HOME}/.bashrc`, 'file', 3771)
  add(`${HOME}/backup.tar.gz`, 'file', 1048576)
  return tree
}

function buildLocalTree(): Map<string, FileEntry> {
  const tree = new Map<string, FileEntry>()
  const add = (path: string, type: FileEntry['type'], size = 0): void => {
    tree.set(path, makeEntry(path, type, size))
  }
  add(HOME, 'directory')
  add(`${HOME}/Desktop`, 'directory')
  add(`${HOME}/Documents`, 'directory')
  add(`${HOME}/Downloads`, 'directory')
  add(`${HOME}/Downloads/hshell-0.1.0.AppImage`, 'file', 96468992)
  add(`${HOME}/Downloads/notes.md`, 'file', 2100)
  add(`${HOME}/Documents/需求说明.md`, 'file', 6400)
  add(`${HOME}/Documents/会议记录.txt`, 'file', 1800)
  return tree
}

const remoteTree = buildRemoteTree()
const localTree = buildLocalTree()

function normalizePath(path: string, cwd = '/'): string {
  const base = path.startsWith('/') ? path : `${cwd.endsWith('/') ? cwd : cwd + '/'}${path}`
  const parts: string[] = []
  for (const segment of base.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `/${parts.join('/')}`
}

function dirname(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

function listTree(tree: Map<string, FileEntry>, path: string): FileEntry[] {
  const target = normalizePath(path)
  return [...tree.values()]
    .filter((entry) => dirname(entry.path) === target)
    .sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1
      if (b.type === 'directory' && a.type !== 'directory') return 1
      return a.name.localeCompare(b.name)
    })
}

function shortPath(path: string): string {
  if (path === HOME) return '~'
  if (path.startsWith(`${HOME}/`)) return `~${path.slice(HOME.length)}`
  return path
}

// --------------------------------------------------------------------- shell

interface MockRuntime {
  runtimeId: string
  session: Session
  cwd: string
  line: string
  escape: 0 | 1 | 2
  connected: boolean
  sftpCwd: string
  timer?: ReturnType<typeof setTimeout>
}

const runtimes = new Map<string, MockRuntime>()

function promptText(rt: MockRuntime): string {
  return `\x1b[1;32m${rt.session.username}@${rt.session.host}\x1b[0m:\x1b[1;34m${shortPath(
    rt.cwd
  )}\x1b[0m$ `
}

const BANNER = [
  '\x1b[1;36m╭──────────────────────────────────────────────╮\x1b[0m',
  '\x1b[1;36m│              HShell 演示终端                 │\x1b[0m',
  '\x1b[1;36m╰──────────────────────────────────────────────╯\x1b[0m',
  '',
  '当前为浏览器预览模式，连接的是 \x1b[1;33m模拟 Shell\x1b[0m。',
  '在 Electron 中运行时会连接真实 SSH 主机。',
  '输入 \x1b[1;33mhelp\x1b[0m 查看演示命令，或直接点击下方标签页体验。',
  ''
].join('\r\n')

function runCommand(rt: MockRuntime, input: string): void {
  const trimmed = input.trim()
  if (!trimmed) {
    send(rt.runtimeId, promptText(rt))
    return
  }
  const [command, ...args] = trimmed.split(/\s+/)
  const rest = trimmed.slice(command.length).trim()

  switch (command) {
    case 'help':
      send(
        rt.runtimeId,
        [
          '\x1b[1m可用命令\x1b[0m',
          '  help            显示本帮助',
          '  ls [-l]         列出当前目录',
          '  cd <dir>        切换目录（支持 ~、..、绝对路径）',
          '  pwd             显示当前目录',
          '  whoami          当前用户',
          '  hostname        主机名',
          '  uname -a        系统信息',
          '  date            当前时间',
          '  echo <text>     输出文本',
          '  clear           清屏',
          '  exit            断开模拟连接',
          '  ssh <host>      提示演示模式限制',
          ''
        ].join('\r\n')
      )
      break
    case 'ls': {
      const entries = listTree(remoteTree, rt.cwd)
      if (entries.length === 0) {
        send(rt.runtimeId, '\r\n')
        break
      }
      const long = args.includes('-l')
      const lines = entries.map((entry) => {
        if (long) {
          const size = entry.type === 'directory' ? '     -' : String(entry.size).padStart(6)
          return `${entry.type === 'directory' ? 'd' : '-'}rw-r--r--  ${USERNAME}  ${size}  ${
            entry.type === 'directory' ? `\x1b[1;34m${entry.name}/\x1b[0m` : entry.name
          }`
        }
        return entry.type === 'directory' ? `\x1b[1;34m${entry.name}/\x1b[0m` : entry.name
      })
      send(rt.runtimeId, lines.join(long ? '\r\n' : '   ') + '\r\n')
      break
    }
    case 'cd': {
      const raw = args[0] || '~'
      const expanded = raw === '~' ? HOME : raw.startsWith('~/') ? HOME + raw.slice(1) : raw
      const target = normalizePath(expanded, rt.cwd)
      const entry = remoteTree.get(target)
      if (!entry) send(rt.runtimeId, `cd: 目录不存在: ${args[0] || ''}\r\n`)
      else if (entry.type !== 'directory') send(rt.runtimeId, `cd: 不是目录: ${args[0]}\r\n`)
      else rt.cwd = target
      break
    }
    case 'pwd':
      send(rt.runtimeId, `${rt.cwd}\r\n`)
      break
    case 'whoami':
      send(rt.runtimeId, `${rt.session.username}\r\n`)
      break
    case 'hostname':
      send(rt.runtimeId, `${rt.session.host}\r\n`)
      break
    case 'uname':
      send(rt.runtimeId, 'Linux hshell-demo 6.8.0-hshell #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\r\n')
      break
    case 'date':
      send(rt.runtimeId, `${new Date().toString()}\r\n`)
      break
    case 'echo':
      send(rt.runtimeId, `${rest}\r\n`)
      break
    case 'clear':
      send(rt.runtimeId, '\x1b[2J\x1b[H')
      break
    case 'exit':
    case 'logout':
      send(rt.runtimeId, '\r\n\x1b[33m连接已关闭。\x1b[0m\r\n')
      rt.connected = false
      status(rt.runtimeId, 'closed', '演示会话已断开')
      return
    case 'ssh':
      send(
        rt.runtimeId,
        '\x1b[33m当前是浏览器演示模式，无法建立真实 SSH 连接。\r\n请用 `npm run dev` 启动 Electron 客户端。\x1b[0m\r\n'
      )
      break
    default:
      send(rt.runtimeId, `bash: ${command}: command not found\r\n`)
  }
  send(rt.runtimeId, promptText(rt))
}

function handleInput(rt: MockRuntime, data: string): void {
  if (!rt.connected) return
  let out = ''
  for (const char of data) {
    if (rt.escape === 1) {
      if (char === '[' || char === 'O') rt.escape = 2
      else rt.escape = 0
      continue
    }
    if (rt.escape === 2) {
      if (/[A-Za-z~]/.test(char)) rt.escape = 0
      continue
    }
    if (char === '\x1b') {
      rt.escape = 1
      continue
    }
    if (char === '\r' || char === '\n') {
      out += '\r\n'
      send(rt.runtimeId, out)
      out = ''
      runCommand(rt, rt.line)
      rt.line = ''
      continue
    }
    if (char === '\x7f' || char === '\b') {
      if (rt.line) {
        rt.line = rt.line.slice(0, -1)
        out += '\b \b'
      }
      continue
    }
    if (char === '\x03') {
      out += `^C\r\n${promptText(rt)}`
      rt.line = ''
      continue
    }
    if (char === '\x0c') {
      out += `\x1b[2J\x1b[H${promptText(rt)}`
      continue
    }
    if (char === '\t') {
      continue
    }
    if (char >= ' ') {
      rt.line += char
      out += char
    }
  }
  if (out) send(rt.runtimeId, out)
}

// ---------------------------------------------------------------------- API

export function createMockApi(): HshellApi {
  let clipboardFallback = ''

  return {
    app: {
      initialTheme:
        typeof localStorage !== 'undefined' &&
        localStorage.getItem('hshell.uiTheme') === 'dark'
          ? 'dark'
          : 'light',
      platform:
        typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
          ? 'darwin'
          : 'linux',
      setLocale: async () => undefined,
      setTheme: async () => undefined,
      info: async () => ({
        name: 'HShell',
        version: '0.1.0-demo',
        platform: 'web',
        userData: '',
        username: USERNAME
      })
    },
    window: {
      toggleFullScreen: async () => {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await document.documentElement.requestFullscreen().catch(() => undefined)
      }
    },
    serial: {
      // Browser preview cannot enumerate hardware; offer a sample entry so the
      // serial form can be exercised.
      list: async () => [
        { path: '/dev/ttyUSB0', manufacturer: 'Demo USB-Serial' },
        { path: 'COM3', manufacturer: 'Demo COM port' }
      ]
    },
    sessions: {
      list: async () => ({ folders: [...folders], sessions: [...sessions] }),
      save: async (session) => {
        const index = sessions.findIndex((item) => item.id === session.id)
        if (index >= 0) sessions[index] = session
        else sessions.push(session)
        return session
      },
      remove: async (id) => {
        const index = sessions.findIndex((item) => item.id === id)
        if (index >= 0) sessions.splice(index, 1)
      },
      saveFolder: async (folder) => {
        const index = folders.findIndex((item) => item.id === folder.id)
        if (index >= 0) folders[index] = folder
        else folders.push(folder)
        return folder
      },
      removeFolder: async (id) => {
        const index = folders.findIndex((item) => item.id === id)
        if (index >= 0) folders.splice(index, 1)
      },
      exportToFile: async () => ({
        canceled: true,
        folders: 0,
        sessions: 0
      }),
      importFromFile: async () => ({
        canceled: true,
        folders: 0,
        sessions: 0,
        skipped: 0
      }),
      importSshConfig: async () => ({
        canceled: true,
        imported: 0,
        skipped: 0
      })
    },
    vault: {
      status: async () => ({
        mode: 'password',
        available: false,
        initialized: true,
        unlocked: true
      }),
      unlock: async () => ({
        mode: 'password',
        available: false,
        initialized: true,
        unlocked: true
      }),
      lock: async () => ({
        mode: 'password',
        available: false,
        initialized: true,
        unlocked: true
      })
    },
    keys: {
      list: async () => [...mockKeys],
      generate: async (input) => {
        const key: KeyMetadata = {
          id: `key-${Date.now()}`,
          label: input.label,
          algorithm: input.algorithm,
          bits: input.algorithm === 'rsa' ? (input.bits ?? 3072) : input.algorithm === 'ecdsa' ? (input.bits ?? 256) : 256,
          fingerprint: `SHA256:demo${Date.now()}`,
          publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemo${Date.now()} ${input.label}`,
          hasPassphrase: Boolean(input.passphrase),
          createdAt: Date.now()
        }
        mockKeys.unshift(key)
        return key
      },
      import: async (input) => {
        const key: KeyMetadata = {
          id: `key-${Date.now()}`,
          label: input.label,
          algorithm: 'ed25519',
          bits: 256,
          fingerprint: `SHA256:imported${Date.now()}`,
          publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIImported${Date.now()} ${input.label}`,
          hasPassphrase: Boolean(input.passphrase),
          createdAt: Date.now()
        }
        mockKeys.unshift(key)
        return key
      },
      remove: async (id) => {
        const index = mockKeys.findIndex((key) => key.id === id)
        if (index >= 0) mockKeys.splice(index, 1)
      },
      publicKey: async (id) => {
        const key = mockKeys.find((item) => item.id === id)
        if (!key) throw new Error('密钥不存在')
        return key.publicKey
      },
      install: async () => {
        throw new Error('演示模式无法安装公钥')
      }
    },
    ssh: {
      connect: async (req) => {
        const existing = runtimes.get(req.runtimeId)
        if (existing?.timer) clearTimeout(existing.timer)
        const rt: MockRuntime = {
          runtimeId: req.runtimeId,
          session: req.session,
          cwd: HOME,
          line: '',
          escape: 0,
          connected: false,
          sftpCwd: HOME
        }
        runtimes.set(req.runtimeId, rt)
        status(req.runtimeId, 'connecting')
        rt.timer = setTimeout(() => {
          if (runtimes.get(req.runtimeId) !== rt) return
          rt.connected = true
          status(req.runtimeId, 'connected')
          send(req.runtimeId, `${BANNER}${promptText(rt)}`)
        }, 350)
      },
      disconnect: async (runtimeId) => {
        const rt = runtimes.get(runtimeId)
        if (rt?.timer) clearTimeout(rt.timer)
        rt && (rt.connected = false)
        status(runtimeId, 'closed')
      },
      write: async (runtimeId, data) => {
        const rt = runtimes.get(runtimeId)
        if (rt) handleInput(rt, data)
      },
      resize: async () => undefined,
      ack: async () => undefined,
      hostKeyDecision: async () => undefined,
      providePassword: async () => undefined,
      cancelPassword: async () => undefined,
      keyboardInteractive: async () => undefined
    },
    sftp: {
      home: async () => HOME,
      startDir: async () => {
        for (const name of ['Desktop', '桌面']) {
          const candidate = `${HOME}/${name}`
          if (remoteTree.get(candidate)?.type === 'directory') return candidate
        }
        return HOME
      },
      list: async (_runtimeId, path) => listTree(remoteTree, path),
      mkdir: async (_runtimeId, path) => {
        const target = normalizePath(path)
        if (remoteTree.has(target)) throw new Error('目录已存在')
        remoteTree.set(target, makeEntry(target, 'directory'))
      },
      remove: async (_runtimeId, path) => {
        const target = normalizePath(path)
        for (const key of [...remoteTree.keys()]) {
          if (key === target || key.startsWith(`${target}/`)) remoteTree.delete(key)
        }
      },
      rename: async (_runtimeId, from, to) => {
        const source = normalizePath(from)
        const target = normalizePath(to)
        const entry = remoteTree.get(source)
        if (!entry) throw new Error('文件不存在')
        for (const [key, value] of [...remoteTree.entries()]) {
          if (key === source || key.startsWith(`${source}/`)) {
            const moved = target + key.slice(source.length)
            remoteTree.delete(key)
            remoteTree.set(moved, { ...value, path: moved, name: moved.slice(moved.lastIndexOf('/') + 1) })
          }
        }
      },
      chmod: async (_runtimeId, path, mode) => {
        const entry = remoteTree.get(normalizePath(path))
        if (!entry) throw new Error('文件不存在')
        entry.mode = mode
      },
      upload: async () => {
        throw new Error('演示模式不支持上传')
      },
      download: async () => {
        throw new Error('演示模式不支持下载')
      },
      cancel: async () => undefined
    },
    tunnels: {
      start: async (config) => {
        const info: TunnelInfo = { ...config, phase: 'active' }
        mockTunnels.set(config.id, info)
        emit({ type: 'tunnel:status', ...info })
        return info
      },
      stop: async (id) => {
        const info = mockTunnels.get(id)
        if (!info) return
        mockTunnels.delete(id)
        emit({ type: 'tunnel:status', ...info, phase: 'stopped', message: '已停止' })
      },
      list: async (runtimeId) =>
        [...mockTunnels.values()].filter((info) => info.runtimeId === runtimeId)
    },
    recording: {
      saveScript: async (content, defaultName) => {
        const name = defaultName ?? 'hshell-recording.mjs'
        const url = URL.createObjectURL(new Blob([content], { type: 'text/javascript' }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = name
        anchor.click()
        URL.revokeObjectURL(url)
        return { canceled: false, filePath: name }
      }
    },
    layouts: {
      get: async () => mockLayout,
      save: async (layout: WindowLayout) => {
        mockLayout = layout
      }
    },
    fs: {
      home: async () => HOME,
      startDir: async () =>
        localTree.get(`${HOME}/Desktop`)?.type === 'directory' ? `${HOME}/Desktop` : HOME,
      list: async (path) => listTree(localTree, path),
      mkdir: async (path) => {
        const target = normalizePath(path)
        localTree.set(target, makeEntry(target, 'directory'))
      },
      remove: async (path) => {
        const target = normalizePath(path)
        for (const key of [...localTree.keys()]) {
          if (key === target || key.startsWith(`${target}/`)) localTree.delete(key)
        }
      },
      rename: async (from, to) => {
        const source = normalizePath(from)
        const target = normalizePath(to)
        const entry = localTree.get(source)
        if (!entry) throw new Error('文件不存在')
        for (const [key, value] of [...localTree.entries()]) {
          if (key === source || key.startsWith(`${source}/`)) {
            const moved = target + key.slice(source.length)
            localTree.delete(key)
            localTree.set(moved, { ...value, path: moved, name: moved.slice(moved.lastIndexOf('/') + 1) })
          }
        }
      },
      pickFile: async () => null,
      pickDirectory: async () => null
    },
    clipboard: {
      readText: async () => {
        try {
          return await navigator.clipboard.readText()
        } catch {
          return clipboardFallback
        }
      },
      writeText: async (text) => {
        clipboardFallback = text
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          /* ignore */
        }
      }
    },
    events: {
      on(callback) {
        listeners.add(callback)
        return () => listeners.delete(callback)
      }
    }
  }
}
