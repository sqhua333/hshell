import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AiMcpInfo, AiSessionSummary, SshStatus } from '@shared/types'
import { api } from '../api'
import { formatBytes } from '../lib/format'
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
  const addToast = useApp((state) => state.addToast)

  const [info, setInfo] = useState<AiMcpInfo | null>(null)
  const [sessions, setSessions] = useState<AiSessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  const loadSessions = useCallback(async (): Promise<void> => {
    setSessions(await api.ai.sessions())
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [endpoint, list] = await Promise.all([api.ai.info(), api.ai.sessions()])
      setInfo(endpoint)
      setSessions(list)
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

  const command = info
    ? `claude mcp add --transport http hshell ${info.url} --header "Authorization: Bearer ${info.token}"`
    : ''

  return (
    <Modal
      title={tr('AI 访问（MCP）', 'AI access (MCP)')}
      subtitle={tr('只读 · 仅本机回环地址', 'Read-only · loopback only')}
      onClose={() => setOpen(false)}
      width={660}
      footer={
        <>
          <span className="ai-footer-hint">
            {tr(
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
          'HShell 在本机提供一个只读 MCP 服务。只有下方列出的会话对 AI 可见；AI 可以读取输出和输入历史，但不能向会话输入内容或执行命令。',
          'HShell exposes a read-only MCP server on this machine. Only the sessions listed below are visible to AI clients; AI can read output and input history but cannot type into a session or run commands.'
        )}
      </p>
      <p className="form-hint ai-warning">
        {tr(
          '注意：输出和输入都会被缓存，包括在会话中键入的密码等敏感内容。只对信任的 AI 客户端开启观察。',
          'Note: both output and input are buffered, including sensitive text such as a password typed at a prompt. Only enable watching for AI clients you trust.'
        )}
      </p>

      {error ? <div className="form-error">{error}</div> : null}
      {loading && !info ? <div className="form-hint">{tr('正在读取…', 'Loading…')}</div> : null}
      {!loading && !info ? (
        <div className="form-hint">
          {tr(
            'MCP 服务未启动，请重启 HShell 后重试。',
            'The MCP server is not running. Restart HShell and try again.'
          )}
        </div>
      ) : null}

      {info ? (
        <>
          <label className="field">
            <span>{tr('MCP 地址', 'MCP endpoint')}</span>
            <div className="ai-code-row">
              <code className="ai-code">{info.url}</code>
              <button
                className="icon-btn"
                title={tr('复制地址', 'Copy URL')}
                onClick={() => void copy('url', info.url)}
              >
                <Icon name={copied === 'url' ? 'check' : 'copy'} size={14} />
              </button>
            </div>
          </label>

          <label className="field">
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

          <div className="field">
            <span>{tr('注册到 Claude Code', 'Register with Claude Code')}</span>
            <div className="ai-code-row ai-command">
              <pre className="ai-code">{command}</pre>
              <button
                className="icon-btn"
                title={tr('复制命令', 'Copy command')}
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
                    <div className="ai-session-name">{item.name}</div>
                    <div className="ai-session-meta">
                      {item.target} · {statusLabel(item.status)} ·{' '}
                      {formatBytes(item.bufferedBytes)} · #{item.firstSeq}–{item.latestSeq}
                    </div>
                  </div>
                  <button
                    className="btn btn-small"
                    onClick={() => void stopWatching(item.runtimeId)}
                  >
                    {tr('停止观察', 'Stop')}
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </Modal>
  )
}
