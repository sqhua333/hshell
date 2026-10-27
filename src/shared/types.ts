export type AuthMethod = 'password' | 'key' | 'agent' | 'keyboard-interactive'

export type Language = 'zh' | 'en'

export type TerminalTheme = 'dark' | 'light' | 'solarized'

export interface AuthConfig {
  method: AuthMethod
  keyPath?: string
  /** Private key stored in the encrypted vault (never a filesystem path). */
  keyId?: string
  /** Kept in renderer memory only; the main process strips it before persisting. */
  password?: string
  /** Persist the password encrypted so later connections reuse it automatically. */
  savePassword?: boolean
}

/** One hop in a jump-host chain, with credentials that may differ per hop. */
export interface JumpHostConfig {
  id: string
  host: string
  port: number
  /** Empty string falls back to the session username. */
  username: string
  /** Omitted means "same authentication as the session". */
  auth?: AuthConfig
}

export interface TerminalOptions {
  term: string
  theme: TerminalTheme
  fontSize: number
  /** Built-in color scheme id; falls back to `theme` for older sessions. */
  colorScheme?: string
  /** Show a local `HH:mm:ss` gutter next to each output line. */
  showTimestamps?: boolean
}

/** Command button shown in the per-session bar at the bottom of the terminal. */
export interface QuickCommand {
  id: string
  label: string
  command: string
  /** Append a carriage return after sending. Defaults to true. */
  sendEnter?: boolean
}

export type TriggerAction = 'send' | 'notify'

/** Runs an action when terminal output matches a pattern. */
export interface TriggerRule {
  id: string
  pattern: string
  regex?: boolean
  caseSensitive?: boolean
  action: TriggerAction
  payload: string
  enabled?: boolean
}

/** Highlights lines whose visible text matches a pattern. */
export interface HighlightRule {
  id: string
  pattern: string
  regex?: boolean
  caseSensitive?: boolean
  foreground?: string
  background?: string
  enabled?: boolean
}

export type LogFormat = 'text' | 'asciinema'

export interface LoggingOptions {
  enabled: boolean
  format: LogFormat
  /**
   * Absolute directory for this session's logs. Empty/undefined keeps the
   * default `<userData>/logs`.
   */
  directory?: string
  /** Prefix each text-log line with a local `[YYYY-MM-DD HH:mm:ss]` stamp. */
  timestamps?: boolean
}

/**
 * `local` runs the current system's default shell in an embedded PTY.
 * `telnet` is a raw TCP terminal with telnet option negotiation; `ftp` is a
 * file-transfer-only session (no terminal).
 */
export type ConnectionType = 'ssh' | 'serial' | 'local' | 'telnet' | 'ftp'

export interface TelnetOptions {
  /** Send the configured username/password when the host prompts for them. */
  autoLogin?: boolean
  /** Terminal type reported through TTYPE. Defaults to the session `term`. */
  terminalType?: string
}

export interface FtpOptions {
  /** Explicit FTPS: upgrade the control connection with AUTH TLS. */
  secure?: boolean
}

export type SerialParity = 'none' | 'even' | 'odd' | 'mark' | 'space'
export type SerialFlowControl = 'none' | 'rtscts' | 'xonxoff'
export type SerialDataBits = 5 | 6 | 7 | 8
export type SerialStopBits = 1 | 1.5 | 2

export interface SerialOptions {
  /** Device path, e.g. `/dev/ttyUSB0`, `/dev/cu.usbserial-1`, `COM3`. */
  path: string
  baudRate: number
  dataBits: SerialDataBits
  stopBits: SerialStopBits
  parity: SerialParity
  flowControl: SerialFlowControl
  /** Initial modem control line states. */
  dtr?: boolean
  rts?: boolean
}

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
  locationId?: string
  vendorId?: string
  productId?: string
}

