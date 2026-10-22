import { useEffect, type ReactElement } from 'react'
import type { Session } from '@shared/types'
import { api } from '../api'
import { tr } from '../lib/i18n'
import { useApp } from '../store'
import { FileTransferPanel } from './SftpPanel'
import { Icon } from './Icon'

interface FtpPaneProps {
  runtimeId: string
  session: Session
  visible: boolean
  showClose: boolean
  autoConnect?: boolean
  onClose?: () => void
}

/**
 * Tab content for an FTP session: the shared two-pane file manager instead of
 * a terminal. It owns the connection lifecycle, mirroring `TerminalPane`.
 */
export function FtpPane({
  runtimeId,
  session,
  showClose,
  autoConnect = true,
  onClose
}: FtpPaneProps): ReactElement {
  const status = useApp((state) => state.statuses[runtimeId])
  const failureDismissed = useApp((state) => state.failedDismissed[runtimeId] ?? false)
  const setStatus = useApp((state) => state.setStatus)
  const openSessionDialog = useApp((state) => state.openSessionDialog)

  useEffect(() => {
    if (!autoConnect) {
      setStatus(runtimeId, 'idle')
      return
    }
    void api.ssh
      .connect({ runtimeId, session, cols: 80, rows: 24 })
      .catch((error) => setStatus(runtimeId, 'failed', (error as Error).message))
    return () => {
      void api.ssh.disconnect(runtimeId)
    }
    // Connect once per runtime, like the terminal pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeId, autoConnect])

  const retry = (): void => {
    setStatus(runtimeId, 'connecting')
    void api.ssh
      .connect({ runtimeId, session, cols: 80, rows: 24 })
      .catch((error) => setStatus(runtimeId, 'failed', (error as Error).message))
  }

  const current = status?.status ?? 'connecting'
  const connected = current === 'connected'

  return (
    <div className="ftp-pane">
      <FileTransferPanel runtimeId={connected ? runtimeId : null} protocol="ftp" />

      {showClose ? (
        <button
          className="pane-close"
          title={tr('关闭分屏', 'Close pane')}
          onClick={(event) => {
            event.stopPropagation()
            onClose?.()
          }}
        >
          <Icon name="x" size={12} />
        </button>
      ) : null}

      {current === 'connecting' || current === 'authenticating' ? (
        <div className="terminal-status-pill ftp-status-pill">
          <span className="spinner" />
          {tr('正在连接', 'Connecting to')} {session.host}:{session.port}…
        </div>
      ) : null}

      {current === 'idle' ? (
        <div className="terminal-status-pill closed">
          <span>{tr('已恢复上次布局', 'Restored layout')}</span>
          <button className="pill-btn" onClick={retry}>
            {tr('连接', 'Connect')}
          </button>
        </div>
      ) : null}

      {current === 'closed' ? (
        <div className="terminal-status-pill closed">
          <span>
            {tr('FTP 连接已断开', 'FTP connection closed')}
            {status?.message ? `：${status.message}` : ''}
          </span>
          <button className="pill-btn" onClick={retry}>
            {tr('重新连接', 'Reconnect')}
          </button>
        </div>
      ) : null}

      {current === 'failed' && !failureDismissed ? (
        <div className="terminal-error">
          <div className="terminal-error-icon">
            <Icon name="alert-triangle" size={22} />
          </div>
          <div className="terminal-error-text">
            <strong>{tr('FTP 连接失败', 'FTP connection failed')}</strong>
            <p>{status?.message || tr('无法连接到 FTP 服务器', 'Could not reach the FTP server')}</p>
          </div>
          <div className="terminal-error-actions">
            <button className="btn btn-primary" onClick={retry}>
              {tr('重试', 'Retry')}
            </button>
            <button
              className="btn"
              onClick={() =>
                openSessionDialog(
                  useApp.getState().sessions.find((item) => item.id === session.id) ?? session
                )
              }
            >
              {tr('编辑会话', 'Edit session')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
