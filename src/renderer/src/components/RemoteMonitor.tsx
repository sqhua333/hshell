import { useEffect, useRef, useState, type ReactElement } from 'react'
import { isNonSshSession, sessionTarget } from '@shared/session'
import type { RemoteMonitorSample } from '@shared/types'
import { api, isElectron } from '../api'
import { tr } from '../lib/i18n'
import { sessionForRuntime, useApp } from '../store'
import { Icon } from './Icon'

/**
 * MobaXterm-style remote monitoring strip. Samples `/proc` and `df` on the
 * remote host through the SSH connection; the browser demo uses plausible
 * simulated numbers instead (see `mock.ts`).
 */

const POLL_MS = 2000
const MAX_FAILURES = 3

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatRate(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB/s`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB/s`
  return `${Math.round(bytes)} B/s`
}

function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
}

/** Days plus HH:MM:SS, so minutes and seconds are always visible. */
function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86400)
  const clock = `${pad(Math.floor((total % 86400) / 3600))}:${pad(
    Math.floor((total % 3600) / 60)
  )}:${pad(total % 60)}`
  return days > 0 ? `${days}天 ${clock}` : clock
}

function formatBootTime(epochMs: number): string {
  const date = new Date(epochMs)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`
}

function percent(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0
}

function Metric({
  label,
  value,
  detail
}: {
  label: string
  value: string
  detail: string
}): ReactElement {
  return (
    <div className="monitor-metric" title={`${label} ${value} ${detail}`.trim()}>
      <span className="monitor-label">{label}</span>
      <span className="monitor-value">{value}</span>
      <span className="monitor-sub">{detail}</span>
    </div>
  )
}

export function RemoteMonitor(): ReactElement {
  const runtimeId = useApp((state) => state.activeRuntimeId)
  const session = useApp((state) => sessionForRuntime(state.activeRuntimeId, state))
  const status = useApp((state) =>
    state.activeRuntimeId ? state.statuses[state.activeRuntimeId]?.status : undefined
  )
  const toggleMonitor = useApp((state) => state.toggleMonitor)

  const [current, setCurrent] = useState<RemoteMonitorSample | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const failures = useRef(0)

  const ssh = session !== null && !isNonSshSession(session)
  const eligible = Boolean(runtimeId && ssh && status === 'connected')

  useEffect(() => {
    setCurrent(null)
    setError(null)
    failures.current = 0
    if (!runtimeId || !eligible) return

    let cancelled = false
    let timer: number | null = null
    const tick = async (): Promise<void> => {
      try {
        const sample = await api.monitor.sample(runtimeId)
        if (cancelled) return
        failures.current = 0
        setError(null)
        setCurrent(sample)
      } catch (failure) {
        if (cancelled) return
        failures.current += 1
        setError((failure as Error).message)
        if (failures.current >= MAX_FAILURES && timer !== null) {
          window.clearInterval(timer)
          timer = null
        }
      }
    }
    void tick()
    timer = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      if (timer !== null) window.clearInterval(timer)
    }
  }, [runtimeId, eligible, retryNonce])

  const memPercent = current ? percent(current.memUsed, current.memTotal) : 0
  const diskPercent = current ? percent(current.diskUsed, current.diskTotal) : 0

  const emptyMessage = (() => {
    if (!session) return tr('无活动会话', 'No active session')
    if (!ssh) return tr('远程监控仅支持 SSH 会话', 'Remote monitoring requires an SSH session')
    if (status !== 'connected') return tr('等待会话连接…', 'Waiting for the session to connect…')
    if (error) return error
    return tr('正在读取远程监控…', 'Reading remote metrics…')
  })()

  return (
    <div className="monitor">
      <div className="monitor-head">
        <Icon name="trigger" size={13} />
        <span className="monitor-title">{tr('远程监控', 'Remote monitoring')}</span>
        <span className="monitor-target">
          {session ? sessionTarget(session) : tr('无活动会话', 'No active session')}
        </span>
        {!isElectron ? (
          <span
            className="monitor-demo"
            title={tr('界面预览：数值为模拟数据', 'UI preview: values are simulated')}
          >
            {tr('演示数据', 'Demo data')}
          </span>
        ) : null}
        {error && current ? (
          <span className="monitor-error-badge" title={error}>
            {tr('采集失败', 'Sampling failed')}
          </span>
        ) : null}
        <span className="monitor-spacer" />
        <span className="monitor-tick">{tr('每 2 秒采样', 'Every 2 s')}</span>
        <button
          className="icon-btn mini"
          title={tr('隐藏远程监控 (Ctrl+Shift+U)', 'Hide remote monitoring (Ctrl+Shift+U)')}
          onClick={toggleMonitor}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className="monitor-body">
        {current ? (
          <>
            <Metric
              label={tr('CPU', 'CPU')}
              value={`${Math.round(current.cpu)}%`}
              detail={tr(
                `${current.cores} 核 · 负载 ${current.load.toFixed(2)}`,
                `${current.cores} cores · load ${current.load.toFixed(2)}`
              )}
            />
            <Metric
              label={tr('内存', 'MEM')}
              value={`${Math.round(memPercent)}%`}
              detail={`${formatSize(current.memUsed)} / ${formatSize(current.memTotal)}`}
            />
            <Metric
              label={tr('网络', 'NET')}
              value={`↓ ${formatRate(current.netDown)}`}
              detail={`↑ ${formatRate(current.netUp)}`}
            />
            <Metric
              label={tr('磁盘', 'DISK')}
              value={`${Math.round(diskPercent)}%`}
              detail={tr(
                `${formatSize(current.diskUsed)} / ${formatSize(current.diskTotal)} 已用`,
                `${formatSize(current.diskUsed)} / ${formatSize(current.diskTotal)} used`
              )}
            />
            <Metric
              label={tr('运行时间', 'UPTIME')}
              value={formatUptime(current.uptime)}
              detail={`${tr('启动于', 'Booted')} ${formatBootTime(current.bootTime)}`}
            />
          </>
        ) : (
          <div className="monitor-empty">
            <span>{emptyMessage}</span>
            {error ? (
              <button
                className="btn btn-ghost btn-small"
                onClick={() => setRetryNonce((value) => value + 1)}
              >
                {tr('重试', 'Retry')}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