export interface Session {
  id: string
  name: string
  folderId: string | null
  host: string
  port: number
  username: string
  auth: AuthConfig
  terminal: TerminalOptions
  /** Defaults to SSH for sessions created before serial support. */
  connectionType?: ConnectionType
  /** Present when `connectionType` is `serial`. */
  serial?: SerialOptions
  /** Present when `connectionType` is `telnet`. */
  telnet?: TelnetOptions
  /** Present when `connectionType` is `ftp`. */
  ftp?: FtpOptions
  /** ProxyJump target, e.g. `bastion` or `user@bastion:2222`. */
  proxyJump?: string | null
  /**
   * Structured jump chain with per-hop credentials. Takes precedence over
   * `proxyJump`; the string is kept in sync for older versions and exports.
   */
  jumpHosts?: JumpHostConfig[]
  /** Command buttons in the session's bottom bar. */
  quickCommands?: QuickCommand[]
  /** Output-triggered actions. */
  triggers?: TriggerRule[]
  /** Line highlight rules applied to terminal output. */
  highlights?: HighlightRule[]
  /** Save terminal output to a file in `<userData>/logs`. */
  logging?: LoggingOptions
  color?: string
  createdAt: number
  updatedAt: number
}

export interface Folder {
  id: string
  name: string
  parentId: string | null
  sortOrder: number
}

export interface SessionData {
  folders: Folder[]
  sessions: Session[]
}

export type SshStatus =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed'

export interface RuntimeStatus {
  status: SshStatus
  message?: string
  cols?: number
  rows?: number
}

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtime: number
  mode: number
}

/** Inline terminal prompt asking for a password after authentication failed. */
export interface PasswordPrompt {
  requestId: string
  host: string
  username: string
  /** 1 for the first prompt; later values mean the previous password failed. */
  attempt: number
}

export interface HostKeyPrompt {
  requestId: string
  host: string
  port: number
  algorithm: string
  fingerprint: string
  changed: boolean
  oldFingerprint?: string
}

export interface KeyboardPrompt {
  requestId: string
  name: string
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
}

export type ZmodemPhase =
  | 'detected'
  | 'receiving'
  | 'sending'
  | 'file-complete'
  | 'complete'
  | 'cancelled'
  | 'error'

export interface ZmodemStatusEvent {
  runtimeId: string
  phase: ZmodemPhase
  direction?: 'download' | 'upload'
  fileName?: string
  transferred?: number
  total?: number
  message?: string
}

export type TunnelType = 'local' | 'remote' | 'dynamic'

export type TunnelPhase = 'starting' | 'active' | 'stopped' | 'error'

export interface TunnelConfig {
  id: string
  runtimeId: string
  tunnelType: TunnelType
  /** Address listened on (local -L / dynamic -D) or requested remotely (-R). */
  bindHost: string
  bindPort: number
  /** Destination for -L / -R; unused for -D. */
  targetHost?: string
  targetPort?: number
}

export interface TunnelInfo extends TunnelConfig {
  phase: TunnelPhase
  message?: string
}

export type SplitDirection = 'horizontal' | 'vertical'

export interface LayoutPane {
  sessionId: string
}

/**
 * Persisted split tree. A split's `sizes` are percentages aligned with its
 * children; nested splits allow mixed directions (e.g. vertical, then
 * horizontal inside one of the panes).
 */
export type StoredLayoutNode =
  | { type: 'pane'; sessionId: string }
  | {
      type: 'split'
      direction: SplitDirection
      sizes?: number[]
      children: StoredLayoutNode[]
    }

export interface LayoutTab {
  layout: StoredLayoutNode
}

/** Layout written by HShell before nested splits: a flat, single-direction row. */
export interface LegacyLayoutTab {
  panes: LayoutPane[]
  direction: SplitDirection
  /** Percentages aligned with `panes`. */
  sizes?: number[]
}

export interface WindowLayout {
  tabs: Array<LayoutTab | LegacyLayoutTab>
  activeIndex: number
}

export type SftpTransferPhase = 'running' | 'complete' | 'cancelled' | 'error'

export interface SftpProgressEvent {
  transferId: string
  runtimeId: string
  direction: 'upload' | 'download'
  phase: SftpTransferPhase
  fileName: string
  transferred: number
  total: number
  message?: string
}

export type AppEvent =
  | { type: 'ssh:data'; runtimeId: string; data: Uint8Array }
  | { type: 'ssh:status'; runtimeId: string; status: SshStatus; message?: string }
  | { type: 'ssh:exit'; runtimeId: string; code?: number; signal?: string }
  | { type: 'ssh:hostkey'; runtimeId: string; prompt: HostKeyPrompt }
  | { type: 'ssh:password-request'; runtimeId: string; prompt: PasswordPrompt }
  | { type: 'ssh:keyboard-interactive'; runtimeId: string; prompt: KeyboardPrompt }
  | { type: 'ssh:notice'; runtimeId?: string; level: 'info' | 'warn' | 'error'; message: string }
  /** Persisted session metadata changed in the main process (e.g. saved password). */
  | { type: 'sessions:changed' }
  | ({ type: 'zmodem:status' } & ZmodemStatusEvent)
  | ({ type: 'sftp:progress' } & SftpProgressEvent)
  | ({ type: 'tunnel:status' } & TunnelInfo)
  | { type: 'menu:action'; action: string }

