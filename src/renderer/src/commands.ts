import type { Session } from '@shared/types'
import { isNonSshSession } from '@shared/session'
import { api } from './api'
import { tr } from './lib/i18n'
import { getTerminal } from './lib/terminal-registry'
import { parseQuickConnect } from './lib/quick-connect'
import type { ShortcutAction } from './lib/shortcuts'
import { sessionForRuntime, useApp } from './store'

export { parseQuickConnect }

export function quickConnect(input: string): void {
  const state = useApp.getState()
  const parsed = parseQuickConnect(input, state.defaultUsername)
  if (!parsed) {
    state.addToast('warn', tr('请输入「用户@主机:端口」格式的连接地址', 'Enter an address in the form user@host:port'))
    return
  }
  const now = Date.now()
  const session: Session = {
    id: `quick-${now}`,
    name: `${parsed.username}@${parsed.host}`,
    folderId: null,
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    auth: { method: 'agent' },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: state.fontSize },
    createdAt: now,
    updatedAt: now
  }
  state.openSession(session)
}

export async function reconnectActive(): Promise<void> {
  const state = useApp.getState()
  const tab = state.tabs.find((item) => item.id === state.activeTabId)
  if (!tab) return
  const pane =
    tab.panes.find((item) => item.runtimeId === state.activeRuntimeId) ?? tab.panes[0]
  if (!pane) return
  // Split panes may hold different sessions (e.g. SSH + serial + local), so
  // reconnect the pane's own session rather than the tab's primary one.
  const session = sessionForRuntime(pane.runtimeId, state) ?? tab.session
  const handle = getTerminal(pane.runtimeId)
  const cols = handle?.terminal.cols || 80
  const rows = handle?.terminal.rows || 24
  await api.ssh.disconnect(pane.runtimeId)
  state.setStatus(pane.runtimeId, 'connecting')
  try {
    await api.ssh.connect({ runtimeId: pane.runtimeId, session, cols, rows })
  } catch (error) {
    state.setStatus(pane.runtimeId, 'failed', (error as Error).message)
  }
}

export async function disconnectActive(): Promise<void> {
  const state = useApp.getState()
  const tab = state.tabs.find((item) => item.id === state.activeTabId)
  if (!tab) return
  const pane =
    tab.panes.find((item) => item.runtimeId === state.activeRuntimeId) ?? tab.panes[0]
  if (!pane) return
  if (state.recordingRuntimeId === pane.runtimeId) {
    state.cancelRecording(tr('连接已断开，录制已停止', 'Connection closed; recording stopped'))
  }
  await api.ssh.disconnect(pane.runtimeId)
  state.setStatus(pane.runtimeId, 'closed')
}

export async function runAction(action: ShortcutAction | string): Promise<void> {
  const state = useApp.getState()

  switch (action) {
    case 'session:new':
      state.openSessionDialog(null)
      break

    case 'session:open':
      state.focusSearch()
      break

    case 'tab:new': {
      const session =
        state.sessions.find((item) => item.id === state.lastSessionId) ?? state.sessions[0]
      if (session) state.openSession(session)
      else state.openSessionDialog(null)
      break
    }

    case 'tab:close': {
      // Ctrl+W closes the focused split pane first; only a single-pane tab closes.
      const tab = state.tabs.find((item) => item.id === state.activeTabId)
      if (!tab) break
      if (tab.panes.length > 1) {
        const pane =
          tab.panes.find((item) => item.runtimeId === state.activeRuntimeId) ?? tab.panes[0]
        if (pane) state.closePane(tab.id, pane.id)
        break
      }
      state.closeTab(tab.id)
      break
    }

    case 'tab:next':
      state.nextTab(1)
      break

    case 'tab:prev':
      state.nextTab(-1)
      break

    case 'edit:copy':
      await state.copySelection(state.activeRuntimeId)
      break

    case 'edit:paste':
      await state.pasteClipboard(state.activeRuntimeId)
      break

    case 'edit:find':
      state.setSearchVisible(!state.searchVisible)
      break

    case 'edit:clear':
      getTerminal(state.activeRuntimeId)?.terminal.clear()
      break

    case 'view:sidebar':
      state.toggleSidebar()
      break

    case 'view:sftp': {
      const session = sessionForRuntime(state.activeRuntimeId, state)
      if (isNonSshSession(session)) {
        state.addToast(
          'warn',
          tr('SFTP 需要 SSH 会话', 'SFTP requires an SSH session')
        )
        break
      }
      state.toggleSftp()
      break
    }

    case 'view:monitor':
      state.toggleMonitor()
      break

    case 'view:theme':
      state.toggleUiTheme()
      break

    case 'ssh:reconnect':
      await reconnectActive()
      break

    case 'ssh:disconnect':
      await disconnectActive()
      break

    case 'pane:split-h':
      state.splitActive('horizontal')
      break

    case 'pane:split-v':
      state.splitActive('vertical')
      break

    case 'font:inc':
      state.setFontSize(state.fontSize + 1)
      break

    case 'font:dec':
      state.setFontSize(state.fontSize - 1)
      break

    case 'font:reset':
      state.setFontSize(14)
      break

    case 'window:fullscreen':
      await api.window.toggleFullScreen()
      break

    case 'help:shortcuts':
      state.setShortcutsHelp(true)
      break

    case 'help:about':
      state.setAboutOpen(true)
      break

    case 'dialog:close': {
      if (state.pasteConfirm) {
        state.cancelPaste()
      } else if (state.keyboard) {
        await api.ssh.keyboardInteractive(state.keyboard.requestId, undefined, true)
        state.setKeyboard(null)
      } else if (state.shortcutsHelp) {
        state.setShortcutsHelp(false)
      } else if (state.aboutOpen) {
        state.setAboutOpen(false)
      } else if (state.aiDialogOpen) {
        state.setAiDialogOpen(false)
      } else if (state.folderDialogOpen) {
        state.setFolderDialogOpen(false)
      } else if (state.sessionDialog.open) {
        state.closeSessionDialog()
      } else if (state.searchVisible) {
        state.setSearchVisible(false)
      } else if (state.composeOpen) {
        state.setComposeOpen(false)
      } else if (
        state.activeRuntimeId &&
        state.statuses[state.activeRuntimeId]?.status === 'failed'
      ) {
        // Dismiss the in-pane "connection failed" panel before touching toasts.
        state.dismissFailure(state.activeRuntimeId)
      } else if (state.toasts.length > 0) {
        // Esc dismisses the most recent notification (e.g. a connection failure toast).
        state.removeToast(state.toasts[state.toasts.length - 1].id)
      }
      break
    }

    case 'tools:tunnels':
      state.setTunnelsOpen(true)
      break

    case 'tools:keys':
      state.setKeysOpen(true)
      break

    case 'tools:ai':
      state.setAiDialogOpen(true)
      break

    case 'tools:compose':
      state.toggleCompose()
      break

    case 'tools:record':
      if (state.recordingRuntimeId) {
        await state.stopRecording()
      } else if (state.activeRuntimeId) {
        state.startRecording(state.activeRuntimeId)
      }
      break

    default:
      break
  }
}
