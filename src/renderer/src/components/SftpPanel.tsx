import {
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { FileEntry } from '@shared/types'
import { isNonSshSession } from '@shared/session'
import { api } from '../api'
import { updateFileSelection } from '../lib/file-selection'
import { formatBytes, formatSpeed } from '../lib/format'
import { tr } from '../lib/i18n'
import { sessionForRuntime, useApp } from '../store'
import { Icon } from './Icon'
import { Modal } from './Modal'

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function parentPath(path: string): string {
  if (isWindowsPath(path)) {
    const normalized = path.replace(/[\\/]+$/, '')
    // Drive and UNC share roots have no filesystem parent; the caller shows This PC.
    if (/^[A-Za-z]:$/.test(normalized)) return ''
    if (/^\\\\[^\\/]+[\\/][^\\/]+$/.test(normalized)) return ''
    const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
    if (index < 0) return ''
    if (index === 2 && /^[A-Za-z]:/.test(normalized)) return `${normalized.slice(0, 2)}\\`
    return normalized.slice(0, index)
  }
  const normalized = path.replace(/\/+$/, '')
  if (!normalized || normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

function joinPath(dir: string, name: string): string {
  if (isWindowsPath(dir)) {
    const base = dir.replace(/[\\/]+$/, '')
    return base ? `${base}\\${name}` : name
  }
  if (!dir || dir === '/') return `/${name}`
  return `${dir.replace(/\/+$/, '')}/${name}`
}

function newTransferId(): string {
  return `sftp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function formatDate(mtime: number): string {
  if (!mtime) return '—'
  const date = new Date(mtime)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

interface FileTableProps {
  entries: FileEntry[]
  selected: ReadonlySet<string>
  onSelect: (entry: FileEntry, event: ReactMouseEvent<HTMLDivElement>) => void
  onOpen: (entry: FileEntry) => void
}

function FileTable({ entries, selected, onSelect, onOpen }: FileTableProps): ReactElement {
  return (
    <div className="file-table">
      <div className="file-head">
        <span />
        <span>{tr('名称', 'Name')}</span>
        <span>{tr('大小', 'Size')}</span>
        <span>{tr('修改时间', 'Modified')}</span>
      </div>
      <div className="file-body">
        {entries.map((entry) => (
          <div
            key={entry.path}
            className={`file-row ${selected.has(entry.path) ? 'selected' : ''}`}
            onClick={(event) => onSelect(entry, event)}
            onDoubleClick={() => onOpen(entry)}
            title={entry.path}
          >
            <span className={`file-icon ${entry.type}`}>
              <Icon
                name={
                  entry.type === 'directory'
                    ? 'folder'
                    : entry.type === 'symlink'
                      ? 'link'
                      : 'file'
                }
                size={15}
              />
            </span>
            <span className="file-name">
              {entry.name}
              {entry.type === 'directory' ? '/' : ''}
            </span>
            <span className="file-size">
              {entry.type === 'directory' ? '—' : formatBytes(entry.size)}
            </span>
            <span className="file-time">{formatDate(entry.mtime)}</span>
          </div>
        ))}
        {entries.length === 0 ? <div className="file-empty">{tr('空目录', 'Empty directory')}</div> : null}
      </div>
    </div>
  )
}

interface NameDialogProps {
  title: string
  initial: string
  onSubmit: (value: string) => void
  onClose: () => void
}

function NameDialog({ title, initial, onSubmit, onClose }: NameDialogProps): ReactElement {
  const [value, setValue] = useState(initial)
  const submit = (): void => {
    const trimmed = value.trim()
    if (!trimmed) return
    onSubmit(trimmed)
  }
  return (
    <Modal
      title={title}
      width={420}
      onClose={onClose}
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {tr('取消', 'Cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {tr('确定', 'OK')}
          </button>
        </div>
      }
    >
      <label className="field">
        <span>{tr('名称', 'Name')}</span>
        <input
          className="input"
          value={value}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
      </label>
    </Modal>
  )
}

/** The SFTP panel shown below the terminal for SSH sessions. */
export function SftpPanel(): ReactElement {
  const activeRuntimeId = useApp((state) => state.activeRuntimeId)
  return (
    <FileTransferPanel
      runtimeId={activeRuntimeId}
      protocol="sftp"
      onClose={() => useApp.getState().toggleSftp()}
    />
  )
}

/**
 * Two-pane local/remote file manager shared by SFTP and standalone FTP
 * sessions. The remote calls have identical shapes in both APIs.
 */
export function FileTransferPanel({
  runtimeId: activeRuntimeId,
  protocol,
  onClose
}: {
  runtimeId: string | null
  protocol: 'sftp' | 'ftp'
  onClose?: () => void
}): ReactElement {
  const status = useApp((state) =>
    activeRuntimeId ? state.statuses[activeRuntimeId]?.status : undefined
  )
  const nonSshActive = useApp((state) =>
    isNonSshSession(sessionForRuntime(state.activeRuntimeId, state))
  )
  const addToast = useApp((state) => state.addToast)
  const remote = protocol === 'ftp' ? api.ftp : api.sftp
  const label = protocol === 'ftp' ? 'FTP' : 'SFTP'

  const [localPath, setLocalPath] = useState('')
  const [localDraft, setLocalDraft] = useState('')
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([])
  const [localSelected, setLocalSelected] = useState<FileEntry[]>([])
  // Path a Shift+click ranges from; reset whenever the listing changes.
  const [localAnchor, setLocalAnchor] = useState<string | null>(null)
  const [localLoading, setLocalLoading] = useState(false)
  // True while the local pane lists drive roots ("This PC") instead of a directory.
  const [localDrives, setLocalDrives] = useState(false)
  const isWindows = api.app.platform === 'win32'
  const thisPcLabel = tr('此电脑', 'This PC')

  const [remotePath, setRemotePath] = useState('')
  const [remoteDraft, setRemoteDraft] = useState('')
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([])
  const [remoteSelected, setRemoteSelected] = useState<FileEntry[]>([])
  const [remoteAnchor, setRemoteAnchor] = useState<string | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeTransfer, setActiveTransfer] = useState<string | null>(null)
  const transfer = useApp((state) =>
    state.activeRuntimeId ? state.transfers[state.activeRuntimeId] : undefined
  )

  const [nameDialog, setNameDialog] = useState<{
    title: string
    initial: string
    onSubmit: (value: string) => void
  } | null>(null)

  const remoteReady =
    Boolean(activeRuntimeId) &&
    status === 'connected' &&
    (protocol === 'ftp' || !nonSshActive)

  const loadLocal = async (path: string): Promise<void> => {
    setLocalLoading(true)
    try {
      const entries = await api.fs.list(path)
      setLocalEntries(entries)
      setLocalPath(path)
      setLocalDraft(path)
      setLocalSelected([])
      setLocalAnchor(null)
      setLocalDrives(false)
    } catch (error) {
      addToast('error', `${tr('本地目录读取失败：', 'Failed to read local directory: ')}${(error as Error).message}`)
      setLocalDraft(localPath)
    } finally {
      setLocalLoading(false)
    }
  }

  const loadDrives = async (): Promise<void> => {
    setLocalLoading(true)
    try {
      const entries = await api.fs.drives()
      setLocalEntries(entries)
      setLocalSelected([])
      setLocalAnchor(null)
      setLocalDrives(true)
      setLocalDraft(thisPcLabel)
    } catch (error) {
      addToast('error', `${tr('驱动器读取失败：', 'Failed to list drives: ')}${(error as Error).message}`)
    } finally {
      setLocalLoading(false)
    }
  }

  const localUp = (): void => {
    if (localDrives) return
    const parent = parentPath(localPath)
    if (parent) void loadLocal(parent)
    else if (isWindows) void loadDrives()
  }

  const loadRemote = async (path: string): Promise<void> => {
    if (!activeRuntimeId) return
    setRemoteLoading(true)
    try {
      const entries = await remote.list(activeRuntimeId, path)
      setRemoteEntries(entries)
      setRemotePath(path)
      setRemoteDraft(path)
      setRemoteSelected([])
      setRemoteAnchor(null)
    } catch (error) {
      addToast('error', `${tr('远程目录读取失败：', 'Failed to read remote directory: ')}${(error as Error).message}`)
      setRemoteDraft(remotePath)
    } finally {
      setRemoteLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void api.fs
      .startDir()
      .then((home) => {
        if (!cancelled) void loadLocal(home)
      })
      .catch((error: Error) => addToast('error', `${tr('本地目录初始化失败：', 'Failed to initialize local directory: ')}${error.message}`))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!activeRuntimeId || status !== 'connected' || nonSshActive) {
      setRemoteEntries([])
      setRemotePath('')
      setRemoteDraft('')
      setRemoteSelected([])
      setRemoteAnchor(null)
      return
    }
    let cancelled = false
    void remote
      .startDir(activeRuntimeId)
      .then((dir) => {
        if (!cancelled) void loadRemote(dir)
      })
      .catch((error: Error) => {
        if (!cancelled) {
          addToast(
            'error',
            `${tr(`${label} 初始化失败：`, `Failed to initialize ${label}: `)}${error.message}`
          )
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRuntimeId, status, nonSshActive])

  const requireRemote = (): string | null => {
    if (!activeRuntimeId || !remoteReady) {
      addToast(
        'warn',
        protocol === 'ftp'
          ? tr('请先连接 FTP 会话', 'Connect an FTP session first')
          : tr('请先连接 SSH 会话', 'Connect an SSH session first')
      )
      return null
    }
    return activeRuntimeId
  }

  const localSelectedPaths = useMemo(
    () => new Set(localSelected.map((entry) => entry.path)),
    [localSelected]
  )
  const remoteSelectedPaths = useMemo(
    () => new Set(remoteSelected.map((entry) => entry.path)),
    [remoteSelected]
  )

  const selectLocal = (entry: FileEntry, event: ReactMouseEvent<HTMLDivElement>): void => {
    const next = updateFileSelection(localEntries, localSelected, localAnchor, entry, {
      toggle: event.ctrlKey || event.metaKey,
      range: event.shiftKey
    })
    setLocalSelected(next.selected)
    setLocalAnchor(next.anchor)
  }

  const selectRemote = (entry: FileEntry, event: ReactMouseEvent<HTMLDivElement>): void => {
    const next = updateFileSelection(remoteEntries, remoteSelected, remoteAnchor, entry, {
      toggle: event.ctrlKey || event.metaKey,
      range: event.shiftKey
    })
    setRemoteSelected(next.selected)
    setRemoteAnchor(next.anchor)
  }

  const uploadEntries = async (entries: FileEntry[]): Promise<void> => {
    if (localDrives || entries.length === 0) return
    const runtimeId = requireRemote()
    if (!runtimeId) return
    const transferId = newTransferId()
    setBusy(true)
    setActiveTransfer(transferId)
    addToast(
      'info',
      entries.length === 1
        ? `${tr('正在上传', 'Uploading')} ${entries[0].name}…`
        : `${tr('正在上传', 'Uploading')} ${entries.length} ${tr('项…', 'items…')}`
    )
    try {
      await remote.upload(runtimeId, entries.map((entry) => entry.path), remotePath, transferId)
      await loadRemote(remotePath)
    } catch (error) {
      const message = (error as Error).message
      if (message === '传输已取消') addToast('warn', tr('上传已取消，临时文件已清理', 'Upload canceled, temporary files cleaned up'))
      else addToast('error', `${tr('上传失败：', 'Upload failed: ')}${message}`)
    } finally {
      setBusy(false)
      setActiveTransfer(null)
    }
  }

  const uploadSelected = async (): Promise<void> => {
    await uploadEntries(localSelected)
  }

  const downloadEntries = async (entries: FileEntry[]): Promise<void> => {
    // In the This PC view there is no concrete local destination directory.
    if (localDrives) {
      addToast('warn', tr('请先选择本地目录再下载', 'Choose a local directory before downloading'))
      return
    }
    if (entries.length === 0) return
    const runtimeId = requireRemote()
    if (!runtimeId) return
    const transferId = newTransferId()
    setBusy(true)
    setActiveTransfer(transferId)
    addToast(
      'info',
      entries.length === 1
        ? `${tr('正在下载', 'Downloading')} ${entries[0].name}…`
        : `${tr('正在下载', 'Downloading')} ${entries.length} ${tr('项…', 'items…')}`
    )
    try {
      await remote.download(runtimeId, entries.map((entry) => entry.path), localPath, transferId)
      await loadLocal(localPath)
    } catch (error) {
      const message = (error as Error).message
      if (message === '传输已取消') addToast('warn', tr('下载已取消，临时文件已清理', 'Download canceled, temporary files cleaned up'))
      else addToast('error', `${tr('下载失败：', 'Download failed: ')}${message}`)
    } finally {
      setBusy(false)
      setActiveTransfer(null)
    }
  }

  const cancelTransfer = (): void => {
    if (activeTransfer) void remote.cancel(activeTransfer)
  }

  const downloadSelected = async (): Promise<void> => {
    await downloadEntries(remoteSelected)
  }

  const localMkdir = (): void => {
    if (localDrives) return
    setNameDialog({
      title: tr('新建本地文件夹', 'New local folder'),
      initial: tr('新建文件夹', 'New folder'),
      onSubmit: (value) => {
        setNameDialog(null)
        void api.fs
          .mkdir(joinPath(localPath, value))
          .then(() => loadLocal(localPath))
          .catch((error: Error) => addToast('error', error.message))
      }
    })
  }

  const localRename = (): void => {
    if (localDrives || localSelected.length !== 1) return
    const target = localSelected[0]
    setNameDialog({
      title: tr('重命名', 'Rename'),
      initial: target.name,
      onSubmit: (value) => {
        setNameDialog(null)
        void api.fs
          .rename(target.path, joinPath(localPath, value))
          .then(() => loadLocal(localPath))
          .catch((error: Error) => addToast('error', error.message))
      }
    })
  }

  const localRemove = (): void => {
    if (localDrives || localSelected.length === 0) return
    const confirmation =
      localSelected.length === 1
        ? `${tr('确定删除本地「', 'Delete local ')}"${localSelected[0].name}"${tr('」吗？', '?')}`
        : `${tr('确定删除本地选中的 ', 'Delete ')}${localSelected.length}${tr(' 项吗？', ' selected items?')}`
    if (!window.confirm(confirmation)) return
    const targets = [...localSelected]
    void (async () => {
      for (const entry of targets) {
        try {
          await api.fs.remove(entry.path, entry.type === 'directory')
        } catch (error) {
          addToast('error', (error as Error).message)
          break
        }
      }
      await loadLocal(localPath)
    })()
  }

  const remoteMkdir = (): void => {
    const runtimeId = requireRemote()
    if (!runtimeId) return
    setNameDialog({
      title: tr('新建远程文件夹', 'New remote folder'),
      initial: tr('新建文件夹', 'New folder'),
      onSubmit: (value) => {
        setNameDialog(null)
        void remote
          .mkdir(runtimeId, joinPath(remotePath, value))
          .then(() => loadRemote(remotePath))
          .catch((error: Error) => addToast('error', error.message))
      }
    })
  }

  const remoteRename = (): void => {
    const runtimeId = requireRemote()
    if (!runtimeId || remoteSelected.length !== 1) return
    const target = remoteSelected[0]
    setNameDialog({
      title: tr('重命名', 'Rename'),
      initial: target.name,
      onSubmit: (value) => {
        setNameDialog(null)
        void remote
          .rename(runtimeId, target.path, joinPath(remotePath, value))
          .then(() => loadRemote(remotePath))
          .catch((error: Error) => addToast('error', error.message))
      }
    })
  }

  const remoteRemove = (): void => {
    const runtimeId = requireRemote()
    if (!runtimeId || remoteSelected.length === 0) return
    const confirmation =
      remoteSelected.length === 1
        ? `${tr('确定删除远程「', 'Delete remote ')}"${remoteSelected[0].name}"${tr('」吗？', '?')}`
        : `${tr('确定删除远程选中的 ', 'Delete ')}${remoteSelected.length}${tr(' 项吗？', ' selected items?')}`
    if (!window.confirm(confirmation)) return
    const targets = [...remoteSelected]
    void (async () => {
      for (const entry of targets) {
        try {
          await remote.remove(runtimeId, entry.path, entry.type === 'directory')
        } catch (error) {
          addToast('error', (error as Error).message)
          break
        }
      }
      await loadRemote(remotePath)
    })()
  }

  const remoteChmod = (): void => {
    const runtimeId = requireRemote()
    if (!runtimeId || remoteSelected.length !== 1) return
    const target = remoteSelected[0]
    const selectedPath = target.path
    setNameDialog({
      title: `${tr('修改权限：', 'Change permissions: ')}${target.name}`,
      initial: (target.mode & 0o777).toString(8).padStart(3, '0'),
      onSubmit: (value) => {
        setNameDialog(null)
        const mode = parseInt(value.trim().replace(/^0o/i, ''), 8)
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
          addToast('error', tr('权限值无效，请输入 0–7777 的八进制数', 'Invalid mode, enter an octal value from 0 to 7777'))
          return
        }
        void remote
          .chmod(runtimeId, selectedPath, mode)
          .then(() => loadRemote(remotePath))
          .catch((error: Error) => addToast('error', `${tr('修改权限失败：', 'Failed to change permissions: ')}${error.message}`))
      }
    })
  }

  const localPane = (
    <div className="sftp-pane">
      <div className="sftp-pane-header">
        <span className="sftp-pane-title">
          <Icon name="server" size={14} /> {tr('本地', 'Local')}
        </span>
        <div className="sftp-toolbar">
          {isWindows ? (
            <button
              className="icon-btn"
              title={tr('我的电脑', 'This PC')}
              onClick={() => void loadDrives()}
              disabled={localLoading}
            >
              <Icon name="computer" size={14} />
            </button>
          ) : null}
          <button
            className="icon-btn"
            title={tr('上级目录', 'Parent directory')}
            onClick={localUp}
            disabled={localDrives}
          >
            <Icon name="arrow-up" size={14} />
          </button>
          <button
            className="icon-btn"
            title={tr('刷新', 'Refresh')}
            onClick={() => (localDrives ? void loadDrives() : void loadLocal(localPath))}
            disabled={localLoading}
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            className="icon-btn"
            title={tr('新建文件夹', 'New folder')}
            onClick={localMkdir}
            disabled={localDrives}
          >
            <Icon name="folder-plus" size={14} />
          </button>
          <button
            className="icon-btn"
            title={tr('重命名', 'Rename')}
            onClick={localRename}
            disabled={localDrives || localSelected.length !== 1}
          >
            <Icon name="edit" size={14} />
          </button>
          <button
            className="icon-btn"
            title={tr('删除', 'Delete')}
            onClick={localRemove}
            disabled={localDrives || localSelected.length === 0}
          >
            <Icon name="trash" size={14} />
          </button>
          <span className="sftp-toolbar-sep" />
          <button
            className="sftp-action"
            title={tr('上传选中项到远程当前目录', 'Upload selected item to the remote directory')}
            onClick={() => void uploadSelected()}
            disabled={localDrives || localSelected.length === 0 || !remoteReady || busy}
          >
            <Icon name="upload" size={14} />
            {tr('上传', 'Upload')}
          </button>
        </div>
      </div>
      <div className="sftp-path">
        <input
          value={localDraft}
          onChange={(event) => setLocalDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            if (localDrives && (!localDraft.trim() || localDraft.trim() === thisPcLabel)) {
              void loadDrives()
            } else {
              void loadLocal(localDraft)
            }
          }}
          placeholder={tr('输入本地路径', 'Enter a local path')}
          spellCheck={false}
        />
        {localLoading ? <span className="spinner small" /> : null}
      </div>
      <FileTable
        entries={localEntries}
        selected={localSelectedPaths}
        onSelect={selectLocal}
        onOpen={(entry) => {
          if (entry.type === 'directory') void loadLocal(entry.path)
          else void uploadEntries([entry])
        }}
      />
    </div>
  )

  const remotePane = (
    <div className="sftp-pane">
      <div className="sftp-pane-header">
        <span className="sftp-pane-title">
          <Icon name={protocol === 'ftp' ? 'server' : 'terminal'} size={14} />{' '}
          {tr('远程', 'Remote')}
        </span>
        <div className="sftp-toolbar">
          <button
            className="icon-btn"
            title={tr('上级目录', 'Parent directory')}
            onClick={() => void loadRemote(parentPath(remotePath))}
            disabled={!remoteReady}
          >
            <Icon name="arrow-up" size={14} />
          </button>
          <button
            className="icon-btn"
            title={tr('刷新', 'Refresh')}
            onClick={() => void loadRemote(remotePath)}
            disabled={!remoteReady || remoteLoading}
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            className="icon-btn"
            title={tr('新建文件夹', 'New folder')}
            onClick={remoteMkdir}
            disabled={!remoteReady}
          >
            <Icon name="folder-plus" size={14} />
          </button>
          <button
            className="icon-btn"
            title={tr('重命名', 'Rename')}
            onClick={remoteRename}
            disabled={!remoteReady || remoteSelected.length !== 1}
          >
            <Icon name="edit" size={14} />
          </button>
          <button
            className="icon-btn"
            title={tr('修改权限', 'Change permissions')}
            onClick={remoteChmod}
            disabled={
              !remoteReady ||
              remoteSelected.length !== 1 ||
              remoteSelected[0]?.type === 'symlink'
            }
          >
            <Icon name="settings" size={14} />
          </button>
          <button
            className="icon-btn"
            title={tr('删除', 'Delete')}
            onClick={remoteRemove}
            disabled={!remoteReady || remoteSelected.length === 0}
          >
            <Icon name="trash" size={14} />
          </button>
          <span className="sftp-toolbar-sep" />
          <button
            className="sftp-action"
            title={tr('下载选中项到本地当前目录', 'Download selected item to the local directory')}
            onClick={() => void downloadSelected()}
            disabled={localDrives || remoteSelected.length === 0 || !remoteReady || busy}
          >
            <Icon name="download" size={14} />
            {tr('下载', 'Download')}
          </button>
          {onClose ? (
            <>
              <span className="sftp-toolbar-sep" />
              <button
                className="icon-btn"
                title={tr('关闭文件传输面板', 'Close file transfer panel')}
                onClick={onClose}
              >
                <Icon name="x" size={14} />
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="sftp-path">
        <input
          value={remoteDraft}
          onChange={(event) => setRemoteDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void loadRemote(remoteDraft)
          }}
          placeholder={
            protocol === 'ftp'
              ? tr('连接 FTP 后可用', 'Available after connecting FTP')
              : tr('连接 SSH 后可用', 'Available after connecting SSH')
          }
          spellCheck={false}
          disabled={!remoteReady}
        />
        {remoteLoading ? <span className="spinner small" /> : null}
      </div>
      {remoteReady ? (
        <FileTable
          entries={remoteEntries}
          selected={remoteSelectedPaths}
          onSelect={selectRemote}
          onOpen={(entry) => {
            if (entry.type === 'directory') void loadRemote(entry.path)
            else void downloadEntries([entry])
          }}
        />
      ) : (
        <div className="sftp-empty">
          <Icon name="lock" size={22} />
          <span>
            {protocol === 'ftp'
              ? tr('连接 FTP 会话后可用', 'Available after connecting an FTP session')
              : tr('连接 SSH 会话后可用', 'Available after connecting an SSH session')}
          </span>
        </div>
      )}
    </div>
  )

  const percentValue =
    transfer && transfer.total > 0
      ? Math.min(100, (transfer.transferred / transfer.total) * 100)
      : 0
  const percentText = transfer && transfer.total > 0 ? `${Math.round(percentValue)}%` : ''
  const sizeText =
    transfer && transfer.total > 0
      ? `${formatBytes(transfer.transferred)} / ${formatBytes(transfer.total)}`
      : ''
  const speedText = transfer?.phase === 'running' ? formatSpeed(transfer.speed) : ''
  // Servers sometimes omit the size; fall back to an animated, indeterminate bar.
  const indeterminate = transfer ? transfer.total <= 0 : false

  return (
    <div className="sftp-panel">
      {activeTransfer ? (
        <div className={`sftp-transfer-bar${indeterminate ? ' indeterminate' : ''}`}>
          <div className="sftp-transfer-row">
            <span className="sftp-transfer-text">
              {transfer
                ? `${transfer.direction === 'upload' ? tr('↑ 上传', '↑ Upload') : tr('↓ 下载', '↓ Download')} ${
                    transfer.fileName || '…'
                  }`
                : tr('正在传输…', 'Transferring…')}
            </span>
            <span className="sftp-transfer-stats">
              {[sizeText, speedText, percentText].filter(Boolean).join(' · ')}
            </span>
            <button className="btn btn-ghost" onClick={cancelTransfer}>
              {tr('取消', 'Cancel')}
            </button>
          </div>
          <div
            className="sftp-transfer-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={transfer && transfer.total > 0 ? Math.round(percentValue) : undefined}
          >
            <div
              className="sftp-transfer-fill"
              style={indeterminate ? undefined : { width: `${percentValue}%` }}
            />
          </div>
        </div>
      ) : null}
      <Group orientation="horizontal" className="sftp-panel-group">
        <Panel minSize="20%">{localPane}</Panel>
        <Separator className="pane-resize-handle" />
        <Panel minSize="20%">{remotePane}</Panel>
      </Group>
      {nameDialog ? (
        <NameDialog
          title={nameDialog.title}
          initial={nameDialog.initial}
          onClose={() => setNameDialog(null)}
          onSubmit={nameDialog.onSubmit}
        />
      ) : null}
    </div>
  )
}
