import type { ReactElement } from 'react'
import { tr } from '../lib/i18n'
import { useApp } from '../store'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * Floating ZMODEM transfer card. It mirrors the SFTP transfer bar but is
 * visible over the terminal, because `rz`/`sz` run inside the session rather
 * than in the SFTP panel.
 */
export function ZmodemProgress(): ReactElement | null {
  const transfer = useApp((state) =>
    state.activeRuntimeId ? state.zmodem[state.activeRuntimeId] : undefined
  )
  if (!transfer) return null

  const percent =
    transfer.total > 0
      ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100))
      : transfer.phase === 'complete' || transfer.phase === 'file-complete'
        ? 100
        : 0
  const active = transfer.phase === 'receiving' || transfer.phase === 'sending'
  const direction =
    transfer.direction === 'upload' ? tr('发送 (rz)', 'Send (rz)') : tr('接收 (sz)', 'Receive (sz)')

  const title = (() => {
    switch (transfer.phase) {
      case 'detected':
        return tr('ZMODEM：等待选择文件或目录…', 'ZMODEM: waiting for selection…')
      case 'file-complete':
        return `${tr('已完成', 'Completed')} ${transfer.fileName ?? ''}`.trim()
      case 'complete':
        return tr('ZMODEM 传输完成', 'ZMODEM transfer complete')
      case 'cancelled':
        return tr('ZMODEM 传输已取消', 'ZMODEM transfer cancelled')
      case 'error':
        return tr('ZMODEM 传输失败', 'ZMODEM transfer failed')
      default:
        return `${direction}${transfer.fileName ? ` ${transfer.fileName}` : ''}`
    }
  })()

  const detail = (() => {
    if (transfer.phase === 'error' || transfer.phase === 'cancelled') {
      return transfer.message ?? ''
    }
    if (transfer.total > 0) {
      return `${formatBytes(transfer.transferred)} / ${formatBytes(transfer.total)} · ${percent}%`
    }
    return transfer.message ?? ''
  })()

  return (
    <div
      className={`zmodem-progress ${active ? 'active' : transfer.phase}`}
      role="status"
      aria-live="polite"
    >
      <div className="zmodem-progress-head">
        <span className="zmodem-progress-title">{title}</span>
        {transfer.total > 0 && active ? <span>{percent}%</span> : null}
      </div>
      <div className="zmodem-progress-track">
        <div className="zmodem-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      {detail ? <div className="zmodem-progress-detail">{detail}</div> : null}
    </div>
  )
}
