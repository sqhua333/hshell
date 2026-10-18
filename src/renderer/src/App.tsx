import { useEffect, type ReactElement } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { api } from './api'
import { runAction } from './commands'
import { tr } from './lib/i18n'
import { isEditingField, matchShortcut } from './lib/shortcuts'
import { publishRuntimeData } from './lib/runtime-bus'
import { useApp } from './store'
import { AboutDialog } from './components/AboutDialog'
import { FolderDialog } from './components/FolderDialog'
import { HostKeyDialog } from './components/HostKeyDialog'
import { KeyboardDialog } from './components/KeyboardDialog'
import { KeysDialog } from './components/KeysDialog'
import { SessionDialog } from './components/SessionDialog'
import { SessionSidebar } from './components/SessionSidebar'
import { SftpPanel } from './components/SftpPanel'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { StatusBar } from './components/StatusBar'
import { TerminalArea } from './components/TerminalArea'
import { Toasts } from './components/Toasts'
import { Toolbar } from './components/Toolbar'
import { TunnelsDialog } from './components/TunnelsDialog'

export default function App(): ReactElement {
  const uiTheme = useApp((state) => state.uiTheme)
  const locale = useApp((state) => state.locale)
  const sidebarVisible = useApp((state) => state.sidebarVisible)
  const sftpVisible = useApp((state) => state.sftpVisible)

  useEffect(() => {
    void useApp
      .getState()
      .init()
      .catch((error) =>
        useApp.getState().addToast('error', tr(`初始化失败：${(error as Error).message}`, `Initialization failed: ${(error as Error).message}`))
      )
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme
  }, [uiTheme])

  // App owns the locale subscription so a language switch re-renders the whole
  // tree; `tr()` is a plain function and cannot subscribe on its own.
  useEffect(() => {
    document.title = 'HShell'
  }, [locale])

  useEffect(() => {
    const off = api.events.on((event) => {
      const state = useApp.getState()
      switch (event.type) {
        case 'ssh:data':
          publishRuntimeData(event.runtimeId, event.data)
          break
        case 'ssh:status':
          state.setStatus(event.runtimeId, event.status, event.message)
          if (event.status === 'failed' && event.message) {
            state.addToast('error', event.message)
          }
          break
        case 'ssh:exit':
          state.setStatus(
            event.runtimeId,
            'closed',
            event.code !== undefined
              ? tr(`退出码 ${event.code}`, `Exit code ${event.code}`)
              : event.signal
                ? tr(`信号 ${event.signal}`, `Signal ${event.signal}`)
                : tr('连接已断开', 'Connection closed')
          )
          break
        case 'ssh:hostkey':
          state.setHostKey({ ...event.prompt, runtimeId: event.runtimeId })
          break
        case 'ssh:keyboard-interactive':
          state.setKeyboard({ ...event.prompt, runtimeId: event.runtimeId })
          break
        case 'ssh:notice':
          state.addToast(event.level, event.message)
          break
        case 'sftp:progress':
          state.setTransferProgress(event.runtimeId, event)
          if (event.phase === 'complete') {
            state.addToast(
              'info',
              tr(
                `${event.direction === 'upload' ? '上传' : '下载'}完成（${event.transferred} B）`,
                `${event.direction === 'upload' ? 'Upload' : 'Download'} complete (${event.transferred} B)`
              )
            )
          }
          break
        case 'tunnel:status':
          state.applyTunnelStatus(event)
          if (event.phase === 'error') {
            state.addToast('error', event.message ?? tr('端口转发失败', 'Port forwarding failed'))
          }
          break
        case 'zmodem:status':
          state.setZmodemStatus(event.runtimeId, event)
          if (event.phase === 'detected') {
            state.addToast(
              'info',
              event.direction === 'upload'
                ? tr(
                    '检测到 ZMODEM 发送请求（rz），请选择要发送的文件',
                    'ZMODEM send request (rz) detected; choose files to send'
                  )
                : tr(
                    '检测到 ZMODEM 接收请求（sz），请选择保存目录',
                    'ZMODEM receive request (sz) detected; choose a destination folder'
                  )
            )
          } else if (event.phase === 'file-complete') {
            state.addToast(
              'info',
              tr(
                `${event.direction === 'upload' ? '已发送' : '已接收'} ${event.fileName ?? '文件'}`,
                `${event.direction === 'upload' ? 'Sent' : 'Received'} ${event.fileName ?? 'file'}`
              )
            )
          } else if (event.phase === 'complete') {
            state.addToast('info', tr('ZMODEM 传输完成', 'ZMODEM transfer complete'))
          } else if (event.phase === 'cancelled') {
            state.addToast('warn', event.message ?? tr('ZMODEM 传输已取消', 'ZMODEM transfer cancelled'))
          } else if (event.phase === 'error') {
            state.addToast('error', event.message ?? tr('ZMODEM 传输失败', 'ZMODEM transfer failed'))
          }
          break
        case 'menu:action':
          void runAction(event.action)
          break
        default:
          break
      }
    })
    return off
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const match = matchShortcut(event)
      if (!match) return
      if (
        isEditingField(event) &&
        match.action !== 'dialog:close' &&
        match.action !== 'help:shortcuts'
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (match.action === 'tab:select' && match.digit) {
        useApp.getState().selectTabIndex(match.digit - 1)
      } else {
        void runAction(match.action)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  return (
    <div className="app" data-theme={uiTheme}>
      <Toolbar />
      <div className="app-body">
        {sidebarVisible ? <SessionSidebar /> : null}
        <main className="main">
          <Group orientation="vertical" className="main-split">
            <Panel minSize="20%" defaultSize="68%">
              <TerminalArea />
            </Panel>
            {sftpVisible ? (
              <>
                <Separator className="pane-resize-handle" />
                <Panel defaultSize="32%" minSize="18%" maxSize="72%">
                  <SftpPanel />
                </Panel>
              </>
            ) : null}
          </Group>
        </main>
      </div>
      <StatusBar />

      <SessionDialog />
      <KeysDialog />
      <TunnelsDialog />
      <HostKeyDialog />
      <KeyboardDialog />
      <ShortcutsDialog />
      <AboutDialog />
      <FolderDialog />
      <Toasts />
    </div>
  )
}
