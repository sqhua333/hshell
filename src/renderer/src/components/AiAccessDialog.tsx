import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type {
  AiBindAddress,
  AiMcpInfo,
  AiSessionSummary,
  SshStatus
} from '@shared/types'
import { api } from '../api'
import { formatBytes } from '../lib/format'
import {
  ANY_HOST,
  ENDPOINT_HOST_STORAGE_KEY,
  LOOPBACK,
  endpointHosts,
  endpointUrl,
  initialEndpointHost,
  isPlausibleHost,
  normalizeEndpointHost
} from '../lib/mcp-endpoint'
import { tr } from '../lib/i18n'
import { useApp } from '../store'
import { Icon } from './Icon'
import { Modal } from './Modal'

function statusLabel(status: SshStatus): string {
  switch (status) {
    case 'connected':
      return tr('已连接', 'Connected')
    case 'connecting':
      return tr('连接中', 'Connecting')
    case 'authenticating':
      return tr('认证中', 'Authenticating')
    case 'reconnecting':
      return tr('重连中', 'Reconnecting')
    case 'failed':
      return tr('失败', 'Failed')
    case 'closed':
      return tr('已断开', 'Closed')
    default:
      return tr('未连接', 'Idle')
  }
}

export function AiAccessDialog(): ReactElement | null {
  const open = useApp((state) => state.aiDialogOpen)
  if (!open) return null
  return <AiAccessDialogInner />
}

