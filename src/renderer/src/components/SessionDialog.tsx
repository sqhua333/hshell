import { useEffect, useState, type ReactElement } from 'react'
import type {
  AuthMethod,
  ConnectionType,
  Folder,
  HighlightRule,
  KeyMetadata,
  LogFormat,
  QuickCommand,
  SerialDataBits,
  SerialFlowControl,
  SerialParity,
  SerialPortInfo,
  SerialStopBits,
  Session,
  TriggerRule
} from '@shared/types'
import { api } from '../api'
import { COLOR_SCHEMES, legacyThemeForScheme, resolveColorScheme } from '../lib/color-schemes'
import { tr } from '../lib/i18n'
import { useApp, type SessionDialogTab as SheetTab } from '../store'
import { Icon } from './Icon'
import { Modal } from './Modal'

function ruleId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

const ALGORITHM_LABEL: Record<KeyMetadata['algorithm'], string> = {
  rsa: 'RSA',
  ecdsa: 'ECDSA',
  ed25519: 'Ed25519'
}

function flattenFolders(
  folders: Folder[],
  parentId: string | null = null,
  depth = 0
): Array<{ folder: Folder; depth: number }> {
  const result: Array<{ folder: Folder; depth: number }> = []
  for (const folder of folders
    .filter((item) => item.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)) {
    result.push({ folder, depth })
    result.push(...flattenFolders(folders, folder.id, depth + 1))
  }
  return result
}

export function SessionDialog(): ReactElement | null {
  const open = useApp((state) => state.sessionDialog.open)
  const initial = useApp((state) => state.sessionDialog.initial)
  const presetFolderId = useApp((state) => state.sessionDialog.presetFolderId)
  const initialTab = useApp((state) => state.sessionDialog.initialTab)
  if (!open) return null
  return (
    <SessionDialogInner
      initial={initial}
      presetFolderId={presetFolderId}
      initialTab={initialTab}
    />
  )
}