export interface ConnectRequest {
  runtimeId: string
  session: Session
  cols: number
  rows: number
}

/**
 * One reading of the remote host's resource usage, sampled from `/proc` and
 * `df`. Sizes are bytes; network values are bytes per second.
 */
export interface RemoteMonitorSample {
  /** Percent of all cores, 0–100. The first sample reports 0 until a delta exists. */
  cpu: number
  cores: number
  /** 1-minute load average. */
  load: number
  memTotal: number
  memUsed: number
  swapTotal: number
  swapUsed: number
  diskTotal: number
  diskUsed: number
  netDown: number
  netUp: number
  /** Seconds since boot. */
  uptime: number
  /** Epoch milliseconds of the boot time, using the remote host's clock. */
  bootTime: number
  /** Epoch milliseconds when the sample was taken (remote clock). */
  timestamp: number
}

export type KeyAlgorithm = 'rsa' | 'ecdsa' | 'ed25519'

export interface KeyMetadata {
  id: string
  label: string
  algorithm: KeyAlgorithm
  bits: number
  comment?: string
  fingerprint: string
  /** OpenSSH one-line public key, safe to display and copy. */
  publicKey: string
  hasPassphrase: boolean
  createdAt: number
}

export interface VaultStatus {
  mode: 'safeStorage' | 'password'
  available: boolean
  initialized: boolean
  unlocked: boolean
}

export interface GenerateKeyInput {
  label: string
  algorithm: KeyAlgorithm
  bits?: number
  passphrase?: string
}

export interface ImportKeyInput {
  label: string
  privateKey: string
  passphrase?: string
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  userData: string
  username: string
}

export interface SessionExportResult {
  canceled: boolean
  filePath?: string
  folders: number
  sessions: number
  keys?: number
}

export interface RecordingSaveResult {
  canceled: boolean
  filePath?: string
}

/** Loopback MCP endpoint exposed for AI clients (read-only). */
export interface AiMcpInfo {
  /** e.g. `http://127.0.0.1:41337/mcp` */
  url: string
  /** Bearer token the client must send. */
  token: string
}

/** A session the user marked as readable by AI clients. */
export interface AiSessionSummary {
  runtimeId: string
  sessionId: string
  name: string
  target: string
  connectionType: ConnectionType
  status: SshStatus
  startedAt: number
  lastActivityAt: number
  bufferedBytes: number
  firstSeq: number
  latestSeq: number
}

export interface SessionImportResult {
  canceled: boolean
  filePath?: string
  folders: number
  sessions: number
  skipped: number
  keys?: number
}

export interface SshConfigImportResult {
  canceled: boolean
  filePath?: string
  imported: number
  skipped: number
  warnings?: string[]
}

