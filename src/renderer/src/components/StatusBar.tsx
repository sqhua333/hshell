import { useEffect, useState, type ReactElement } from 'react'
import { sessionTarget } from '@shared/session'
import { api, isElectron } from '../api'
import { formatSpeed } from '../lib/format'
import { tr } from '../lib/i18n'
import { sessionForRuntime, useApp } from '../store'

function statusText(status: string): string {
  switch (status) {
    case 'connecting':
      return tr('正在连接', 'Connecting')
    case 'authenticating':
      return tr('正在认证', 'Authenticating')
    case 'connected':
      return tr('已连接', 'Connected')
    case 'reconnecting':
      return tr('正在重连', 'Reconnecting')
    case 'failed':
      return tr('连接失败', 'Failed')
    case 'closed':
      return tr('已断开', 'Disconnected')
    default:
      return tr('未连接', 'Not connected')
  }
}

export function StatusBar(): ReactElement {
  const session = useApp((state) => sessionForRuntime(state.activeRuntimeId, state))
  const status = useApp((state) =>
    state.activeRuntimeId ? state.statuses[state.activeRuntimeId] : undefined
  )
  const transfer = useApp((state) =>
    state.activeRuntimeId ? state.zmodem[state.activeRuntimeId] : undefined
  )
  const sftpTransfer = useApp((state) =>
    state.activeRuntimeId ? state.transfers[state.activeRuntimeId] : undefined
  )
  const appVersion = useApp((state) => state.appVersion)
  const recordingStartedAt = useApp((state) => state.recordingStartedAt)
  const stopRecording = useApp((state) => state.stopRecording)
  const [clock, setClock] = useState(Date.now())

  useEffect(() => {
    if (!recordingStartedAt) return
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [recordingStartedAt])

  const recordingLabel = recordingStartedAt
    ? (() => {
        const seconds = Math.max(0, Math.floor((clock - recordingStartedAt) / 1000))
        return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      })()
    : null
  const current = status?.status ?? 'idle'
  const transferLabel = (() => {
    if (transfer) {
      const arrow = transfer.direction === 'upload' ? '↑' : '↓'
      if (transfer.phase === 'detected') return tr('ZMODEM 等待选择…', 'ZMODEM waiting for selection…')
      const percent =
        transfer.total > 0
          ? ` ${Math.min(100, Math.round((transfer.transferred / transfer.total) * 100))}%`
          : ''
      return `${arrow} ${transfer.fileName ?? 'ZMODEM'}${percent}`
    }
    if (!sftpTransfer) return null
    const arrow = sftpTransfer.direction === 'upload' ? '↑' : '↓'
    const percent =
      sftpTransfer.total > 0
        ? ` ${Math.min(100, Math.round((sftpTransfer.transferred / sftpTransfer.total) * 100))}%`
        : ''
    const speed =
      sftpTransfer.phase === 'running' ? formatSpeed(sftpTransfer.speed) : ''
    const phase =
      sftpTransfer.phase === 'complete'
        ? tr(' 完成', ' done')
        : sftpTransfer.phase === 'cancelled'
          ? tr(' 已取消', ' cancelled')
          : sftpTransfer.phase === 'error'
            ? tr(' 失败', ' failed')
            : ''
    return `${arrow} ${sftpTransfer.fileName || 'SFTP'}${percent}${speed ? ` · ${speed}` : ''}${phase}`
  })()
  const transferHint =
    sftpTransfer?.phase === 'running' && sftpTransfer.fileName
      ? tr('SFTP 传输中，点击取消', 'SFTP transfer in progress; click to cancel')
      : transfer?.message
  const cancelSftp = (): void => {
    if (sftpTransfer?.phase === 'running') void api.sftp.cancel(sftpTransfer.transferId)
  }

  return (
    <div className="statusbar">
      <div className={`status-section status-${current}`}>
        <span className="status-dot" />
        <span>{statusText(current)}</span>
        {session ? (
          <>
            <span className="status-sep">·</span>
            <span>{sessionTarget(session)}</span>
          </>
        ) : null}
      </div>
      <div className="status-spacer" />
      {recordingLabel ? (
        <div
          className="status-section status-recording clickable"
          title={tr('录制中，点击停止并保存脚本', 'Recording; click to stop and save the script')}
          onClick={() => void stopRecording()}
        >
          <span className="rec-dot" />
          REC {recordingLabel}
        </div>
      ) : null}
      {transferLabel ? (
        <div
          className={`status-section status-transfer ${
            sftpTransfer?.phase === 'running' ? 'clickable' : ''
          }`}
          title={transferHint}
          onClick={cancelSftp}
        >
          {transferLabel}
        </div>
      ) : null}
      {current === 'failed' && status?.message ? (
        <div className="status-message" title={status.message}>
          {status.message}
        </div>
      ) : null}
      <div className="status-section">
        {status?.cols && status?.rows ? `${status.cols}×${status.rows}` : '—'}
      </div>
      <div className="status-section">UTF-8</div>
      <div className="status-section">xterm-256color</div>
      <div className="status-section">v{appVersion}</div>
      {!isElectron ? <div className="status-section demo">DEMO</div> : null}
    </div>
  )
}