function SessionDialogInner({
  initial,
  presetFolderId,
  initialTab
}: {
  initial: Session | null
  presetFolderId: string | null
  initialTab: SheetTab
}): ReactElement {
  const folders = useApp((state) => state.folders)
  const defaultUsername = useApp((state) => state.defaultUsername)
  const closeSessionDialog = useApp((state) => state.closeSessionDialog)
  const saveSession = useApp((state) => state.saveSession)

  const [tab, setTab] = useState<SheetTab>(initialTab)
  const [connectionType, setConnectionType] = useState<ConnectionType>(
    initial?.connectionType ?? 'ssh'
  )
  const [name, setName] = useState(initial?.name ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? 22))
  const [username, setUsername] = useState(initial?.username ?? defaultUsername)
  const [proxyJump, setProxyJump] = useState(initial?.proxyJump ?? '')
  const [serialPath, setSerialPath] = useState(initial?.serial?.path ?? '')
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([])
  const [portListNonce, setPortListNonce] = useState(0)
  const [baudRate, setBaudRate] = useState(String(initial?.serial?.baudRate ?? 115200))
  const [dataBits, setDataBits] = useState(String(initial?.serial?.dataBits ?? 8))
  const [stopBits, setStopBits] = useState(String(initial?.serial?.stopBits ?? 1))
  const [parity, setParity] = useState<SerialParity>(initial?.serial?.parity ?? 'none')
  const [flowControl, setFlowControl] = useState<SerialFlowControl>(
    initial?.serial?.flowControl ?? 'none'
  )
  const [dtr, setDtr] = useState(initial?.serial?.dtr ?? true)
  const [rts, setRts] = useState(initial?.serial?.rts ?? true)
  const [folderId, setFolderId] = useState<string>(initial?.folderId ?? presetFolderId ?? '')
  const [method, setMethod] = useState<AuthMethod>(initial?.auth.method ?? 'password')
  const [keyPath, setKeyPath] = useState(initial?.auth.keyPath ?? '~/.ssh/id_rsa')
  const [keyId, setKeyId] = useState(initial?.auth.keyId ?? '')
  const [vaultKeys, setVaultKeys] = useState<KeyMetadata[]>([])
  const [password, setPassword] = useState('')
  const [savePassword, setSavePassword] = useState(initial?.auth.savePassword ?? false)
  const [passphrase, setPassphrase] = useState('')
  const [colorScheme, setColorScheme] = useState(
    resolveColorScheme(initial?.terminal.colorScheme, initial?.terminal.theme).id
  )
  const [fontSize, setFontSize] = useState(String(initial?.terminal.fontSize ?? 14))
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>(
    initial?.quickCommands?.map((item) => ({ ...item })) ?? []
  )
  const [triggers, setTriggers] = useState<TriggerRule[]>(
    initial?.triggers?.map((item) => ({ ...item })) ?? []
  )
  const [highlights, setHighlights] = useState<HighlightRule[]>(
    initial?.highlights?.map((item) => ({ ...item })) ?? []
  )
  const [loggingEnabled, setLoggingEnabled] = useState(initial?.logging?.enabled ?? false)
  const [logFormat, setLogFormat] = useState<LogFormat>(initial?.logging?.format ?? 'text')
  const [logDirectory, setLogDirectory] = useState(initial?.logging?.directory ?? '')
  const [logTimestamps, setLogTimestamps] = useState(initial?.logging?.timestamps ?? false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const folderOptions = flattenFolders(folders)

  useEffect(() => {
    let cancelled = false
    api.keys
      .list()
      .then((list) => {
        if (!cancelled) setVaultKeys(list)
      })
      .catch(() => {
        /* 保险库可能尚未解锁；仍可使用私钥文件 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (connectionType !== 'serial') return
    let cancelled = false
    api.serial
      .list()
      .then((list) => {
        if (!cancelled) setSerialPorts(list)
      })
      .catch(() => {
        /* listing can fail without affecting manual entry */
      })
    return () => {
      cancelled = true
    }
  }, [connectionType, portListNonce])

  const browseKey = async (): Promise<void> => {
    const file = await api.fs.pickFile()
    if (file) setKeyPath(file)
  }

  const browseLogDirectory = async (): Promise<void> => {
    const directory = await api.fs.pickDirectory()
    if (directory) setLogDirectory(directory)
  }

  const submit = async (connectAfter: boolean): Promise<void> => {
    const hostValue = host.trim()
    const userValue = username.trim()
    const portValue = Number(port)
    const serialValue = serialPath.trim()
    const baudValue = Number(baudRate)
    const isSerial = connectionType === 'serial'

    if (isSerial) {
      if (!serialValue) {
        setTab('connection')
        setError(tr('请输入串口设备路径', 'Please enter a serial device path'))
        return
      }
      if (/[\u0000-\u001f\u007f]/.test(serialValue)) {
        setTab('connection')
        setError(tr('串口设备路径包含非法字符', 'The serial device path contains invalid characters'))
        return
      }
      if (!Number.isInteger(baudValue) || baudValue < 50 || baudValue > 4_000_000) {
        setTab('connection')
        setError(tr('波特率必须是 50 到 4000000 之间的整数', 'Baud rate must be an integer between 50 and 4000000'))
        return
      }
    } else {
      if (!hostValue) {
        setTab('connection')
        setError(tr('请输入主机地址', 'Please enter a host address'))
        return
      }
      if (!userValue) {
        setTab('connection')
        setError(tr('请输入用户名', 'Please enter a username'))
        return
      }
      if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
        setTab('connection')
        setError(tr('端口必须是 1 到 65535 之间的整数', 'Port must be an integer between 1 and 65535'))
        return
      }
      if (method === 'key' && !keyId && !keyPath.trim()) {
        setTab('auth')
        setError(tr('请选择保险库密钥或私钥文件', 'Choose a vault key or a private key file'))
        return
      }
      if (method === 'password' && savePassword && !password && !initial?.auth.savePassword) {
        setTab('auth')
        setError(tr('请先输入要保存的密码', 'Enter the password you want to save'))
        return
      }
    }

    const cleanQuick = quickCommands
      .map((item) => ({ ...item, label: item.label.trim(), command: item.command.trim() }))
      .filter((item) => item.label && item.command)
    if (cleanQuick.length !== quickCommands.filter((item) => item.label.trim() || item.command.trim()).length) {
      setTab('automation')
      setError(tr('快速命令需要同时填写名称和命令', 'Quick commands need both a label and a command'))
      return
    }
    const cleanTriggers = triggers
      .map((item) => ({ ...item, pattern: item.pattern.trim() }))
      .filter((item) => item.pattern)
    const cleanHighlights = highlights
      .map((item) => ({ ...item, pattern: item.pattern.trim() }))
      .filter((item) => item.pattern)
    for (const item of cleanTriggers) {
      if (item.action === 'send' && !item.payload) {
        setTab('automation')
        setError(tr('发送型触发器需要填写发送内容', 'A send trigger needs payload text'))
        return
      }
      if (item.regex) {
        try {
          new RegExp(item.pattern)
        } catch {
          setTab('automation')
          setError(tr(`触发器正则表达式无效：${item.pattern}`, `Invalid trigger regular expression: ${item.pattern}`))
          return
        }
      }
    }
    for (const item of cleanHighlights) {
      if (item.regex) {
        try {
          new RegExp(item.pattern)
        } catch {
          setTab('terminal')
          setError(tr(`突出显示正则表达式无效：${item.pattern}`, `Invalid highlight regular expression: ${item.pattern}`))
          return
        }
      }
    }

    const now = Date.now()
    const session: Session = {
      id: initial?.id ?? `session-${now}-${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim() || (isSerial ? serialValue : hostValue),
      folderId: folderId || null,
      host: isSerial ? serialValue : hostValue,
      port: isSerial ? (initial?.port ?? 1) : portValue,
      username: isSerial ? 'serial' : userValue,
      connectionType,
      serial: isSerial
        ? {
            path: serialValue,
            baudRate: baudValue,
            dataBits: Number(dataBits) as SerialDataBits,
            stopBits: Number(stopBits) as SerialStopBits,
            parity,
            flowControl,
            dtr,
            rts
          }
        : undefined,
      proxyJump: isSerial ? null : proxyJump.trim() || null,
      auth: isSerial
        ? { method: 'agent' }
        : {
            method,
            keyPath: method === 'key' && !keyId ? keyPath.trim() : undefined,
            keyId: method === 'key' && keyId ? keyId : undefined,
            password:
              method === 'password'
                ? password
                : method === 'key' && !keyId && passphrase
                  ? passphrase
                  : undefined,
            savePassword: method === 'password' ? savePassword : undefined
          },
      terminal: {
        term: initial?.terminal.term ?? 'xterm-256color',
        theme: legacyThemeForScheme(colorScheme),
        fontSize: Math.max(8, Math.min(40, Number(fontSize) || 14)),
        colorScheme
      },
      quickCommands: cleanQuick.length ? cleanQuick : undefined,
      triggers: cleanTriggers.length ? cleanTriggers : undefined,
      highlights: cleanHighlights.length ? cleanHighlights : undefined,
      logging: {
        enabled: loggingEnabled,
        format: logFormat,
        directory: logDirectory.trim() || undefined,
        timestamps: logFormat === 'text' ? logTimestamps || undefined : undefined
      },
      color: initial?.color,
      createdAt: initial?.createdAt ?? now,
      updatedAt: now
    }

    setSaving(true)
    setError('')
    try {
      await saveSession(session)
      closeSessionDialog()
      if (connectAfter) useApp.getState().openSession(session)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const selectedScheme = resolveColorScheme(colorScheme)
  const updateQuick = (id: string, patch: Partial<QuickCommand>): void =>
    setQuickCommands((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  const updateTrigger = (id: string, patch: Partial<TriggerRule>): void =>
    setTriggers((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  const updateHighlight = (id: string, patch: Partial<HighlightRule>): void =>
    setHighlights((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))

  const navItems: Array<{ id: SheetTab; label: string; icon: string }> = [
    { id: 'connection', label: tr('连接', 'Connection'), icon: 'server' },
    ...(connectionType === 'serial'
      ? []
      : [{ id: 'auth' as const, label: tr('身份验证', 'Authentication'), icon: 'key' }]),
    { id: 'terminal', label: tr('终端', 'Terminal'), icon: 'terminal' },
    { id: 'automation', label: tr('自动化', 'Automation'), icon: 'trigger' },
    { id: 'advanced', label: tr('高级', 'Advanced'), icon: 'settings' }
  ]

  return (
    <Modal
      title={initial ? tr('会话属性', 'Session properties') : tr('新建会话', 'New session')}
      subtitle={
        initial
          ? initial.name
          : connectionType === 'serial'
            ? tr('配置一个新的串口连接', 'Configure a new serial connection')
            : tr('配置一个新的 SSH 连接', 'Configure a new SSH connection')
      }
      width={720}
      onClose={closeSessionDialog}
      footer={
        <>
          {error ? <div className="form-error">{error}</div> : <div />}
          <div className="modal-actions">
            <button className="btn" onClick={closeSessionDialog} disabled={saving}>
              {tr('取消', 'Cancel')}
            </button>
            <button className="btn" onClick={() => void submit(false)} disabled={saving}>
              {tr('保存', 'Save')}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void submit(true)}
              disabled={saving}
            >
              {tr('保存并连接', 'Save and connect')}
            </button>
          </div>
        </>
      }
    >
      <div className="sheet">
        <nav className="sheet-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`sheet-nav-item ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sheet-content">
          {tab === 'connection' ? (
            <>
              <div className="section-title">{tr('基本设置', 'Basics')}</div>
              <div className="form-grid">
                <label className="field">
                  <span>{tr('名称', 'Name')}</span>
                  <input
                    className="input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={tr('例如：web-prod-01', 'e.g. web-prod-01')}
                    autoFocus
                  />
                </label>
                <label className="field">
                  <span>{tr('分组', 'Folder')}</span>
                  <select
                    className="input"
                    value={folderId}
                    onChange={(event) => setFolderId(event.target.value)}
                  >
                    <option value="">{tr('（根目录）', '(root)')}</option>
                    {folderOptions.map(({ folder, depth }) => (
                      <option key={folder.id} value={folder.id}>
                        {'　'.repeat(depth)}
                        {folder.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{tr('协议', 'Protocol')}</span>
                  <select
                    className="input"
                    value={connectionType}
                    onChange={(event) => {
                      const next = event.target.value as ConnectionType
                      setConnectionType(next)
                      if (next === 'serial') setTab('connection')
                    }}
                  >
                    <option value="ssh">SSH</option>
                    <option value="serial">{tr('串口', 'Serial')}</option>
                  </select>
                </label>

                {connectionType === 'ssh' ? (
                  <>
                    <label className="field">
                      <span>{tr('主机', 'Host')}</span>
                      <input
                        className="input"
                        value={host}
                        onChange={(event) => setHost(event.target.value)}
                        placeholder={tr('127.0.0.1 或 example.com', '127.0.0.1 or example.com')}
                      />
                    </label>
                    <label className="field">
                      <span>{tr('端口', 'Port')}</span>
                      <input
                        className="input"
                        value={port}
                        onChange={(event) => setPort(event.target.value)}
                        inputMode="numeric"
                      />
                    </label>
                    <label className="field">
                      <span>{tr('用户名', 'Username')}</span>
                      <input
                        className="input"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        placeholder="root"
                      />
                    </label>
                    <label className="field">
                      <span>{tr('跳板机（ProxyJump，可选）', 'Jump host (ProxyJump, optional)')}</span>
                      <input
                        className="input"
                        value={proxyJump}
                        onChange={(event) => setProxyJump(event.target.value)}
                        placeholder={tr('user@bastion:22 或 hop1,hop2', 'user@bastion:22 or hop1,hop2')}
                        spellCheck={false}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span>{tr('串口设备', 'Serial device')}</span>
                      <span className="field-inline">
                        <input
                          className="input"
                          value={serialPath}
                          onChange={(event) => setSerialPath(event.target.value)}
                          placeholder={tr('/dev/ttyUSB0 或 COM3', '/dev/ttyUSB0 or COM3')}
                          list="hshell-serial-ports"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="btn btn-ghost"
                          title={tr('刷新串口列表', 'Refresh serial ports')}
                          onClick={() => setPortListNonce((value) => value + 1)}
                        >
                          <Icon name="refresh" size={14} />
                        </button>
                      </span>
                      <datalist id="hshell-serial-ports">
                        {serialPorts.map((item) => (
                          <option key={item.path} value={item.path}>
                            {item.manufacturer
                              ? `${item.path} — ${item.manufacturer}`
                              : item.path}
                          </option>
                        ))}
                      </datalist>
                    </label>
                    <label className="field">
                      <span>{tr('波特率', 'Baud rate')}</span>
                      <input
                        className="input"
                        value={baudRate}
                        onChange={(event) => setBaudRate(event.target.value)}
                        list="hshell-baud-rates"
                        inputMode="numeric"
                      />
                      <datalist id="hshell-baud-rates">
                        {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(
                          (rate) => (
                            <option key={rate} value={rate} />
                          )
                        )}
                      </datalist>
                    </label>
                    <label className="field">
                      <span>{tr('数据位', 'Data bits')}</span>
                      <select
                        className="input"
                        value={dataBits}
                        onChange={(event) => setDataBits(event.target.value)}
                      >
                        {['5', '6', '7', '8'].map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>{tr('停止位', 'Stop bits')}</span>
                      <select
                        className="input"
                        value={stopBits}
                        onChange={(event) => setStopBits(event.target.value)}
                      >
                        {['1', '1.5', '2'].map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>{tr('校验位', 'Parity')}</span>
                      <select
                        className="input"
                        value={parity}
                        onChange={(event) => setParity(event.target.value as SerialParity)}
                      >
                        <option value="none">{tr('无（None）', 'None')}</option>
                        <option value="even">{tr('偶校验（Even）', 'Even')}</option>
                        <option value="odd">{tr('奇校验（Odd）', 'Odd')}</option>
                        <option value="mark">{tr('标记（Mark）', 'Mark')}</option>
                        <option value="space">{tr('空格（Space）', 'Space')}</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>{tr('流控制', 'Flow control')}</span>
                      <select
                        className="input"
                        value={flowControl}
                        onChange={(event) =>
                          setFlowControl(event.target.value as SerialFlowControl)
                        }
                      >
                        <option value="none">{tr('无', 'None')}</option>
                        <option value="rtscts">{tr('硬件（RTS/CTS）', 'Hardware (RTS/CTS)')}</option>
                        <option value="xonxoff">{tr('软件（XON/XOFF）', 'Software (XON/XOFF)')}</option>
                      </select>
                    </label>
                  </>
                )}
              </div>
              {connectionType === 'serial' ? (
                <div className="check-inline">
                  <label>
                    <input
                      type="checkbox"
                      checked={dtr}
                      onChange={(event) => setDtr(event.target.checked)}
                    />
                    <span>DTR</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={rts}
                      onChange={(event) => setRts(event.target.checked)}
                    />
                    <span>RTS</span>
                  </label>
                </div>
              ) : null}
              <div className="form-hint">
                {connectionType === 'serial'
                  ? tr(
                      '串口参数保存在本地。设备路径可直接输入，也可从下拉列表中选择；Linux 下若提示权限不足，请把当前用户加入 dialout 组。',
                      'Serial settings are stored locally. Type the device path or pick one from the list. On Linux, add your user to the dialout group if access is denied.'
                    )
                  : tr(
                      '连接信息会保存到本地；密码默认只留在内存，可在「身份验证」中勾选加密保存。跳板机使用与主机会话相同的认证方式，多跳用逗号分隔。',
                      'Connection details are stored locally. Passwords stay in memory unless you enable encrypted saving under Authentication. Jump hosts use the same authentication method as the session; separate multiple hops with commas.'
                    )}
              </div>
            </>
          ) : null}

          {tab === 'auth' ? (
            <>
              <div className="section-title">{tr('身份验证', 'Authentication')}</div>
              <div className="form-grid single">
                <label className="field">
                  <span>{tr('认证方式', 'Method')}</span>
                  <select
                    className="input"
                    value={method}
                    onChange={(event) => setMethod(event.target.value as AuthMethod)}
                  >
                    <option value="password">{tr('密码', 'Password')}</option>
                    <option value="key">{tr('公钥（私钥文件）', 'Public key (private key file)')}</option>
                    <option value="agent">SSH Agent</option>
                    <option value="keyboard-interactive">{tr('键盘交互', 'Keyboard-interactive')}</option>
                  </select>
                </label>

                {method === 'password' ? (
                  <>
                    <label className="field">
                      <span>{tr('密码', 'Password')}</span>
                      <input
                        className="input"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder={
                          initial?.auth.savePassword
                            ? tr('已保存；留空保持不变', 'Saved; leave blank to keep it')
                            : tr('仅保存在内存中', 'Kept in memory only')
                        }
                      />
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={savePassword}
                        onChange={(event) => setSavePassword(event.target.checked)}
                      />
                      {tr(
                        '保存密码（下次连接自动使用，本机加密存储）',
                        'Save password (encrypted locally, reused automatically)'
                      )}
                    </label>
                  </>
                ) : null}

                {method === 'key' ? (
                  <>
                    <label className="field">
                      <span>{tr('私钥来源', 'Private key source')}</span>
                      <select
                        className="input"
                        value={keyId}
                        onChange={(event) => setKeyId(event.target.value)}
                      >
                        <option value="">{tr('私钥文件', 'Private key file')}</option>
                        {vaultKeys.map((key) => (
                          <option key={key.id} value={key.id}>
                            {tr('保险库', 'Vault')}: {key.label} ({ALGORITHM_LABEL[key.algorithm]})
                          </option>
                        ))}
                      </select>
                    </label>

                    {keyId ? (
                      <div className="form-hint">
                        {tr(
                          '私钥及其口令保存在保险库中；连接时由主进程解密，不会下发到界面。',
                          'The private key and passphrase live in the encrypted vault and are decrypted by the main process; they never reach the interface.'
                        )}
                        {vaultKeys.find((key) => key.id === keyId)?.hasPassphrase
                          ? tr(' 该密钥带有口令，将自动使用。', ' The key is passphrase-protected and will be used automatically.')
                          : ''}
                      </div>
                    ) : (
                      <>
                        <label className="field">
                          <span>{tr('私钥文件', 'Private key file')}</span>
                          <div className="input-row">
                            <input
                              className="input"
                              value={keyPath}
                              onChange={(event) => setKeyPath(event.target.value)}
                              placeholder="~/.ssh/id_rsa"
                            />
                            <button className="btn" onClick={() => void browseKey()}>
                              {tr('浏览…', 'Browse…')}
                            </button>
                          </div>
                        </label>
                        <label className="field">
                          <span>{tr('私钥口令（可选）', 'Key passphrase (optional)')}</span>
                          <input
                            className="input"
                            type="password"
                            value={passphrase}
                            onChange={(event) => setPassphrase(event.target.value)}
                            placeholder={tr('仅保存在内存中', 'Kept in memory only')}
                          />
                        </label>
                        {vaultKeys.length === 0 ? (
                          <div className="form-hint">
                            {tr(
                              '尚未解锁密钥保险库。可在工具栏「密钥管理」中生成或导入密钥。',
                              'The key vault is locked. Generate or import a key from Key Manager in the toolbar.'
                            )}
                          </div>
                        ) : null}
                      </>
                    )}
                  </>
                ) : null}

                {method === 'agent' ? (
                  <div className="form-hint">
                    {tr('使用 ', 'Use the agent referenced by ')}<code>SSH_AUTH_SOCK</code>{tr('。Linux/macOS 需先', '. On Linux/macOS, run')}
                    <code> ssh-add</code>.
                  </div>
                ) : null}

                {method === 'keyboard-interactive' ? (
                  <div className="form-hint">
                    {tr(
                      '连接时由服务器发起交互式提示（验证码、多因素等）。',
                      'The server sends interactive prompts (verification codes, MFA, and so on) during connection.'
                    )}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {tab === 'terminal' ? (
            <>
              <div className="section-title">{tr('终端外观', 'Terminal appearance')}</div>
              <div className="form-grid">
                <label className="field">
                  <span>{tr('配色方案', 'Color scheme')}</span>
                  <select
                    className="input"
                    value={colorScheme}
                    onChange={(event) => setColorScheme(event.target.value)}
                  >
                    {COLOR_SCHEMES.map((scheme) => (
                      <option key={scheme.id} value={scheme.id}>
                        {tr(scheme.name, scheme.nameEn)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{tr('字号', 'Font size')}</span>
                  <input
                    className="input"
                    value={fontSize}
                    onChange={(event) => setFontSize(event.target.value)}
                    inputMode="numeric"
                  />
                </label>
              </div>
              <div className="scheme-preview" aria-hidden="true">
                {[
                  selectedScheme.theme.background,
                  selectedScheme.theme.foreground,
                  selectedScheme.theme.red,
                  selectedScheme.theme.green,
                  selectedScheme.theme.yellow,
                  selectedScheme.theme.blue,
                  selectedScheme.theme.magenta,
                  selectedScheme.theme.cyan
                ].map((color, index) => (
                  <span key={index} style={{ background: color }} />
                ))}
                <em>{tr(selectedScheme.name, selectedScheme.nameEn)}</em>
              </div>
              <div className="form-hint">
                {tr(
                  '每个会话可使用独立的配色方案；界面深/浅主题不会覆盖终端配色。终端类型固定为 xterm-256color，编码固定为 UTF-8。',
                  'Each session keeps its own palette; the light/dark UI theme does not override it. Terminal type is fixed to xterm-256color and encoding to UTF-8.'
                )}
              </div>

              <div className="section-title">{tr('突出显示集', 'Highlight set')}</div>
              <div className="form-hint">
                {tr(
                  '当输出行匹配时，为整行添加背景色或文字色。规则按顺序匹配，每行只应用第一条命中的规则。',
                  'When an output line matches, the whole line gets a background or text color. Rules are checked in order and the first match wins.'
                )}
              </div>
              <div className="rule-list">
                {highlights.map((rule) => (
                  <div className="rule-row highlight-row" key={rule.id}>
                    <input
                      className="input"
                      value={rule.pattern}
                      onChange={(event) => updateHighlight(rule.id, { pattern: event.target.value })}
                      placeholder={tr('例如 ERROR、WARNING，或正则', 'For example ERROR, WARNING, or a regex')}
                      spellCheck={false}
                    />
                    <label className="mini-check">
                      <input
                        type="checkbox"
                        checked={Boolean(rule.regex)}
                        onChange={(event) => updateHighlight(rule.id, { regex: event.target.checked })}
                      />
                      {tr('正则', 'Regex')}
                    </label>
                    <label className="mini-check">
                      <input
                        type="checkbox"
                        checked={Boolean(rule.caseSensitive)}
                        onChange={(event) =>
                          updateHighlight(rule.id, { caseSensitive: event.target.checked })
                        }
                      />
                      {tr('区分大小写', 'Case')}
                    </label>
                    <input
                      className="color-input"
                      type="color"
                      title={tr('背景色', 'Background')}
                      value={rule.background ?? '#ffd54f'}
                      onChange={(event) => updateHighlight(rule.id, { background: event.target.value })}
                    />
                    <input
                      className="color-input"
                      type="color"
                      title={tr('文字色', 'Text color')}
                      value={rule.foreground ?? '#1f2937'}
                      onChange={(event) => updateHighlight(rule.id, { foreground: event.target.value })}
                    />
                    <label className="mini-check">
                      <input
                        type="checkbox"
                        checked={rule.enabled !== false}
                        onChange={(event) => updateHighlight(rule.id, { enabled: event.target.checked })}
                      />
                      {tr('启用', 'On')}
                    </label>
                    <button
                      className="icon-btn mini danger"
                      title={tr('删除', 'Delete')}
                      onClick={() =>
                        setHighlights((list) => list.filter((item) => item.id !== rule.id))
                      }
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                className="btn"
                onClick={() =>
                  setHighlights((list) => [
                    ...list,
                    {
                      id: ruleId('hl'),
                      pattern: '',
                      background: '#ffd54f',
                      foreground: '#1f2937',
                      enabled: true
                    }
                  ])
                }
              >
                <Icon name="plus" size={14} />
                {tr('添加突出显示规则', 'Add highlight rule')}
              </button>
            </>
          ) : null}

          {tab === 'automation' ? (
            <>
              <div className="section-title">{tr('快速命令', 'Quick commands')}</div>
              <div className="form-hint">
                {tr(
                  '快速命令显示在会话底部的命令栏中，点击即可发送。适合常用的查看、重启与部署命令。',
                  'Quick commands appear in the bar below the session and send with one click — handy for frequent status, restart and deploy commands.'
                )}
              </div>
              <div className="rule-list">
                {quickCommands.map((item) => (
                  <div className="rule-row quick-row" key={item.id}>
                    <input
                      className="input"
                      value={item.label}
                      onChange={(event) => updateQuick(item.id, { label: event.target.value })}
                      placeholder={tr('按钮名称', 'Button label')}
                    />
                    <input
                      className="input"
                      value={item.command}
                      onChange={(event) => updateQuick(item.id, { command: event.target.value })}
                      placeholder={tr('要发送的命令', 'Command to send')}
                      spellCheck={false}
                    />
                    <label className="mini-check">
                      <input
                        type="checkbox"
                        checked={item.sendEnter !== false}
                        onChange={(event) =>
                          updateQuick(item.id, { sendEnter: event.target.checked })
                        }
                      />
                      {tr('附加回车', 'Enter')}
                    </label>
                    <button
                      className="icon-btn mini danger"
                      title={tr('删除', 'Delete')}
                      onClick={() =>
                        setQuickCommands((list) => list.filter((entry) => entry.id !== item.id))
                      }
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                className="btn"
                onClick={() =>
                  setQuickCommands((list) => [
                    ...list,
                    { id: ruleId('qc'), label: '', command: '', sendEnter: true }
                  ])
                }
              >
                <Icon name="plus" size={14} />
                {tr('添加快速命令', 'Add quick command')}
              </button>

              <div className="section-title">{tr('触发器', 'Triggers')}</div>
              <div className="form-hint">
                {tr(
                  '终端输出匹配指定字符串或正则时执行操作。「发送」会把内容写回会话（自动补回车），「通知」显示一条提示。每条规则有 1.5 秒冷却，避免循环触发。',
                  'Run an action when terminal output matches a string or regex. Send writes text back to the session (Enter is appended automatically); Notify shows a toast. Each rule has a 1.5 s cooldown to avoid loops.'
                )}
              </div>
              <div className="rule-list">
                {triggers.map((rule) => (
                  <div className="rule-row trigger-row" key={rule.id}>
                    <input
                      className="input"
                      value={rule.pattern}
                      onChange={(event) => updateTrigger(rule.id, { pattern: event.target.value })}
                      placeholder={tr('匹配内容或正则', 'Text or regex to match')}
                      spellCheck={false}
                    />
                    <label className="mini-check">
                      <input
                        type="checkbox"
                        checked={Boolean(rule.regex)}
                        onChange={(event) => updateTrigger(rule.id, { regex: event.target.checked })}
                      />
                      {tr('正则', 'Regex')}
                    </label>
                    <label className="mini-check">
                      <input
                        type="checkbox"
                        checked={Boolean(rule.caseSensitive)}
                        onChange={(event) =>
                          updateTrigger(rule.id, { caseSensitive: event.target.checked })
                        }
                      />
                      {tr('区分大小写', 'Case')}
                    </label>
                    <select
                      className="input action-select"
                      value={rule.action}
                      onChange={(event) =>
                        updateTrigger(rule.id, {
                          action: event.target.value as TriggerRule['action']
                        })
                      }
                    >
                      <option value="send">{tr('发送', 'Send')}</option>
                      <option value="notify">{tr('通知', 'Notify')}</option>
                    </select>
                    <input
                      className="input"
                      value={rule.payload}
                      onChange={(event) => updateTrigger(rule.id, { payload: event.target.value })}
                      placeholder={
                        rule.action === 'send'
                          ? tr('要发送的内容', 'Text to send')
                          : tr('提示文字（可选）', 'Notification text (optional)')
                      }
                      spellCheck={false}
                    />
                    <label className="mini-check">
                      <input
                        type="checkbox"
                        checked={rule.enabled !== false}
                        onChange={(event) => updateTrigger(rule.id, { enabled: event.target.checked })}
                      />
                      {tr('启用', 'On')}
                    </label>
                    <button
                      className="icon-btn mini danger"
                      title={tr('删除', 'Delete')}
                      onClick={() => setTriggers((list) => list.filter((item) => item.id !== rule.id))}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                className="btn"
                onClick={() =>
                  setTriggers((list) => [
                    ...list,
                    {
                      id: ruleId('tr'),
                      pattern: '',
                      action: 'notify',
                      payload: '',
                      enabled: true
                    }
                  ])
                }
              >
                <Icon name="plus" size={14} />
                {tr('添加触发器', 'Add trigger')}
              </button>
            </>
          ) : null}

          {tab === 'advanced' ? (
            <>
              <div className="section-title">{tr('端口转发', 'Port forwarding')}</div>
              <div className="placeholder-card">
                <Icon name="link" size={20} />
                <div>
                  <strong>{tr('运行时管理', 'Runtime management')}</strong>
                  <p>{tr(
                    '连接后在工具栏「端口转发」中管理本地、远程与动态 SOCKS5 规则。',
                    'After connecting, manage local, remote and dynamic SOCKS5 rules from Port Forwarding in the toolbar.'
                  )}</p>
                </div>
              </div>
              <div className="section-title">{tr('会话日志', 'Session logging')}</div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={loggingEnabled}
                  onChange={(event) => setLoggingEnabled(event.target.checked)}
                />
                <span>{tr('连接时自动记录终端输出', 'Record terminal output when connecting')}</span>
              </label>
              <div className="form-grid">
                <label className="field">
                  <span>{tr('日志格式', 'Log format')}</span>
                  <select
                    className="input"
                    value={logFormat}
                    onChange={(event) => setLogFormat(event.target.value as LogFormat)}
                    disabled={!loggingEnabled}
                  >
                    <option value="text">{tr('纯文本（.log）', 'Plain text (.log)')}</option>
                    <option value="asciinema">asciinema v2（.cast）</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span>{tr('日志目录', 'Log directory')}</span>
                <div className="input-row">
                  <input
                    className="input"
                    value={logDirectory}
                    onChange={(event) => setLogDirectory(event.target.value)}
                    placeholder={tr(
                      '默认：应用数据目录/logs',
                      'Default: <userData>/logs'
                    )}
                    disabled={!loggingEnabled}
                  />
                  <button
                    className="btn"
                    onClick={() => void browseLogDirectory()}
                    disabled={!loggingEnabled}
                  >
                    {tr('浏览…', 'Browse…')}
                  </button>
                </div>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={logTimestamps}
                  onChange={(event) => setLogTimestamps(event.target.checked)}
                  disabled={!loggingEnabled || logFormat === 'asciinema'}
                />
                <span>
                  {tr(
                    '每行添加时间戳（仅纯文本；asciinema 自带时间轴）',
                    'Prefix each line with a timestamp (text only; asciinema has its own timeline)'
                  )}
                </span>
              </label>
              <div className="form-hint">
                {tr(
                  '日志目录留空时写入应用数据目录的 logs/；可选择任意可写文件夹。文件权限 0600，按 10 MB 轮转并保留 5 份。日志可能包含命令与敏感输出，请妥善保管。',
                  'Leave the directory empty to use logs/ in the application data directory, or pick any writable folder. Files use mode 0600, rotate at 10 MB and keep 5 files. Logs may contain commands and sensitive output; handle them carefully.'
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
