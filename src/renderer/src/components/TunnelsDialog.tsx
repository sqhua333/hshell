import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { TunnelInfo, TunnelType } from '@shared/types'
import { isNonSshSession } from '@shared/session'
import { api } from '../api'
import { tr } from '../lib/i18n'
import { sessionForRuntime, useApp } from '../store'
import { Icon } from './Icon'
import { Modal } from './Modal'

// Stable empty list so the zustand selector keeps the same snapshot identity
// when a runtime has no tunnels yet.
const NO_TUNNELS: TunnelInfo[] = []

function typeLabel(type: TunnelType): string {
  if (type === 'remote') return tr('远程 -R', 'Remote -R')
  if (type === 'dynamic') return tr('动态 -D', 'Dynamic -D')
  return tr('本地 -L', 'Local -L')
}

function newTunnelId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `tn-${Date.now().toString(36)}-${random}`
}

function mapping(info: TunnelInfo): string {
  const bind = `${info.bindHost}:${info.bindPort}`
  if (info.tunnelType === 'dynamic') return `${bind} → SOCKS5`
  const target = `${info.targetHost ?? ''}:${info.targetPort ?? ''}`
  return info.tunnelType === 'local'
    ? `${bind} → ${target}`
    : `${tr('远端', 'remote')} ${bind} → ${target}`
}

