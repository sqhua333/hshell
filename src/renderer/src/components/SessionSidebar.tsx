import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import type { Folder, Session } from '@shared/types'
import { sessionTarget } from '@shared/session'
import { api } from '../api'
import { tr } from '../lib/i18n'
import { isSessionDrag, readSessionDragId, setSessionDragData } from '../lib/session-drag'
import { SIDEBAR_DEFAULT_PX } from '../lib/sidebar-width'
import { useApp } from '../store'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { Modal } from './Modal'

interface MenuState {
  x: number
  y: number
  kind: 'session' | 'folder'
  session?: Session
  folder?: Folder
}

/** Where a dragged session would land if released right now. */
type DropTarget =
  | { kind: 'session'; id: string; position: 'before' | 'after' }
  | { kind: 'folder'; id: string }
  | { kind: 'root' }

export function SessionSidebar(): ReactElement {
  const folders = useApp((state) => state.folders)
  const sessions = useApp((state) => state.sessions)
  const searchFocusNonce = useApp((state) => state.searchFocusNonce)
  const openSession = useApp((state) => state.openSession)
  const openSessionDialog = useApp((state) => state.openSessionDialog)
  const deleteSession = useApp((state) => state.deleteSession)
  const deleteFolder = useApp((state) => state.deleteFolder)
  const saveSession = useApp((state) => state.saveSession)
  const moveSession = useApp((state) => state.moveSession)
  const setFolderDialogOpen = useApp((state) => state.setFolderDialogOpen)
  const reloadSessions = useApp((state) => state.reloadSessions)
  const addToast = useApp((state) => state.addToast)
  const sidebarAutoHide = useApp((state) => state.sidebarAutoHide)
  const sidebarWidth = useApp((state) => state.sidebarWidth)
  const toggleSidebarAutoHide = useApp((state) => state.toggleSidebarAutoHide)
  const setSidebarWidth = useApp((state) => state.setSidebarWidth)
  const activeSessionId = useApp((state) => {
    const tab = state.tabs.find((item) => item.id === state.activeTabId)
    return tab?.session.id ?? null
  })

  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null)
  const [passwordPrompt, setPasswordPrompt] = useState<{ message: string } | null>(null)
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [exportKeys, setExportKeys] = useState(false)
  const [exportPassword, setExportPassword] = useState('')
  const [exportConfirm, setExportConfirm] = useState('')
  const [exportError, setExportError] = useState('')
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const [resizing, setResizing] = useState(false)
  const resizeOrigin = useRef<{ x: number; width: number } | null>(null)
  const resizeCleanup = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      resizeCleanup.current?.()
      document.body.classList.remove('resizing-sidebar')
    },
    []
  )

  useEffect(() => {
    if (searchFocusNonce > 0) {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
  }, [searchFocusNonce])

  // Drags can end outside the tree (or be cancelled with Esc), and the
  // dragover handler only tracks rows it has seen, so clear on every end.
  useEffect(() => {
    const clear = (): void => setDropTarget(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? sessions.filter((session) =>
        [session.name, session.host, session.username].some((value) =>
          value.toLowerCase().includes(q)
        )
      )
    : []

  const toggleFolder = (id: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openMenuForSession = (event: ReactMouseEvent, session: Session): void => {
    event.preventDefault()
    event.stopPropagation()
    setSelectedId(session.id)
    setMenu({ x: event.clientX, y: event.clientY, kind: 'session', session })
  }

  const openMenuForFolder = (event: ReactMouseEvent, folder: Folder): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, kind: 'folder', folder })
  }

  const duplicateSession = async (session: Session): Promise<void> => {
    const now = Date.now()
    await saveSession({
      ...session,
      id: `session-${now}-${Math.random().toString(36).slice(2, 7)}`,
      name: tr(`${session.name} 副本`, `${session.name} copy`),
      createdAt: now,
      updatedAt: now
    })
  }

  /** Sessions in one folder, in the order the tree renders them. */
  const siblings = (folderId: string | null): Session[] =>
    sessions.filter((session) => session.folderId === folderId)

  /**
   * Insert the dragged session before/after `target`. "After" is expressed as
   * "before the next sibling"; the dragged session itself is never a valid
   * anchor (it is removed before the insertion point is resolved).
   */
  const dropOnSession = (event: ReactDragEvent<HTMLElement>, target: Session): void => {
    event.preventDefault()
    event.stopPropagation()
    const draggedId = readSessionDragId(event.dataTransfer)
    setDropTarget(null)
    if (!draggedId || draggedId === target.id) return
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientY > rect.top + rect.height / 2
    const list = siblings(target.folderId)
    const index = list.findIndex((item) => item.id === target.id)
    const beforeId = after ? list[index + 1]?.id ?? null : target.id
    if (beforeId === draggedId) return
    void moveSession(draggedId, target.folderId, beforeId)
  }

  const dropOnFolder = (event: ReactDragEvent<HTMLElement>, folder: Folder): void => {
    event.preventDefault()
    event.stopPropagation()
    const draggedId = readSessionDragId(event.dataTransfer)
    setDropTarget(null)
    if (!draggedId) return
    // The folder opens so the moved session is visible where it landed.
    setCollapsed((previous) => {
      if (!previous.has(folder.id)) return previous
      const next = new Set(previous)
      next.delete(folder.id)
      return next
    })
    void moveSession(draggedId, folder.id, null)
  }

  const dropOnRoot = (event: ReactDragEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const draggedId = readSessionDragId(event.dataTransfer)
    setDropTarget(null)
    if (draggedId) void moveSession(draggedId, null, null)
  }

  const resetExportDialog = (): void => {
    setExportOpen(false)
    setExportKeys(false)
    setExportPassword('')
    setExportConfirm('')
    setExportError('')
  }

  const exportSessions = async (): Promise<void> => {
    if (busy) return
    if (exportKeys) {
      if (exportPassword.length < 8) {
        setExportError(
          tr('包含私钥时口令至少需要 8 位', 'The passphrase must be at least 8 characters')
        )
        return
      }
      if (exportPassword !== exportConfirm) {
        setExportError(tr('两次输入的口令不一致', 'The passphrases do not match'))
        return
      }
    }
    setBusy(true)
    setExportError('')
    try {
      const result = await api.sessions.exportToFile(
        exportKeys ? { includeKeys: true, password: exportPassword } : undefined
      )
      if (result.canceled) return
      resetExportDialog()
      addToast(
        'info',
        tr(
          `已导出 ${result.sessions} 个会话、${result.folders} 个分组${
            result.keys ? `（含 ${result.keys} 个加密密钥）` : ''
          }`,
          `Exported ${result.sessions} sessions and ${result.folders} folders${
            result.keys ? ` (including ${result.keys} encrypted keys)` : ''
          }`
        )
      )
      if (exportKeys && !result.keys) {
        addToast(
          'warn',
          tr(
            '没有找到可读取的私钥文件，导出包中仅保留了密钥路径。',
            'No readable private key files were found; only key paths were exported.'
          )
        )
      }
    } catch (error) {
      setExportError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const importSessions = async (passphrase?: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await api.sessions.importFromFile(
        passphrase ? { password: passphrase } : undefined
      )
      if (result.canceled) return
      await reloadSessions()
      addToast(
        'info',
        tr(
          `已导入 ${result.sessions} 个会话、${result.folders} 个分组${
            result.skipped ? `，跳过 ${result.skipped} 项` : ''
          }${result.keys ? `，导入 ${result.keys} 个密钥` : ''}`,
          `Imported ${result.sessions} sessions and ${result.folders} folders${
            result.skipped ? `, skipped ${result.skipped}` : ''
          }${result.keys ? `, imported ${result.keys} keys` : ''}`
        )
      )
      setPasswordPrompt(null)
      setPassword('')
      setPasswordError('')
    } catch (error) {
      const message = (error as Error).message
      if (passphrase) {
        setPasswordError(message)
      } else if (message.includes('口令')) {
        setPasswordPrompt({ message })
        setPassword('')
        setPasswordError('')
      } else {
        addToast('error', message)
      }
    } finally {
      setBusy(false)
    }
  }

  const importSshConfig = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await api.sessions.importSshConfig()
      if (result.canceled) return
      await reloadSessions()
      addToast(
        'info',
        tr(
          `已从 SSH 配置导入 ${result.imported} 个主机${
            result.skipped ? `，跳过 ${result.skipped} 项` : ''
          }`,
          `Imported ${result.imported} hosts from the SSH config${
            result.skipped ? `, skipped ${result.skipped}` : ''
          }`
        )
      )
      if (result.warnings?.length) addToast('warn', result.warnings[0])
    } catch (error) {
      addToast('error', (error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const headerMenuItems: ContextMenuItem[] = [
    {
      label: tr('导出会话…', 'Export sessions…'),
      icon: 'download',
      onClick: () => {
        setExportError('')
        setExportOpen(true)
      }
    },
    { label: tr('导入会话…', 'Import sessions…'), icon: 'upload', onClick: () => void importSessions() },
    { label: '', separator: true },
    {
      label: tr('从 ~/.ssh/config 导入…', 'Import from ~/.ssh/config…'),
      icon: 'terminal',
      onClick: () => void importSshConfig()
    }
  ]

  const submitPassword = async (): Promise<void> => {
    if (!password) {
      setPasswordError(tr('请输入口令', 'Please enter the passphrase'))
      return
    }
    await importSessions(password)
  }

  const menuItems = (state: MenuState): ContextMenuItem[] => {
    if (state.kind === 'session' && state.session) {
      const session = state.session
      return [
        { label: tr('连接', 'Connect'), icon: 'terminal', onClick: () => openSession(session) },
        { label: tr('编辑…', 'Edit…'), icon: 'edit', onClick: () => openSessionDialog(session) },
        { label: tr('复制会话', 'Duplicate session'), icon: 'copy', onClick: () => void duplicateSession(session) },
        { label: '', separator: true },
        {
          label: tr('删除', 'Delete'),
          icon: 'trash',
          danger: true,
          onClick: () => {
            if (
              window.confirm(
                tr(`确定删除会话「${session.name}」吗？`, `Delete session "${session.name}"?`)
              )
            ) {
              void deleteSession(session.id)
            }
          }
        }
      ]
    }
    const folder = state.folder
    if (!folder) return []
    return [
      {
        label: tr('在此分组中新建会话', 'New session in this folder'),
        icon: 'plus',
        onClick: () => openSessionDialog(null, folder.id)
      },
      {
        label: tr('新建子分组', 'New subfolder'),
        icon: 'folder-plus',
        onClick: () => setFolderDialogOpen(true, folder.id)
      },
      {
        label: tr('重命名分组', 'Rename folder'),
        icon: 'edit',
        onClick: () => setFolderDialogOpen(true, null, folder.id)
      },
      { label: '', separator: true },
      {
        label: tr('删除分组', 'Delete folder'),
        icon: 'trash',
        danger: true,
        onClick: () => {
          if (
            window.confirm(
              tr(
                `确定删除分组「${folder.name}」吗？组内会话会移动到根目录。`,
                `Delete folder "${folder.name}"? Sessions inside move to the root.`
              )
            )
          ) {
            void deleteFolder(folder.id)
          }
        }
      }
    ]
  }

  const sessionRow = (session: Session, depth: number): ReactElement => (
    <div
      key={session.id}
      className={`session-row ${selectedId === session.id ? 'selected' : ''} ${
        activeSessionId === session.id ? 'active' : ''
      } ${
        dropTarget?.kind === 'session' && dropTarget.id === session.id
          ? `drop-${dropTarget.position}`
          : ''
      }`}
      style={{ paddingLeft: 28 + depth * 14 }}
      title={tr(
        `${sessionTarget(session)}（拖到终端分屏；拖到列表可排序或移入分组）`,
        `${sessionTarget(session)} (drag onto a terminal to split, or within the list to reorder)`
      )}
      tabIndex={0}
      // Dragging a session onto a pane opens it there, which is how an SSH
      // session and a serial session end up side by side. Dropping it back on
      // the list reorders it or moves it into another folder.
      draggable
      data-session-id={session.id}
      onDragStart={(event) => setSessionDragData(event.dataTransfer, session.id)}
      onDragOver={(event) => {
        if (!isSessionDrag(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        const position = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
        setDropTarget((previous) =>
          previous?.kind === 'session' &&
          previous.id === session.id &&
          previous.position === position
            ? previous
            : { kind: 'session', id: session.id, position }
        )
      }}
      onDragLeave={(event) => {
        if (!isSessionDrag(event.dataTransfer)) return
        const related = event.relatedTarget as Node | null
        if (related && event.currentTarget.contains(related)) return
        setDropTarget((previous) =>
          previous?.kind === 'session' && previous.id === session.id ? null : previous
        )
      }}
      onDrop={(event) => dropOnSession(event, session)}
      onClick={() => setSelectedId(session.id)}
      onDoubleClick={() => openSession(session)}
      onContextMenu={(event) => openMenuForSession(event, session)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') openSession(session)
      }}
    >
      <span
        className="session-color"
        style={{ background: session.color || 'var(--accent)' }}
      />
      <span className="session-name">{session.name}</span>
      <span className="session-host">{sessionTarget(session)}</span>
    </div>
  )

  const folderNode = (folder: Folder, depth: number): ReactElement => {
    const isCollapsed = collapsed.has(folder.id)
    const childFolders = folders
      .filter((item) => item.parentId === folder.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    const childSessions = sessions.filter((session) => session.folderId === folder.id)
    return (
      <div key={folder.id}>
        <div
          className={`tree-folder ${
            dropTarget?.kind === 'folder' && dropTarget.id === folder.id ? 'drop-inside' : ''
          }`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => toggleFolder(folder.id)}
          onContextMenu={(event) => openMenuForFolder(event, folder)}
          onDragOver={(event) => {
            if (!isSessionDrag(event.dataTransfer)) return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'move'
            setDropTarget((previous) =>
              previous?.kind === 'folder' && previous.id === folder.id
                ? previous
                : { kind: 'folder', id: folder.id }
            )
          }}
          onDragLeave={(event) => {
            if (!isSessionDrag(event.dataTransfer)) return
            const related = event.relatedTarget as Node | null
            if (related && event.currentTarget.contains(related)) return
            setDropTarget((previous) =>
              previous?.kind === 'folder' && previous.id === folder.id ? null : previous
            )
          }}
          onDrop={(event) => dropOnFolder(event, folder)}
        >
          <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={13} />
          <Icon name={isCollapsed ? 'folder' : 'folder-open'} size={15} />
          <span className="tree-name">{folder.name}</span>
          <span className="tree-count">{childSessions.length}</span>
        </div>
        {!isCollapsed ? (
          <>
            {childFolders.map((child) => folderNode(child, depth + 1))}
            {childSessions.map((session) => sessionRow(session, depth + 1))}
          </>
        ) : null}
      </div>
    )
  }

  const rootFolders = folders
    .filter((folder) => folder.parentId === null)
    .sort((a, b) => a.sortOrder - b.sortOrder)
  const rootSessions = sessions.filter((session) => session.folderId === null)

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (sidebarAutoHide) return
    event.preventDefault()
    resizeOrigin.current = { x: event.clientX, width: sidebarWidth }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* window listeners below still track the drag */
    }
    setResizing(true)
    document.body.classList.add('resizing-sidebar')

    // Attach the drag listeners synchronously: pointer capture is not reliable
    // for every input source, and the cursor leaves the 6px handle immediately.
    resizeCleanup.current?.()
    function move(moveEvent: PointerEvent): void {
      const origin = resizeOrigin.current
      if (!origin) return
      setSidebarWidth(origin.width + moveEvent.clientX - origin.x)
    }
    function end(): void {
      resizeOrigin.current = null
      setResizing(false)
      document.body.classList.remove('resizing-sidebar')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      resizeCleanup.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    resizeCleanup.current = end
  }

  return (
    <aside
      className={`sidebar ${sidebarAutoHide ? 'auto-hide' : ''} ${resizing ? 'resizing' : ''}`}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={tr('调整会话管理器宽度', 'Resize session manager')}
        title={tr('拖动调整宽度，双击恢复默认', 'Drag to resize, double-click to reset')}
        onPointerDown={startResize}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_PX)}
      />
      <div className="sidebar-header">
        <span className="sidebar-title">{tr('会话管理器', 'Session Manager')}</span>
        <div className="sidebar-header-actions">
          <button
            className={`icon-btn ${sidebarAutoHide ? 'active' : ''}`}
            title={
              sidebarAutoHide
                ? tr('取消自动隐藏', 'Disable auto-hide')
                : tr('自动隐藏会话管理器', 'Auto-hide session manager')
            }
            onClick={toggleSidebarAutoHide}
          >
            <Icon name="pin" size={15} />
          </button>
          <button
            className="icon-btn"
            title={tr('新建分组', 'New folder')}
            onClick={() => setFolderDialogOpen(true, null)}
          >
            <Icon name="folder-plus" size={15} />
          </button>
          <button
            className="icon-btn"
            title={tr('新建会话 (Ctrl+N)', 'New session (Ctrl+N)')}
            onClick={() => openSessionDialog(null)}
          >
            <Icon name="plus" size={15} />
          </button>
          <button
            className="icon-btn"
            title={tr('导入 / 导出', 'Import / Export')}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setHeaderMenu({ x: rect.left, y: rect.bottom + 4 })
            }}
          >
            <Icon name="more-horizontal" size={15} />
          </button>
        </div>
      </div>

      <div className="sidebar-search">
        <Icon name="search" size={14} />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tr('搜索会话（Ctrl+O）', 'Search sessions (Ctrl+O)')}
          spellCheck={false}
        />
        {query ? (
          <button className="icon-btn mini" title={tr('清空', 'Clear')} onClick={() => setQuery('')}>
            <Icon name="x" size={12} />
          </button>
        ) : null}
      </div>

      <div
        className={`session-tree ${dropTarget?.kind === 'root' ? 'drop-root' : ''}`}
        onDragOver={(event) => {
          if (!isSessionDrag(event.dataTransfer)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropTarget((previous) => (previous?.kind === 'root' ? previous : { kind: 'root' }))
        }}
        onDragLeave={(event) => {
          if (!isSessionDrag(event.dataTransfer)) return
          const related = event.relatedTarget as Node | null
          if (related && event.currentTarget.contains(related)) return
          setDropTarget((previous) => (previous?.kind === 'root' ? null : previous))
        }}
        onDrop={dropOnRoot}
      >
        {q ? (
          filtered.length ? (
            <>
              <div className="tree-section-label">{tr('搜索结果', 'Results')} · {filtered.length}</div>
              {filtered.map((session) => sessionRow(session, 0))}
            </>
          ) : (
            <div className="tree-empty">{tr('没有匹配的会话', 'No matching sessions')}</div>
          )
        ) : (
          <>
            {rootSessions.map((session) => sessionRow(session, 0))}
            {rootFolders.map((folder) => folderNode(folder, 0))}
            {folders.length === 0 && sessions.length === 0 ? (
              <div className="tree-empty">
                {tr('还没有会话', 'No sessions yet')}
                <br />
                {tr('点击下方按钮或 Ctrl+N 新建', 'Click the button below or press Ctrl+N')}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <button className="new-session-btn" onClick={() => openSessionDialog(null)}>
          <Icon name="plus" size={14} />
          <span>{tr('新建会话', 'New session')}</span>
        </button>
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {headerMenu ? (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          items={headerMenuItems}
          onClose={() => setHeaderMenu(null)}
        />
      ) : null}

      {exportOpen ? (
        <Modal
          title={tr('导出会话', 'Export sessions')}
          subtitle={tr(
            '会话与分组将以 JSON 保存；默认不包含密码与私钥。',
            'Sessions and folders are saved as JSON; passwords and private keys are excluded by default.'
          )}
          width={460}
          onClose={() => {
            if (!busy) resetExportDialog()
          }}
          footer={
            <>
              {exportError ? <div className="form-error">{exportError}</div> : <div />}
              <div className="modal-actions">
                <button className="btn" disabled={busy} onClick={resetExportDialog}>
                  {tr('取消', 'Cancel')}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void exportSessions()}
                >
                  {tr('导出…', 'Export…')}
                </button>
              </div>
            </>
          }
        >
          <label className="check-row">
            <input
              type="checkbox"
              checked={exportKeys}
              onChange={(event) => {
                setExportKeys(event.target.checked)
                setExportError('')
              }}
            />
            <span>{tr('包含私钥文件（使用口令加密）', 'Include private key files (encrypted with a passphrase)')}</span>
          </label>
          {exportKeys ? (
            <>
              <div className="form-grid">
                <label className="field">
                  <span>{tr('加密口令', 'Passphrase')}</span>
                  <input
                    className="input"
                    type="password"
                    value={exportPassword}
                    autoFocus
                    onChange={(event) => setExportPassword(event.target.value)}
                    placeholder={tr('至少 8 位', 'At least 8 characters')}
                  />
                </label>
                <label className="field">
                  <span>{tr('确认口令', 'Confirm passphrase')}</span>
                  <input
                    className="input"
                    type="password"
                    value={exportConfirm}
                    onChange={(event) => setExportConfirm(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void exportSessions()
                    }}
                  />
                </label>
              </div>
              <p className="form-hint">
                {tr(
                  '仅包含会话中以文件路径引用且可读取的私钥，保险库密钥不会导出。口令无法找回，导入时需要输入同一口令。',
                  'Only readable private keys referenced by file path are included; vault keys are not exported. The passphrase cannot be recovered and is required when importing.'
                )}
              </p>
            </>
          ) : (
            <p className="form-hint">
              {tr(
                '导出文件中的密码字段会被移除。若还需携带私钥，请勾选上方选项。',
                'Password fields are removed from the exported file. Check the option above to include private keys.'
              )}
            </p>
          )}
        </Modal>
      ) : null}

      {passwordPrompt ? (
        <Modal
          title={tr('导入加密会话', 'Import encrypted sessions')}
          subtitle={passwordPrompt.message}
          width={420}
          onClose={() => setPasswordPrompt(null)}
          footer={
            <>
              {passwordError ? <div className="form-error">{passwordError}</div> : <div />}
              <div className="modal-actions">
                <button className="btn" onClick={() => setPasswordPrompt(null)}>
                  {tr('取消', 'Cancel')}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void submitPassword()}
                >
                  {tr('继续导入', 'Continue import')}
                </button>
              </div>
            </>
          }
        >
          <label className="field">
            <span>{tr('导出时使用的口令', 'Passphrase used when exporting')}</span>
            <input
              className="input"
              type="password"
              value={password}
              autoFocus
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitPassword()
              }}
              placeholder={tr('用于解密导出文件中的私钥', 'Used to decrypt private keys in the export')}
            />
          </label>
          <p className="form-hint">{tr('确认后将再次打开文件选择框。', 'The file picker opens again after you confirm.')}</p>
        </Modal>
      ) : null}
    </aside>
  )
}
