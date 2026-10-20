import { useEffect, useRef, useState, type ReactElement } from 'react'
import { api } from '../api'
import { tr } from '../lib/i18n'
import { recorder } from '../lib/recorder'
import { useApp, type TabState } from '../store'
import { Icon } from './Icon'

interface SessionDockProps {
  tab: TabState
  activeRuntimeId: string | null
  visible: boolean
}

export function SessionDock({ tab, activeRuntimeId, visible }: SessionDockProps): ReactElement {
  const sessions = useApp((state) => state.sessions)
  const quickBarAutoHide = useApp((state) => state.quickBarAutoHide)
  const toggleQuickBarAutoHide = useApp((state) => state.toggleQuickBarAutoHide)
  const composeOpen = useApp((state) => state.composeOpen)
  const composeFocusNonce = useApp((state) => state.composeFocusNonce)
  const setComposeOpen = useApp((state) => state.setComposeOpen)
  const toggleCompose = useApp((state) => state.toggleCompose)
  const openSessionDialog = useApp((state) => state.openSessionDialog)
  const quickCommands = useApp((state) => state.quickCommands)
  const setQuickCommandsOpen = useApp((state) => state.setQuickCommandsOpen)
  const recordingRuntimeId = useApp((state) => state.recordingRuntimeId)
  const startRecording = useApp((state) => state.startRecording)
  const stopRecording = useApp((state) => state.stopRecording)

  const composeRef = useRef<HTMLTextAreaElement>(null)
  const [composeText, setComposeText] = useState('')
  const [sendEnter, setSendEnter] = useState(true)

  const session =
    sessions.find((item) => item.id === tab.panes[0]?.sessionId) ?? tab.session
  const runtimeId =
    tab.panes.find((pane) => pane.runtimeId === activeRuntimeId)?.runtimeId ??
    tab.panes[0]?.runtimeId ??
    null
  const recording = recordingRuntimeId !== null && recordingRuntimeId === runtimeId

  useEffect(() => {
    if (!composeOpen || !visible) return
    const timer = window.setTimeout(() => composeRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [composeOpen, composeFocusNonce, visible])

  const send = (text: string, appendEnter: boolean): void => {
    if (!runtimeId || !text) return
    const status = useApp.getState().statuses[runtimeId]?.status
    if (status !== 'connected') {
      useApp
        .getState()
        .addToast('warn', tr('会话尚未连接，无法发送命令', 'The session is not connected yet'))
      return
    }
    const data = appendEnter && !/[\r\n]$/.test(text) ? `${text}\r` : text
    recorder.recordInput(runtimeId, data)
    void api.ssh.write(runtimeId, data).catch((error) => {
      useApp
        .getState()
        .addToast('error', tr(`发送失败：${(error as Error).message}`, `Send failed: ${(error as Error).message}`))
    })
  }

  const sendCompose = (): void => {
    send(composeText, sendEnter)
    composeRef.current?.focus()
  }

  const collapsed = quickBarAutoHide && !composeOpen

  return (
    <div className={`session-dock ${collapsed ? 'auto-hide' : ''}`}>
      {composeOpen ? (
        <div className="compose-pane">
          <div className="compose-header">
            <span>
              <Icon name="compose" size={14} />
              {tr('撰写窗格', 'Compose pane')}
            </span>
            <button
              className="icon-btn mini"
              title={tr('关闭 (Esc)', 'Close (Esc)')}
              onClick={() => setComposeOpen(false)}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
          <textarea
            ref={composeRef}
            className="compose-input"
            value={composeText}
            onChange={(event) => setComposeText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                sendCompose()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setComposeOpen(false)
              }
            }}
            placeholder={tr(
              '在此草拟多行命令，Ctrl+Enter 发送到当前会话。',
              'Draft multi-line input here and press Ctrl+Enter to send it to the session.'
            )}
            spellCheck={false}
          />
          <div className="compose-actions">
            <label className="mini-check">
              <input
                type="checkbox"
                checked={sendEnter}
                onChange={(event) => setSendEnter(event.target.checked)}
              />
              {tr('末尾附加回车', 'Append Enter')}
            </label>
            <div className="compose-spacer" />
            <button className="btn btn-ghost btn-small" onClick={() => setComposeText('')}>
              {tr('清空', 'Clear')}
            </button>
            <button
              className="btn btn-primary btn-small"
              onClick={sendCompose}
              disabled={!composeText}
            >
              {tr('发送 (Ctrl+Enter)', 'Send (Ctrl+Enter)')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="quick-bar">
        <button
          className="quick-bar-rail"
          title={
            quickBarAutoHide
              ? tr('固定快速命令栏', 'Pin quick command bar')
              : tr('自动隐藏快速命令栏', 'Auto-hide quick command bar')
          }
          onClick={toggleQuickBarAutoHide}
        >
          <Icon name={quickBarAutoHide ? 'pin' : 'chevron-down'} size={13} />
        </button>

        <div className="quick-commands">
          {quickCommands.length === 0 ? (
            <span className="quick-empty">
              {tr('尚无快速命令', 'No quick commands yet')}
            </span>
          ) : (
            quickCommands.map((item) => (
              <button
                key={item.id}
                className="quick-command"
                title={`${item.command}${item.sendEnter === false ? '' : ' ↵'}`}
                onClick={() => send(item.command, item.sendEnter !== false)}
              >
                {item.label}
              </button>
            ))
          )}
          <button
            className="quick-command add"
            title={tr('管理快速命令（全局）', 'Manage quick commands (global)')}
            onClick={() => setQuickCommandsOpen(true)}
          >
            <Icon name="plus" size={12} />
            {tr('管理', 'Manage')}
          </button>
        </div>

        <div className="quick-bar-actions">
          <button
            className={`icon-btn mini ${recording ? 'recording' : ''}`}
            title={
              recording
                ? tr('停止录制并保存脚本', 'Stop recording and save script')
                : tr('录制终端操作并生成脚本', 'Record terminal input/output as a script')
            }
            disabled={!runtimeId || (!recording && Boolean(recordingRuntimeId))}
            onClick={() => {
              if (recording) void stopRecording()
              else if (runtimeId) startRecording(runtimeId)
            }}
          >
            <Icon name={recording ? 'stop' : 'record'} size={13} />
          </button>
          <button
            className={`icon-btn mini ${composeOpen ? 'active' : ''}`}
            title={tr('撰写窗格 (Ctrl+Shift+M)', 'Compose pane (Ctrl+Shift+M)')}
            onClick={toggleCompose}
          >
            <Icon name="compose" size={13} />
          </button>
          <button
            className="icon-btn mini"
            title={tr('会话自动化设置', 'Session automation settings')}
            onClick={() => openSessionDialog(session, session.folderId, 'automation')}
          >
            <Icon name="settings" size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