export interface HshellApi {
  app: {
    /**
     * Saved theme from the main process (`null` when the user never chose
     * one). Read synchronously by the pre-paint bootstrap so the first frame
     * matches the saved theme.
     */
    readonly initialTheme: 'light' | 'dark' | null
    /** `process.platform`; used to choose terminal clipboard shortcuts. */
    readonly platform: string
    info(): Promise<AppInfo>
    setLocale(locale: Language): Promise<void>
    /** Mirror the UI theme so the next window opens without a color flash. */
    setTheme(theme: 'light' | 'dark'): Promise<void>
  }
  window: {
    toggleFullScreen(): Promise<void>
  }
  sessions: {
    list(): Promise<SessionData>
    save(session: Session): Promise<Session>
    remove(id: string): Promise<void>
    saveFolder(folder: Folder): Promise<Folder>
    removeFolder(id: string): Promise<void>
    exportToFile(options?: { includeKeys?: boolean; password?: string }): Promise<SessionExportResult>
    importFromFile(options?: { password?: string }): Promise<SessionImportResult>
    importSshConfig(): Promise<SshConfigImportResult>
  }
  vault: {
    status(): Promise<VaultStatus>
    unlock(password: string): Promise<VaultStatus>
    lock(): Promise<VaultStatus>
  }
  keys: {
    list(): Promise<KeyMetadata[]>
    generate(input: GenerateKeyInput): Promise<KeyMetadata>
    import(input: ImportKeyInput): Promise<KeyMetadata>
    remove(id: string): Promise<void>
    publicKey(id: string): Promise<string>
    install(runtimeId: string, keyId: string): Promise<void>
  }
  layouts: {
    get(): Promise<WindowLayout>
    save(layout: WindowLayout): Promise<void>
  }
  serial: {
    list(): Promise<SerialPortInfo[]>
  }
  ftp: {
    home(runtimeId: string): Promise<string>
    startDir(runtimeId: string): Promise<string>
    list(runtimeId: string, path: string): Promise<FileEntry[]>
    mkdir(runtimeId: string, path: string): Promise<void>
    remove(runtimeId: string, path: string, isDir: boolean): Promise<void>
    rename(runtimeId: string, from: string, to: string): Promise<void>
    chmod(runtimeId: string, path: string, mode: number): Promise<void>
    upload(
      runtimeId: string,
      localPaths: string[],
      remoteDir: string,
      transferId?: string
    ): Promise<void>
    download(
      runtimeId: string,
      remotePaths: string[],
      localDir: string,
      transferId?: string
    ): Promise<void>
    cancel(transferId: string): Promise<void>
  }
  recording: {
    /** Show a save dialog and write the generated replay script (mode 0600). */
    saveScript(content: string, defaultName?: string): Promise<RecordingSaveResult>
  }
  ai: {
    /** MCP endpoint details, or null when the server could not start. */
    info(): Promise<AiMcpInfo | null>
    /** Runtime ids the user marked as readable by AI clients. */
    watched(): Promise<string[]>
    /** Names and buffer ranges for watched sessions (dialog display). */
    sessions(): Promise<AiSessionSummary[]>
    setWatch(runtimeId: string, watched: boolean): Promise<void>
  }
  ssh: {
    connect(req: ConnectRequest): Promise<void>
    disconnect(runtimeId: string): Promise<void>
    write(runtimeId: string, data: string): Promise<void>
    resize(runtimeId: string, cols: number, rows: number): Promise<void>
    ack(runtimeId: string, bytes: number): Promise<void>
    hostKeyDecision(requestId: string, accept: boolean): Promise<void>
    /** Supply the password typed into the terminal and retry authentication. */
    providePassword(requestId: string, password: string): Promise<void>
    /** Abandon an inline password prompt (Ctrl+C in the terminal). */
    cancelPassword(requestId: string): Promise<void>
    keyboardInteractive(requestId: string, responses?: string[], cancel?: boolean): Promise<void>
  }
  monitor: {
    /** Sample CPU, memory, disk, network and uptime from an SSH session. */
    sample(runtimeId: string): Promise<RemoteMonitorSample>
  }
  sftp: {
    home(runtimeId: string): Promise<string>
    startDir(runtimeId: string): Promise<string>
    list(runtimeId: string, path: string): Promise<FileEntry[]>
    mkdir(runtimeId: string, path: string): Promise<void>
    remove(runtimeId: string, path: string, isDir: boolean): Promise<void>
    rename(runtimeId: string, from: string, to: string): Promise<void>
    chmod(runtimeId: string, path: string, mode: number): Promise<void>
    upload(
      runtimeId: string,
      localPaths: string[],
      remoteDir: string,
      transferId?: string
    ): Promise<void>
    download(
      runtimeId: string,
      remotePaths: string[],
      localDir: string,
      transferId?: string
    ): Promise<void>
    cancel(transferId: string): Promise<void>
  }
  tunnels: {
    start(config: TunnelConfig): Promise<TunnelInfo>
    stop(id: string): Promise<void>
    list(runtimeId: string): Promise<TunnelInfo[]>
  }
  fs: {
    home(): Promise<string>
    /** Desktop when it exists, otherwise home. */
    startDir(): Promise<string>
    /** Drive roots for the Windows "This PC" view; empty elsewhere. */
    drives(): Promise<FileEntry[]>
    list(path: string): Promise<FileEntry[]>
    mkdir(path: string): Promise<void>
    remove(path: string, isDir: boolean): Promise<void>
    rename(from: string, to: string): Promise<void>
    pickFile(): Promise<string | null>
    pickDirectory(): Promise<string | null>
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }
  events: {
    on(callback: (event: AppEvent) => void): () => void
  }
}
