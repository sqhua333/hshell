import { create } from 'zustand'
import type {
  Folder,
  HostKeyPrompt,
  KeyboardPrompt,
  RuntimeStatus,
  Session,
  SftpProgressEvent,
  SplitDirection,
  SshStatus,
  TunnelInfo,
  ZmodemPhase,
  ZmodemStatusEvent
} from '@shared/types'
import { api } from './api'
import { applyLocale, getLocale, tr, type Locale } from './lib/i18n'
import { buildLayout, restoreLayout } from './lib/layout'
import {
  collectPanes,
  paneNode,
  removePane,
  setSplitSizes,
  splitAt,
  type LayoutNode,
  type PaneState,
  type SplitSide
} from './lib/pane-layout'
import { generateReplayScript, recorder, replayFileName } from './lib/recorder'

export type { LayoutNode, PaneNode, PaneState, SplitNode } from './lib/pane-layout'

export interface TabState {
  id: string
  session: Session
  /** Flattened panes in layout order (kept in sync with `layout`). */
  panes: PaneState[]
  layout: LayoutNode
}

export interface Toast {
  id: string
  level: 'info' | 'warn' | 'error'
  message: string
}

export type SessionDialogTab =
  | 'connection'
  | 'auth'
  | 'terminal'
  | 'advanced'
  | 'automation'

export interface SessionDialogState {
  open: boolean
  initial: Session | null
  presetFolderId: string | null
  initialTab: SessionDialogTab
}

export interface ZmodemProgress {
  phase: ZmodemPhase
  direction?: 'download' | 'upload'
  fileName?: string
  transferred: number
  total: number
  message?: string
}

export interface SftpTransferProgress {
  transferId: string
  direction: 'download' | 'upload'
  phase: SftpProgressEvent['phase']
  fileName: string
  transferred: number
  total: number
  message?: string
}

interface AppState {
  ready: boolean
  folders: Folder[]
  sessions: Session[]
  tabs: TabState[]
  activeTabId: string | null
  activeRuntimeId: string | null
  statuses: Record<string, RuntimeStatus>
  zmodem: Record<string, ZmodemProgress>
  transfers: Record<string, SftpTransferProgress>
  tunnels: Record<string, TunnelInfo[]>
  lastSessionId: string | null

  sidebarVisible: boolean
  sidebarAutoHide: boolean
  sftpVisible: boolean
  searchVisible: boolean
  searchFocusNonce: number
  uiTheme: 'light' | 'dark'
  fontSize: number
  quickBarAutoHide: boolean
  composeOpen: boolean
  composeFocusNonce: number
  recordingRuntimeId: string | null
  recordingStartedAt: number | null

  toasts: Toast[]
  hostKey: (HostKeyPrompt & { runtimeId: string }) | null
  keyboard: (KeyboardPrompt & { runtimeId: string }) | null

  sessionDialog: SessionDialogState
  shortcutsHelp: boolean
  aboutOpen: boolean
  folderDialogOpen: boolean
  folderParentId: string | null
  keysOpen: boolean
  tunnelsOpen: boolean
  appVersion: string
  defaultUsername: string
  locale: Locale

  init(): Promise<void>
  reloadSessions(): Promise<void>
  openSession(session: Session): void
  closeTab(tabId: string): void
  activateTab(tabId: string): void
  nextTab(delta: number): void
  selectTabIndex(index: number): void
  splitActive(direction: SplitDirection): void
  splitPaneWithSession(
    tabId: string,
    targetPaneId: string,
    sessionId: string,
    direction: SplitDirection,
    side?: SplitSide
  ): void
  setTabSizes(tabId: string, splitId: string, sizes: number[]): void
  closePane(tabId: string, paneId: string): void
  setActiveRuntime(runtimeId: string): void
  setStatus(runtimeId: string, status: SshStatus, message?: string): void
  setRuntimeSize(runtimeId: string, cols: number, rows: number): void
  setZmodemStatus(runtimeId: string, update: ZmodemStatusEvent): void
  setTransferProgress(runtimeId: string, update: SftpProgressEvent): void
  clearTransfer(runtimeId: string, transferId: string): void
  setTunnels(runtimeId: string, tunnels: TunnelInfo[]): void
  applyTunnelStatus(info: TunnelInfo): void