function AiAccessDialogInner(): ReactElement {
  const setOpen = useApp((state) => state.setAiDialogOpen)
  const setAiWatch = useApp((state) => state.setAiWatch)
  const setAiInputMode = useApp((state) => state.setAiInputMode)
  const addToast = useApp((state) => state.addToast)

  const [info, setInfo] = useState<AiMcpInfo | null>(null)
  const [sessions, setSessions] = useState<AiSessionSummary[]>([])
  const [bindings, setBindings] = useState<AiBindAddress[]>([])
  const [selectedHost, setSelectedHost] = useState('127.0.0.1')
  const [applying, setApplying] = useState(false)
  const [hostError, setHostError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  // Client-side host, independent of the listen address: the same binding can
  // be reached through loopback, a NIC, or a NAT/port-forward entry.
  const [endpointHost, setEndpointHost] = useState(LOOPBACK)
  const [endpointCustom, setEndpointCustom] = useState('')
  const [endpointReady, setEndpointReady] = useState(false)

  const loadSessions = useCallback(async (): Promise<void> => {
    setSessions(await api.ai.sessions())
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [endpoint, list, addresses] = await Promise.all([
        api.ai.info(),
        api.ai.sessions(),
        api.ai.bindAddresses()
      ])
      setInfo(endpoint)
      setSessions(list)
      setBindings(addresses)
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // Follow the live binding after load or after "Apply"; a manual selection is
  // left alone until the server actually rebinds.
  useEffect(() => {
    if (info) setSelectedHost(info.host)
  }, [info])

  // Remember which address the client uses (e.g. the VM's NAT gateway) so the
  // copied command stays stable across dialog opens and restarts.
  useEffect(() => {
    if (!info) {
      setEndpointReady(false)
      return
    }
    let saved: string | null = null
    try {
      saved = window.localStorage.getItem(ENDPOINT_HOST_STORAGE_KEY)
    } catch {
      /* storage may be unavailable; fall back to the default host */
    }
    const initial = initialEndpointHost(info, bindings, saved)
    setEndpointHost(initial.host)
    setEndpointCustom(initial.custom)
    setEndpointReady(true)
  }, [info, bindings])

  useEffect(() => {
    if (!endpointReady) return
    const host =
      endpointHost === 'custom' ? normalizeEndpointHost(endpointCustom) : endpointHost
    if (!host || !isPlausibleHost(host)) return
    try {
      window.localStorage.setItem(ENDPOINT_HOST_STORAGE_KEY, host)
    } catch {
      /* storage may be unavailable; the current session still works */
    }
  }, [endpointReady, endpointHost, endpointCustom])

  // Keep the byte counts and status dots current while the dialog is open.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadSessions().catch(() => {
        /* the dialog keeps the last list on a transient IPC failure */
      })
    }, 2000)
    return () => window.clearInterval(timer)
  }, [loadSessions])

  const copy = async (key: string, text: string): Promise<void> => {
    try {
      await api.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied((current) => (current === key ? '' : current)), 1600)
    } catch (err) {
      addToast(
        'error',
        tr(`复制失败：${(err as Error).message}`, `Copy failed: ${(err as Error).message}`)
      )
    }
  }

  const stopWatching = async (runtimeId: string): Promise<void> => {
    try {
      await setAiWatch(runtimeId, false)
      await loadSessions()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const setMode = async (
    item: AiSessionSummary,
    mode: 'off' | 'manual' | 'auto'
  ): Promise<void> => {
    try {
      await setAiInputMode(item.runtimeId, mode)
      await loadSessions()
      addToast(
        'info',
        mode === 'off'
          ? tr('已禁止 AI 向该会话输入', 'AI input disabled for this session')
          : mode === 'auto'
            ? tr(
                '已开启自动输入：AI 写入将直接发送，不再逐条确认',
                'Auto input on: AI writes are sent without asking each time'
              )
            : tr(
                '已允许 AI 申请输入；每次写入仍需你确认',
                'AI may now request input; each write still needs your approval'
              )
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const applyHost = async (): Promise<void> => {
    if (applying || (info && selectedHost === info.host)) return
    setApplying(true)
    setHostError('')
    try {
      const next = await api.ai.setHost(selectedHost)
      setInfo(next)
      addToast('info', tr(`MCP 监听地址已切换为 ${next.host}`, `MCP is now listening on ${next.host}`))
    } catch (err) {
      setHostError((err as Error).message)
    } finally {
      setApplying(false)
    }
  }

  const allowedHosts = useMemo(
    () => (info ? endpointHosts(info, bindings) : []),
    [info, bindings]
  )
  const allowCustom = info?.host === ANY_HOST
  const chosenHost =
    endpointHost === 'custom' ? normalizeEndpointHost(endpointCustom) : endpointHost
  const endpointValid = isPlausibleHost(chosenHost)
  const endpoint = !info
    ? ''
    : endpointValid
      ? endpointUrl(info, chosenHost)
      : `http://${chosenHost || '…'}:${info.port}/mcp`
  const command =
    info && endpointValid
      ? `claude mcp add --transport http hshell ${endpoint} --header "Authorization: Bearer ${info.token}"`
      : ''
  const endpointOptions = [
    ...allowedHosts.map((host) => {
      if (host === LOOPBACK) {
        return { value: host, label: tr('本机回环 · 127.0.0.1', 'Loopback · 127.0.0.1') }
      }
      const binding = bindings.find((item) => item.address === host)
      return { value: host, label: binding ? `${binding.name} · ${host}` : host }
    }),
    ...(allowCustom
      ? [{ value: 'custom', label: tr('自定义地址…', 'Custom address…') }]
      : [])
  ]
  const exposed = !!info && info.host !== '127.0.0.1'
  const bindOptions = [
    {
      value: '127.0.0.1',
      label: tr('仅本机（127.0.0.1）', 'This machine only (127.0.0.1)')
    },
    {
      value: '0.0.0.0',
      label: tr('所有网卡（0.0.0.0）', 'All interfaces (0.0.0.0)')
    },
    ...bindings.map((item) => ({
      value: item.address,
      label: `${item.name} · ${item.address}`
    }))
  ]
  if (!bindOptions.some((option) => option.value === selectedHost)) {
    bindOptions.push({ value: selectedHost, label: selectedHost })
  }

  return (
    <Modal
      title={tr('AI 访问（MCP）', 'AI access (MCP)')}
      subtitle={
        exposed
          ? tr(
              `输入默认需审批 · 监听 ${info?.host}`,
              `Input needs approval by default · listening on ${info?.host}`
            )
          : tr(
              '输入默认需审批 · 仅本机回环地址',
              'Input needs approval by default · loopback only'
            )
      }
      onClose={() => setOpen(false)}
      width={680}
      footer={
        <>
          <span className="ai-footer-hint">
            {exposed
              ? tr(
                  '服务监听在非回环地址，同一网络内拿到令牌的主机都能读取已观察的会话。',
                  'The server is on a non-loopback address; any reachable host with the token can read watched sessions.'
                )
              : tr(
                  '服务只监听 127.0.0.1，并校验 Bearer 令牌与 Origin。',
                  'The server listens on 127.0.0.1 only and checks the bearer token and Origin.'
                )}
          </span>
          <button className="btn" onClick={() => setOpen(false)}>
            {tr('关闭', 'Close')}
          </button>
        </>
      }
    >
      <p className="form-hint">
        {tr(
          'HShell 在本机提供一个 MCP 服务。只有下方列出的会话对 AI 可见；AI 可以读取输出和输入历史。对允许输入的会话，默认每次写入都会弹出审批；也可以为单个会话开启「自动输入」，让写入直接发送（默认关闭，建议只对可信会话使用）。',
          'HShell exposes an MCP server on this machine. Only the sessions listed below are visible; AI can read output and input history. Sessions you allow input on ask before every write by default; you can also enable “Auto input” per session to send writes without asking (off by default; use it only for sessions you trust).'
        )}
      </p>
      <p className="form-hint ai-warning">
        {tr(
          '注意：输出和输入都会被缓存，包括在会话中键入的密码等敏感内容；AI 写入的文本还会进入 ai-input.log。只对信任的 AI 客户端开启。',
          'Note: output and input are buffered, including sensitive text such as a password typed at a prompt; text sent by AI is also written to ai-input.log. Only enable this for AI clients you trust.'
        )}
      </p>

      {error ? <div className="form-error">{error}</div> : null}
      {loading && !info ? <div className="form-hint">{tr('正在读取…', 'Loading…')}</div> : null}
      {!loading && !info ? (
        <div className="form-hint">
          {tr(
            'MCP 服务未启动，可换一个监听地址重试。',
            'The MCP server is not running. Try a different listen address.'
          )}
        </div>
      ) : null}

      <div className="field ai-bind">
        <span>{tr('MCP 监听地址', 'MCP listen address')}</span>
        <div className="ai-host-row">
          <select
            value={selectedHost}
            onChange={(event) => setSelectedHost(event.target.value)}
            disabled={applying}
          >
            {bindOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            className="btn btn-small"
            disabled={applying || (info ? selectedHost === info.host : false)}
            onClick={() => void applyHost()}
          >
            {applying ? tr('应用中…', 'Applying…') : tr('应用', 'Apply')}
          </button>
        </div>
        <p className="form-hint">
          {tr(
            '默认仅本机。要让虚拟机访问，请选择宿主机的 Host-Only 或桥接网卡地址，并在 Windows 防火墙放行该端口；VirtualBox NAT 可选「所有网卡」，虚拟机用 10.0.2.2 连接。切换会重启 MCP 服务，已连接的客户端需要重连。',
            'Loopback by default. For a VM, pick the host’s Host-Only or bridged adapter and allow the port in Windows Firewall; with VirtualBox NAT choose “All interfaces” and connect via 10.0.2.2. Applying restarts the MCP server, so connected clients must reconnect.'
          )}
        </p>
        {selectedHost !== '127.0.0.1' ? (
          <p className="form-hint ai-warning">
            {tr(
              '非本机监听：同一网络内拿到令牌的主机都能读取已观察的会话。',
              'Non-loopback: any host on that network with the token can read watched sessions.'
            )}
          </p>
        ) : null}
        {hostError ? <div className="form-error">{hostError}</div> : null}
      </div>

      {info ? (
        <>
          {endpointOptions.length > 1 ? (
            <div className="field ai-endpoint-field">
              <span>{tr('客户端访问地址', 'Client address')}</span>
              <div className="ai-host-row">
                <select
                  value={endpointHost}
                  onChange={(event) => {
                    const value = event.target.value
                    setEndpointHost(value)
                    if (value !== 'custom') {
                      setEndpointCustom('')
                      try {
                        window.localStorage.setItem(ENDPOINT_HOST_STORAGE_KEY, value)
                      } catch {
                        /* storage may be unavailable; the current session still works */
                      }
                    }
                  }}
                >
                  {endpointOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {endpointHost === 'custom' ? (
                  <input
                    value={endpointCustom}
                    onChange={(event) => setEndpointCustom(event.target.value)}
                    placeholder={tr('10.0.2.2 或域名', '10.0.2.2 or hostname')}
                    spellCheck={false}
                  />
                ) : null}
              </div>
              <p className="form-hint">
                {tr(
                  '只决定复制给客户端的地址，不会重启 MCP 服务。客户端与 HShell 同机时用本机回环；虚拟机访问宿主机时选宿主机的虚拟网卡（如 VMware VMnet8、VirtualBox Host-Only）；端口转发、VirtualBox NAT（10.0.2.2）或域名请选「自定义地址」。',
                  'Only changes the address copied for clients; the server is not restarted. Use loopback when the client runs on the same machine; pick the host’s virtual adapter (VMware VMnet8, VirtualBox Host-Only) for a VM; choose a custom address for port forwarding, VirtualBox NAT (10.0.2.2) or a hostname.'
                )}
              </p>
            </div>
          ) : null}

          <label className="field ai-endpoint-field">
            <span>{tr('MCP 地址', 'MCP endpoint')}</span>
            <div className="ai-code-row">
              <code className="ai-code">{endpoint}</code>
              <button
                className="icon-btn"
                title={tr('复制地址', 'Copy URL')}
                disabled={!endpointValid}
                onClick={() => void copy('url', endpoint)}
              >
                <Icon name={copied === 'url' ? 'check' : 'copy'} size={14} />
              </button>
            </div>
            {!endpointValid ? (
              <div className="form-error">
                {tr(
                  '访问地址格式不正确，请填写主机名或 IP。',
                  'Invalid client address; enter a hostname or IP.'
                )}
              </div>
            ) : null}
          </label>

          <label className="field ai-endpoint-field">
            <span>{tr('访问令牌', 'Access token')}</span>
            <div className="ai-code-row">
              <code className="ai-code ai-token">{info.token}</code>
              <button
                className="icon-btn"
                title={tr('复制令牌', 'Copy token')}
                onClick={() => void copy('token', info.token)}
              >
                <Icon name={copied === 'token' ? 'check' : 'copy'} size={14} />
              </button>
            </div>
          </label>

          <div className="field ai-endpoint-field">
            <span>{tr('注册到 Claude Code', 'Register with Claude Code')}</span>
            <div className="ai-code-row ai-command">
              <pre className="ai-code">
                {command ||
                  tr('请先填写有效的访问地址。', 'Enter a valid client address first.')}
              </pre>
              <button
                className="icon-btn"
                title={tr('复制命令', 'Copy command')}
                disabled={!endpointValid}
                onClick={() => void copy('command', command)}
              >
                <Icon name={copied === 'command' ? 'check' : 'copy'} size={14} />
              </button>
            </div>
            <p className="form-hint">
              {tr(
                '也可以把地址和令牌填入任何支持 HTTP MCP 的客户端。',
                'You can also use the URL and token with any client that supports HTTP MCP.'
              )}
            </p>
          </div>

          <div className="ai-sessions">
            <div className="ai-sessions-head">
              <span>{tr('允许 AI 观察的会话', 'Sessions visible to AI')}</span>
              <button
                className="icon-btn"
                title={tr('刷新', 'Refresh')}
                onClick={() => void reload()}
              >
                <Icon name="refresh" size={14} />
              </button>
            </div>
            {sessions.length === 0 ? (
              <div className="form-hint">
                {tr(
                  '还没有会话开启观察。在状态栏点击「AI 观察」即可开启。',
                  'No session is being watched yet. Click “AI watch” in the status bar to enable one.'
                )}
              </div>
            ) : (
              sessions.map((item) => (
                <div key={item.runtimeId} className="ai-session-row">
                  <span className={`ai-session-dot ${item.status}`} />
                  <div className="ai-session-main">
                    <div className="ai-session-name">
                      {item.name}
                      {item.writable ? (
                        <span className="ai-writable-badge">{tr('可输入', 'input')}</span>
                      ) : null}
                      {item.autoInput ? (
                        <span className="ai-auto-badge">{tr('自动', 'auto')}</span>
                      ) : null}
                    </div>
                    <div className="ai-session-meta">
                      {item.target} · {statusLabel(item.status)} ·{' '}
                      {formatBytes(item.bufferedBytes)} · #{item.firstSeq}–{item.latestSeq}
                    </div>
                  </div>
                  <div className="ai-session-actions">
                    <button
                      className="btn btn-small"
                      onClick={() => void setMode(item, item.writable ? 'off' : 'manual')}
                    >
                      {item.writable ? tr('禁止输入', 'Block input') : tr('允许输入', 'Allow input')}
                    </button>
                    <button
                      className={`btn btn-small${item.autoInput ? ' ai-auto-btn' : ''}`}
                      disabled={!item.writable}
                      title={
                        item.autoInput
                          ? tr('恢复逐条确认', 'Ask before each write again')
                          : tr(
                              'AI 写入直接发送，不再逐条确认；仅对可信会话使用',
                              'Send AI writes without asking each time; only for trusted sessions'
                            )
                      }
                      onClick={() => void setMode(item, item.autoInput ? 'manual' : 'auto')}
                    >
                      {item.autoInput ? tr('取消自动', 'Stop auto') : tr('自动输入', 'Auto input')}
                    </button>
                    <button
                      className="btn btn-small"
                      onClick={() => void stopWatching(item.runtimeId)}
                    >
                      {tr('停止观察', 'Stop')}
                    </button>
                  </div>
                </div>
              ))
            )}
            <p className="form-hint">
              {tr(
                '「允许输入」后 AI 才能申请写入；默认每次写入都会在 HShell 弹出窗口，确认后才发送。「自动输入」会跳过确认直接发送，关闭输入或停止观察时自动收回，「自动输入」也只能通过这里开启。',
                '“Allow input” lets AI request writes; by default every write opens an approval card in HShell. “Auto input” skips that card, is revoked when input or watching is turned off, and can only be enabled here.'
              )}
            </p>
          </div>
        </>
      ) : null}
    </Modal>
  )
}
