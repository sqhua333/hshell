import { useState, type ReactElement } from 'react'
import { isSerialSession } from '@shared/session'
import { isElectron } from '../api'
import { quickConnect, runAction } from '../commands'
import { tr } from '../lib/i18n'
import { useApp } from '../store'
import { Icon } from './Icon'

export function Toolbar(): ReactElement {
  const uiTheme = useApp((state) => state.uiTheme)
  const toggleUiTheme = useApp((state) => state.toggleUiTheme)
  const locale = useApp((state) => state.locale)
  const setLocale = useApp((state) => state.setLocale)
  const sidebarVisible = useApp((state) => state.sidebarVisible)
  const sftpVisible = useApp((state) => state.sftpVisible)
  const activeRuntimeId = useApp((state) => state.activeRuntimeId)
  const composeOpen = useApp((state) => state.composeOpen)
  const toggleCompose = useApp((state) => state.toggleCompose)
  const recordingRuntimeId = useApp((state) => state.recordingRuntimeId)
  const startRecording = useApp((state) => state.startRecording)
  const stopRecording = useApp((state) => state.stopRecording)
  const status = useApp((state) =>
    state.activeRuntimeId ? state.statuses[state.activeRuntimeId]?.status : undefined
  )
  const serialActive = useApp((state) =>
    isSerialSession(state.tabs.find((tab) => tab.id === state.activeTabId)?.session)
  )
  const [quick, setQuick] = useState('')

  const connected = status === 'connected'
  const busy = status === 'connecting' || status === 'authenticating'

  return (
    <div className="toolbar">
      <button
        className="tool-btn"
        title={tr('新建会话 (Ctrl+N)', 'New session (Ctrl+N)')}
        onClick={() => void runAction('session:new')}
      >
        <Icon name="plus" />
      </button>
      <button
        className="tool-btn"
        title={tr('打开会话管理器 (Ctrl+O)', 'Session manager (Ctrl+O)')}
        onClick={() => void runAction('session:open')}
      >
        <Icon name="grid" />
      </button>
      <div className="tool-sep" />
      <button
        className="tool-btn"
        title={tr('复制选中内容 (Ctrl+Shift+C)', 'Copy selection (Ctrl+Shift+C)')}
        onClick={() => void runAction('edit:copy')}
      >
        <Icon name="copy" />
      </button>
      <button
        className="tool-btn"
        title={tr('粘贴 (Ctrl+Shift+V)', 'Paste (Ctrl+Shift+V)')}
        onClick={() => void runAction('edit:paste')}
      >
        <Icon name="clipboard" />
      </button>
      <div className="tool-sep" />
      <button
        className="tool-btn"
        title={tr('重新连接 (Ctrl+Shift+R)', 'Reconnect (Ctrl+Shift+R)')}
        disabled={!activeRuntimeId || busy}
        onClick={() => void runAction('ssh:reconnect')}
      >
        <Icon name="refresh" />
      </button>
      <button
        className="tool-btn"
        title={tr('断开连接 (Ctrl+Shift+W)', 'Disconnect (Ctrl+Shift+W)')}
        disabled={!connected}
        onClick={() => void runAction('ssh:disconnect')}
      >
        <Icon name="power" />
      </button>
      <div className="tool-sep" />
      <button
        className={`tool-btn ${sftpVisible ? 'active' : ''}`}
        title={
          serialActive
            ? tr('串口会话不支持 SFTP', 'SFTP is unavailable for serial sessions')
            : tr('SFTP 面板 (Ctrl+Shift+E)', 'SFTP panel (Ctrl+Shift+E)')
        }
        disabled={serialActive}
        onClick={() => void runAction('view:sftp')}
      >
        <Icon name="upload" />
      </button>
      <button
        className="tool-btn"
        title={
          serialActive
            ? tr('串口会话不支持端口转发', 'Port forwarding is unavailable for serial sessions')
            : tr('端口转发', 'Port forwarding')
        }
        disabled={serialActive}
        onClick={() => useApp.getState().setTunnelsOpen(true)}
      >
        <Icon name="link" />
      </button>
      <button
        className="tool-btn"
        title={tr('密钥管理', 'Key manager')}
        onClick={() => useApp.getState().setKeysOpen(true)}
      >
        <Icon name="key" />
      </button>
      <div className="tool-sep" />
      <button
        className={`tool-btn ${composeOpen ? 'active' : ''}`}
        title={tr('撰写窗格 (Ctrl+Shift+M)', 'Compose pane (Ctrl+Shift+M)')}
        disabled={!activeRuntimeId}
        onClick={toggleCompose}
      >
        <Icon name="compose" />
      </button>
      <button
        className={`tool-btn ${recordingRuntimeId ? 'recording active' : ''}`}
        title={
          recordingRuntimeId
            ? tr('停止录制并保存回放脚本', 'Stop recording and save replay script')
            : tr('录制终端操作并生成脚本', 'Record terminal input/output as a script')
        }
        disabled={!activeRuntimeId || Boolean(recordingRuntimeId && recordingRuntimeId !== activeRuntimeId)}
        onClick={() => {
          if (recordingRuntimeId) void stopRecording()
          else if (activeRuntimeId) startRecording(activeRuntimeId)
        }}
      >
        <Icon name={recordingRuntimeId ? 'stop' : 'record'} />
      </button>
      <button
        className="tool-btn"
        title={tr('水平分屏 (Ctrl+Shift+S)', 'Split horizontally (Ctrl+Shift+S)')}
        onClick={() => void runAction('pane:split-h')}
      >
        <Icon name="split-h" />
      </button>
      <button
        className="tool-btn"
        title={tr('垂直分屏 (Ctrl+Shift+D)', 'Split vertically (Ctrl+Shift+D)')}
        onClick={() => void runAction('pane:split-v')}
      >
        <Icon name="split-v" />
      </button>
      <div className="tool-sep" />
      <button
        className={`tool-btn ${sidebarVisible ? 'active' : ''}`}
        title={tr('显示/隐藏会话管理器 (Ctrl+B)', 'Toggle session manager (Ctrl+B)')}
        onClick={() => void runAction('view:sidebar')}
      >
        <Icon name="sidebar" />
      </button>
      <button className="tool-btn" title={tr('切换界面主题', 'Toggle UI theme')} onClick={toggleUiTheme}>
        <Icon name={uiTheme === 'light' ? 'moon' : 'sun'} />
      </button>
      <button
        className="tool-btn lang-btn"
        title={tr('切换到英文界面', 'Switch to Chinese')}
        onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
      >
        {locale === 'zh' ? 'EN' : '中'}
      </button>
      <button
        className="tool-btn"
        title={tr('键盘快捷键 (F1)', 'Keyboard shortcuts (F1)')}
        onClick={() => void runAction('help:shortcuts')}
      >
        <Icon name="keyboard" />
      </button>

      <div className="tool-spacer" />
      {!isElectron ? <span className="demo-badge">{tr('浏览器演示', 'Browser demo')}</span> : null}
      <div className="quick-connect">
        <Icon name="terminal" size={14} className="quick-icon" />
        <input
          value={quick}
          onChange={(event) => setQuick(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              if (quick.trim()) {
                quickConnect(quick)
                setQuick('')
              }
            }
          }}
          placeholder={tr('快速连接：user@host:port', 'Quick connect: user@host:port')}
          spellCheck={false}
        />
        <button
          className="quick-go"
          title={tr('连接', 'Connect')}
          onClick={() => {
            if (quick.trim()) {
              quickConnect(quick)
              setQuick('')
            }
          }}
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>
    </div>
  )
}