function parsePort(value: string): number | null {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

export function TunnelsDialog(): ReactElement | null {
  const open = useApp((state) => state.tunnelsOpen)
  if (!open) return null
  return <TunnelsDialogInner />
}

function TunnelsDialogInner(): ReactElement {
  const setOpen = useApp((state) => state.setTunnelsOpen)
  const runtimeId = useApp((state) => state.activeRuntimeId)
  const status = useApp((state) =>
    state.activeRuntimeId ? state.statuses[state.activeRuntimeId]?.status : undefined
  )
  const activeSession = useApp((state) => sessionForRuntime(state.activeRuntimeId, state))
  const sessionName = activeSession?.name ?? null
  const nonSshSession = isNonSshSession(activeSession)
  const tunnels = useApp((state) =>
    runtimeId ? state.tunnels[runtimeId] ?? NO_TUNNELS : NO_TUNNELS
  )
  const setTunnels = useApp((state) => state.setTunnels)
  const addToast = useApp((state) => state.addToast)

  const [type, setType] = useState<TunnelType>('local')
  const [bindHost, setBindHost] = useState('127.0.0.1')
  const [bindPort, setBindPort] = useState('8080')
  const [targetHost, setTargetHost] = useState('127.0.0.1')
  const [targetPort, setTargetPort] = useState('80')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (!runtimeId) return
    const list = await api.tunnels.list(runtimeId)
    setTunnels(runtimeId, list)
  }, [runtimeId, setTunnels])

  useEffect(() => {
    void refresh().catch((err) => setError((err as Error).message))
  }, [refresh])

  const connected = status === 'connected'
  const disabled = !runtimeId || !connected || busy || nonSshSession

  const start = async (): Promise<void> => {
    if (busy) return
    setError('')
    if (!runtimeId) {
      setError(tr('请先连接一个会话', 'Connect a session first'))
      return
    }
    if (!bindHost.trim()) {
      setError(tr('请填写监听地址', 'Please enter a bind address'))
      return
    }
    const localPort = parsePort(bindPort)
    if (localPort === null) {
      setError(tr('监听端口必须是 1–65535 之间的整数', 'Bind port must be an integer between 1 and 65535'))
      return
    }
    let remotePort: number | undefined
    if (type !== 'dynamic') {
      if (!targetHost.trim()) {
        setError(tr('请填写目标主机', 'Please enter a target host'))
        return
      }
      const parsed = parsePort(targetPort)
      if (parsed === null) {
        setError(tr('目标端口必须是 1–65535 之间的整数', 'Target port must be an integer between 1 and 65535'))
        return
      }
      remotePort = parsed
    }

    setBusy(true)
    try {
      const info = await api.tunnels.start({
        id: newTunnelId(),
        runtimeId,
        tunnelType: type,
        bindHost: bindHost.trim(),
        bindPort: localPort,
        ...(type === 'dynamic'
          ? {}
          : { targetHost: targetHost.trim(), targetPort: remotePort })
      })
      addToast('info', tr(`转发已启动：${mapping(info)}`, `Forwarding started: ${mapping(info)}`))
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stop = async (id: string): Promise<void> => {
    try {
      await api.tunnels.stop(id)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Modal
      title={tr('端口转发', 'Port forwarding')}
      subtitle={
        nonSshSession
          ? tr('端口转发需要 SSH 会话', 'Port forwarding requires an SSH session')
          : sessionName
            ? tr(
                `会话：${sessionName}${connected ? '' : '（未连接）'}`,
                `Session: ${sessionName}${connected ? '' : ' (disconnected)'}`
              )
            : tr('请先打开一个已连接的会话', 'Open a connected session first')
      }
      onClose={() => setOpen(false)}
      width={640}
    >
      <div className="tunnel-form">
        <label className="field">
          <span>{tr('类型', 'Type')}</span>
          <select
            value={type}
            onChange={(event) => setType(event.target.value as TunnelType)}
            disabled={disabled}
          >
            <option value="local">{tr('本地转发（-L）', 'Local forward (-L)')}</option>
            <option value="remote">{tr('远程转发（-R）', 'Remote forward (-R)')}</option>
            <option value="dynamic">{tr('动态转发（-D，SOCKS5）', 'Dynamic forward (-D, SOCKS5)')}</option>
          </select>
        </label>
        <div className="field-row">
          <label className="field">
            <span>{type === 'remote' ? tr('远端监听地址', 'Remote bind address') : tr('本地监听地址', 'Local bind address')}</span>
            <input
              value={bindHost}
              onChange={(event) => setBindHost(event.target.value)}
              placeholder="127.0.0.1"
              spellCheck={false}
              disabled={disabled}
            />
          </label>
          <label className="field field-port">
            <span>{tr('端口', 'Port')}</span>
            <input
              value={bindPort}
              onChange={(event) => setBindPort(event.target.value)}
              placeholder="8080"
              inputMode="numeric"
              spellCheck={false}
              disabled={disabled}
            />
          </label>
        </div>
        {type !== 'dynamic' ? (
          <div className="field-row">
            <label className="field">
              <span>{tr('目标主机', 'Target host')}</span>
              <input
                value={targetHost}
                onChange={(event) => setTargetHost(event.target.value)}
                placeholder="127.0.0.1"
                spellCheck={false}
                disabled={disabled}
              />
            </label>
            <label className="field field-port">
              <span>{tr('目标端口', 'Target port')}</span>
              <input
                value={targetPort}
                onChange={(event) => setTargetPort(event.target.value)}
                placeholder="80"
                inputMode="numeric"
                spellCheck={false}
                disabled={disabled}
              />
            </label>
          </div>
        ) : (
          <p className="form-hint">
            {tr('动态转发会在本地开启 SOCKS5 代理，浏览器或 curl 使用', 'Dynamic forwarding exposes a local SOCKS5 proxy; point a browser or curl at')}
            <code> --socks5-hostname {bindHost || '127.0.0.1'}:{bindPort || '1080'}</code>
            {tr('即可经服务器访问任意目标。', 'to reach any target through the server.')}
          </p>
        )}
        {type === 'remote' ? (
          <p className="form-hint">
            {tr('远端监听是否成功取决于服务器的 ', 'Whether the remote bind succeeds depends on the server\'s ')}<code>GatewayPorts</code>{tr(' 配置；目标地址由本机解析。', ' setting; target addresses are resolved locally.')}
          </p>
        ) : null}
        {error ? <div className="form-error">{error}</div> : null}
        <div className="tunnel-actions">
          <button className="btn btn-primary" onClick={() => void start()} disabled={disabled}>
            <Icon name="plus" size={14} />
            {tr('启动转发', 'Start forwarding')}
          </button>
        </div>
      </div>

      <div className="tunnel-list">
        <div className="tunnel-list-title">{tr('当前会话的转发规则', 'Forwarding rules for this session')}</div>
        {tunnels.length === 0 ? (
          <div className="form-hint">{tr('暂无转发规则。', 'No forwarding rules yet.')}</div>
        ) : (
          tunnels.map((info) => (
            <div key={info.id} className="tunnel-row">
              <span className={`tunnel-dot ${info.phase}`} />
              <span className="tunnel-type">{typeLabel(info.tunnelType)}</span>
              <span className="tunnel-map">{mapping(info)}</span>
              <span className={`tunnel-phase ${info.phase}`}>
                {info.phase === 'active'
                  ? tr('运行中', 'Active')
                  : info.phase === 'starting'
                    ? tr('启动中', 'Starting')
                    : info.phase === 'error'
                      ? info.message || tr('错误', 'Error')
                      : tr('已停止', 'Stopped')}
              </span>
              <button className="icon-btn" title={tr('停止', 'Stop')} onClick={() => void stop(info.id)}>
                <Icon name="x" />
              </button>
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}