  addToast(level: Toast['level'], message: string): void
  removeToast(id: string): void

  setHostKey(value: (HostKeyPrompt & { runtimeId: string }) | null): void
  setKeyboard(value: (KeyboardPrompt & { runtimeId: string }) | null): void

  toggleSidebar(): void
  toggleSidebarAutoHide(): void
  toggleSftp(): void
  setSearchVisible(visible: boolean): void
  focusSearch(): void
  toggleUiTheme(): void
  setFontSize(size: number): void
  setLocale(locale: Locale): void
  toggleQuickBarAutoHide(): void
  toggleCompose(): void
  setComposeOpen(open: boolean): void
  startRecording(runtimeId: string): void
  stopRecording(): Promise<void>
  cancelRecording(message?: string): void

  openSessionDialog(
    initial: Session | null,
    presetFolderId?: string | null,
    initialTab?: SessionDialogTab
  ): void
  closeSessionDialog(): void
  saveSession(session: Session): Promise<void>
  deleteSession(id: string): Promise<void>
  deleteFolder(id: string): Promise<void>
  createFolder(name: string, parentId: string | null): Promise<void>
  setShortcutsHelp(open: boolean): void

  setFolderDialogOpen(open: boolean, parentId?: string | null): void
  setAboutOpen(open: boolean): void
  setKeysOpen(open: boolean): void
  setTunnelsOpen(open: boolean): void
}

function uid(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}-${random}`
}

function readTheme(): 'light' | 'dark' {
  try {
    return localStorage.getItem('hshell.uiTheme') === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function readFontSize(): number {
  try {
    const value = Number(localStorage.getItem('hshell.fontSize'))
    return Number.isFinite(value) && value >= 8 && value <= 40 ? value : 14
  } catch {
    return 14
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function sessionForRuntime(runtimeId: string, state: AppState): Session | null {
  const tab = state.tabs.find((item) => item.panes.some((pane) => pane.runtimeId === runtimeId))
  if (!tab) return null
  const pane = tab.panes.find((item) => item.runtimeId === runtimeId)
  return state.sessions.find((item) => item.id === pane?.sessionId) ?? tab.session
}

const HOME_SESSION_ID = 's-local'

let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleLayoutSave(get: () => AppState): void {
  if (typeof window === 'undefined') return
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer)
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = null
    const state = get()
    void api.layouts.save(buildLayout(state.tabs, state.activeTabId)).catch(() => {
      /* layout persistence is best-effort */
    })
  }, 200)
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  folders: [],
  sessions: [],
  tabs: [],
  activeTabId: null,
  activeRuntimeId: null,
  statuses: {},
  zmodem: {},
  transfers: {},
  tunnels: {},
  lastSessionId: null,
  sidebarVisible: true,
  sidebarAutoHide: readFlag('hshell.sidebarAutoHide', false),
  sftpVisible: false,
  searchVisible: false,
  searchFocusNonce: 0,
  uiTheme: readTheme(),
  fontSize: readFontSize(),
  quickBarAutoHide: readFlag('hshell.quickBarAutoHide', false),
  composeOpen: false,
  composeFocusNonce: 0,
  recordingRuntimeId: null,
  recordingStartedAt: null,
  toasts: [],
  hostKey: null,
  keyboard: null,
  sessionDialog: { open: false, initial: null, presetFolderId: null, initialTab: 'connection' },
  shortcutsHelp: false,
  aboutOpen: false,
  folderDialogOpen: false,
  folderParentId: null,
  keysOpen: false,
  tunnelsOpen: false,
  appVersion: '0.1.0',
  defaultUsername: 'root',
  locale: getLocale(),

  async init() {
    applyLocale(getLocale())
    void api.app.setLocale(getLocale()).catch(() => {
      /* browser mock */
    })
    const [info, data, savedLayout] = await Promise.all([
      api.app.info(),
      api.sessions.list(),
      api.layouts.get().catch(() => ({ tabs: [], activeIndex: 0 }))
    ])
    const restored = restoreLayout(savedLayout, data.sessions, (sessionId) => ({
      id: uid('pane'),
      runtimeId: uid('rt'),
      sessionId,
      autoConnect: false
    }))
    const tabs: TabState[] = restored.tabs.map((item) => ({
      id: uid('tab'),
      session: { ...item.session, auth: { ...item.session.auth } },
      layout: item.layout,
      panes: collectPanes(item.layout)
    }))
    const activeTab = tabs[restored.activeIndex] ?? null
    const statuses: Record<string, RuntimeStatus> = {}
    for (const tab of tabs) {
      for (const pane of tab.panes) statuses[pane.runtimeId] = { status: 'idle' }
    }
    set({
      ready: true,
      appVersion: info.version,
      defaultUsername: info.username || 'root',
      folders: data.folders,
      sessions: data.sessions,
      tabs,
      activeTabId: activeTab?.id ?? null,
      activeRuntimeId: activeTab?.panes[0]?.runtimeId ?? null,
      statuses,
      lastSessionId: data.sessions.some((s) => s.id === HOME_SESSION_ID)
        ? HOME_SESSION_ID
        : data.sessions[0]?.id ?? null
    })
  },

  async reloadSessions() {
    const data = await api.sessions.list()
    set({ folders: data.folders, sessions: data.sessions })
  },

  openSession(session) {
    const pane: PaneState = {
      id: uid('pane'),
      runtimeId: uid('rt'),
      sessionId: session.id,
      autoConnect: true
    }
    const tab: TabState = {
      id: uid('tab'),
      session: { ...session, auth: { ...session.auth } },
      panes: [pane],
      layout: paneNode(pane)
    }
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      activeRuntimeId: pane.runtimeId,
      lastSessionId: session.id,
      statuses: { ...state.statuses, [pane.runtimeId]: { status: 'connecting' } }
    }))
    scheduleLayoutSave(get)
  },

  closeTab(tabId) {
    const state = get()
    const tab = state.tabs.find((item) => item.id === tabId)
    if (!tab) return
    if (tab.panes.some((pane) => pane.runtimeId === state.recordingRuntimeId)) {
      get().cancelRecording(tr('会话已关闭，录制已停止', 'Session closed; recording stopped'))
    }
    tab.panes.forEach((pane) => void api.ssh.disconnect(pane.runtimeId))
    const index = state.tabs.findIndex((item) => item.id === tabId)
    const tabs = state.tabs.filter((item) => item.id !== tabId)
    let activeTabId = state.activeTabId
    let activeRuntimeId = state.activeRuntimeId
    if (state.activeTabId === tabId) {
      const next = tabs[Math.min(index, tabs.length - 1)] ?? null
      activeTabId = next?.id ?? null
      activeRuntimeId = next?.panes[0]?.runtimeId ?? null
    }
    set({ tabs, activeTabId, activeRuntimeId })
    scheduleLayoutSave(get)
  },

  activateTab(tabId) {
    const tab = get().tabs.find((item) => item.id === tabId)
    if (!tab) return
    const activeRuntimeId =
      tab.panes.find((pane) => pane.runtimeId === get().activeRuntimeId)?.runtimeId ??
      tab.panes[0]?.runtimeId ??
      null
    set({ activeTabId: tabId, activeRuntimeId })
    scheduleLayoutSave(get)
  },

  nextTab(delta) {
    const { tabs, activeTabId } = get()
    if (tabs.length === 0) return
    const index = tabs.findIndex((tab) => tab.id === activeTabId)
    const next = (index + delta + tabs.length) % tabs.length
    get().activateTab(tabs[next].id)
  },

  selectTabIndex(index) {
    const tab = get().tabs[index]
    if (tab) get().activateTab(tab.id)
  },

  splitActive(direction) {
    const state = get()
    const tab = state.tabs.find((item) => item.id === state.activeTabId)
    if (!tab) return
    // Only the focused pane is divided; every other pane keeps its size.
    const activePane =
      tab.panes.find((item) => item.runtimeId === state.activeRuntimeId) ?? tab.panes[0]
    if (!activePane) return
    const pane: PaneState = {
      id: uid('pane'),
      runtimeId: uid('rt'),
      sessionId: activePane.sessionId,
      autoConnect: true
    }
    const layout = splitAt(tab.layout, activePane.id, pane, direction)
    if (!layout) return
    set({
      tabs: state.tabs.map((item) =>
        item.id === tab.id
          ? { ...item, layout, panes: collectPanes(layout) }
          : item
      ),
      activeRuntimeId: pane.runtimeId,
      statuses: { ...state.statuses, [pane.runtimeId]: { status: 'connecting' } }
    })
    scheduleLayoutSave(get)
  },

  splitPaneWithSession(tabId, targetPaneId, sessionId, direction, side = 'after') {
    const state = get()
    const tab = state.tabs.find((item) => item.id === tabId)
    const session = state.sessions.find((item) => item.id === sessionId)
    if (!tab || !session) return
    const pane: PaneState = {
      id: uid('pane'),
      runtimeId: uid('rt'),
      sessionId: session.id,
      autoConnect: true
    }
    const layout = splitAt(tab.layout, targetPaneId, pane, direction, side)
    if (!layout) return
    set({
      tabs: state.tabs.map((item) =>
        item.id === tab.id ? { ...item, layout, panes: collectPanes(layout) } : item
      ),
      activeTabId: tab.id,
      activeRuntimeId: pane.runtimeId,
      lastSessionId: session.id,
      statuses: { ...state.statuses, [pane.runtimeId]: { status: 'connecting' } }
    })
    scheduleLayoutSave(get)
  },

  setTabSizes(tabId, splitId, sizes) {
    const state = get()
    const tab = state.tabs.find((item) => item.id === tabId)
    if (!tab) return
    const layout = setSplitSizes(tab.layout, splitId, sizes)
    if (layout === tab.layout) return
    set({
      tabs: state.tabs.map((item) => (item.id === tabId ? { ...item, layout } : item))
    })
    scheduleLayoutSave(get)
  },

  closePane(tabId, paneId) {
    const state = get()
    const tab = state.tabs.find((item) => item.id === tabId)
    if (!tab) return
    const pane = tab.panes.find((item) => item.id === paneId)
    if (pane && pane.runtimeId === state.recordingRuntimeId) {
      get().cancelRecording(tr('分屏已关闭，录制已停止', 'Pane closed; recording stopped'))
    }
    if (pane) void api.ssh.disconnect(pane.runtimeId)
    if (tab.panes.length <= 1) {
      get().closeTab(tabId)
      return
    }
    const result = removePane(tab.layout, paneId)
    const layout = result.layout
    if (!layout) {
      get().closeTab(tabId)
      return
    }
    const panes = collectPanes(layout)
    set({
      tabs: state.tabs.map((item) =>
        item.id === tabId ? { ...item, layout, panes } : item
      ),
      activeRuntimeId:
        state.activeRuntimeId === pane?.runtimeId ? panes[0]?.runtimeId ?? null : state.activeRuntimeId
    })
    scheduleLayoutSave(get)
  },

  setActiveRuntime(runtimeId) {
    set({ activeRuntimeId: runtimeId })
  },

  setStatus(runtimeId, status, message) {
    set((state) => ({
      statuses: { ...state.statuses, [runtimeId]: { ...state.statuses[runtimeId], status, message } }
    }))
  },

  setRuntimeSize(runtimeId, cols, rows) {
    set((state) => ({
      statuses: { ...state.statuses, [runtimeId]: { ...state.statuses[runtimeId], cols, rows } }
    }))
  },

  setZmodemStatus(runtimeId, update) {
    set((state) => ({
      zmodem: {
        ...state.zmodem,
        [runtimeId]: {
          phase: update.phase,
          direction: update.direction,
          fileName: update.fileName,
          transferred: update.transferred ?? 0,
          total: update.total ?? 0,
          message: update.message
        }
      }
    }))
    if (update.phase === 'complete' || update.phase === 'cancelled' || update.phase === 'error') {
      const phase = update.phase
      setTimeout(() => {
        set((state) => {
          if (state.zmodem[runtimeId]?.phase !== phase) return state
          const zmodem = { ...state.zmodem }
          delete zmodem[runtimeId]
          return { zmodem }
        })
      }, 4000)
    }
  },

  setTransferProgress(runtimeId, update) {
    set((state) => {
      const previous = state.transfers[runtimeId]
      const fileName = update.fileName || (previous?.transferId === update.transferId ? previous.fileName : '')
      return {
        transfers: {
          ...state.transfers,
          [runtimeId]: {
            transferId: update.transferId,
            direction: update.direction,
            phase: update.phase,
            fileName,
            transferred: update.transferred,
            total: update.total,
            message: update.message
          }
        }
      }
    })
    if (update.phase === 'complete' || update.phase === 'cancelled' || update.phase === 'error') {
      const transferId = update.transferId
      setTimeout(() => get().clearTransfer(runtimeId, transferId), 5000)
    }
  },

  clearTransfer(runtimeId, transferId) {
    set((state) => {
      if (state.transfers[runtimeId]?.transferId !== transferId) return state
      const transfers = { ...state.transfers }
      delete transfers[runtimeId]
      return { transfers }
    })
  },

  setTunnels(runtimeId, tunnels) {
    set((state) => ({ tunnels: { ...state.tunnels, [runtimeId]: tunnels } }))
  },

  applyTunnelStatus(info) {
    set((state) => {
      const current = state.tunnels[info.runtimeId] ?? []
      const without = current.filter((item) => item.id !== info.id)
      const next =
        info.phase === 'stopped' ? without : [...without, { ...info }].sort((a, b) => a.bindPort - b.bindPort)
      return { tunnels: { ...state.tunnels, [info.runtimeId]: next } }
    })
  },

  addToast(level, message) {
    const toast = { id: uid('toast'), level, message }
    set((state) => ({ toasts: [...state.toasts, toast] }))
    setTimeout(() => get().removeToast(toast.id), 5000)
  },

  removeToast(id) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },

  setHostKey(value) {
    set({ hostKey: value })
  },

  setKeyboard(value) {
    set({ keyboard: value })
  },

  toggleSidebar() {
    set((state) => ({ sidebarVisible: !state.sidebarVisible }))
  },

  toggleSidebarAutoHide() {
    const next = !get().sidebarAutoHide
    writeFlag('hshell.sidebarAutoHide', next)
    set({ sidebarAutoHide: next })
  },

  toggleSftp() {
    set((state) => ({ sftpVisible: !state.sftpVisible }))
  },

  setSearchVisible(visible) {
    set({ searchVisible: visible })
  },

  focusSearch() {
    set((state) => ({ sidebarVisible: true, searchFocusNonce: state.searchFocusNonce + 1 }))
  },

  toggleUiTheme() {
    const next = get().uiTheme === 'light' ? 'dark' : 'light'
    set({ uiTheme: next })
    try {
      localStorage.setItem('hshell.uiTheme', next)
    } catch {
      /* ignore */
    }
  },

  setLocale(locale) {
    applyLocale(locale)
    set({ locale })
    void api.app.setLocale(locale).catch(() => undefined)
  },

  setFontSize(size) {
    const clamped = Math.max(8, Math.min(40, size))
    set({ fontSize: clamped })
    try {
      localStorage.setItem('hshell.fontSize', String(clamped))
    } catch {
      /* ignore */
    }
  },

  toggleQuickBarAutoHide() {
    const next = !get().quickBarAutoHide
    writeFlag('hshell.quickBarAutoHide', next)
    set({ quickBarAutoHide: next })
  },

  toggleCompose() {
    const state = get()
    if (!state.activeTabId) return
    const open = !state.composeOpen
    set({ composeOpen: open, composeFocusNonce: open ? state.composeFocusNonce + 1 : state.composeFocusNonce })
  },

  setComposeOpen(open) {
    set((state) => ({
      composeOpen: open,
      composeFocusNonce: open ? state.composeFocusNonce + 1 : state.composeFocusNonce
    }))
  },

  startRecording(runtimeId) {
    const state = get()
    if (recorder.active) {
      state.addToast('warn', tr('已有录制正在进行', 'A recording is already in progress'))
      return
    }
    const session = sessionForRuntime(runtimeId, state)
    if (!session) return
    recorder.start(runtimeId, session)
    set({ recordingRuntimeId: runtimeId, recordingStartedAt: Date.now() })
    state.addToast('info', tr('开始录制终端操作', 'Started recording terminal input and output'))
  },

  async stopRecording() {
    const recording = recorder.stop()
    set({ recordingRuntimeId: null, recordingStartedAt: null })
    if (!recording) return
    const inputs = recording.events.filter((event) => event.direction === 'in' && event.data.length > 0)
    if (inputs.length === 0) {
      get().addToast('warn', tr('没有可保存的输入，录制已丢弃', 'No input was captured; recording discarded'))
      return
    }
    try {
      const saved = await api.recording.saveScript(
        generateReplayScript(recording),
        replayFileName(recording.session)
      )
      if (saved.canceled) {
        get().addToast('warn', tr('录制未保存', 'Recording not saved'))
      } else {
        get().addToast(
          'info',
          tr(`回放脚本已保存：${saved.filePath}`, `Replay script saved: ${saved.filePath}`)
        )
      }
    } catch (error) {
      get().addToast('error', tr(`保存脚本失败：${(error as Error).message}`, `Could not save script: ${(error as Error).message}`))
    }
  },

  cancelRecording(message) {
    recorder.stop()
    if (!get().recordingRuntimeId) return
    set({ recordingRuntimeId: null, recordingStartedAt: null })
    if (message) get().addToast('warn', message)
  },

  openSessionDialog(initial, presetFolderId = null, initialTab = 'connection') {
    set({ sessionDialog: { open: true, initial, presetFolderId, initialTab } })
  },

  closeSessionDialog() {
    set({
      sessionDialog: { open: false, initial: null, presetFolderId: null, initialTab: 'connection' }
    })
  },

  async saveSession(session) {
    const saved = await api.sessions.save(session)
    await get().reloadSessions()
    set((state) => ({
      lastSessionId: saved.id,
      tabs: state.tabs.map((tab) =>
        tab.session.id === saved.id
          ? { ...tab, session: { ...saved, auth: { ...saved.auth } } }
          : tab
      )
    }))
    get().addToast(
      'info',
      tr(`会话「${saved.name}」已保存`, `Session "${saved.name}" saved`)
    )
  },

  async deleteSession(id) {
    await api.sessions.remove(id)
    await get().reloadSessions()
    get().addToast('info', tr('会话已删除', 'Session deleted'))
  },

  async deleteFolder(id) {
    try {
      await api.sessions.removeFolder(id)
      await get().reloadSessions()
      get().addToast('info', tr('分组已删除', 'Folder deleted'))
    } catch (error) {
      get().addToast('error', (error as Error).message)
    }
  },

  async createFolder(name, parentId) {
    const folder: Folder = {
      id: uid('folder'),
      name,
      parentId,
      sortOrder: get().folders.length
    }
    await api.sessions.saveFolder(folder)
    await get().reloadSessions()
    get().addToast('info', tr(`分组「${name}」已创建`, `Folder "${name}" created`))
  },

  setShortcutsHelp(open) {
    set({ shortcutsHelp: open })
  },

  setFolderDialogOpen(open, parentId = null) {
    set({ folderDialogOpen: open, folderParentId: open ? parentId : null })
  },

  setAboutOpen(open) {
    set({ aboutOpen: open })
  },

  setKeysOpen(open) {
    set({ keysOpen: open })
  },

  setTunnelsOpen(open) {
    set({ tunnelsOpen: open })
  }
}))
