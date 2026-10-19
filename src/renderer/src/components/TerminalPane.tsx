import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Terminal, type IDecoration, type IMarker } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Session, TriggerRule } from '@shared/types'
import { isSerialSession, sessionTarget } from '@shared/session'
import { api } from '../api'
import { resolveColorScheme } from '../lib/color-schemes'
import { tr } from '../lib/i18n'
import { matchShortcut } from '../lib/shortcuts'
import { findHighlightLines, OutputRuleEngine, stripAnsi } from '../lib/output-rules'
import { recorder } from '../lib/recorder'
import { subscribeRuntimeData } from '../lib/runtime-bus'
import { registerTerminal } from '../lib/terminal-registry'
import { useApp } from '../store'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'

interface AppliedDecoration {
  decoration: IDecoration
  marker: IMarker
}

const HIGHLIGHT_BACKGROUND = '#ffd54f'
const MAX_DECORATIONS = 400

/** Decorate whole lines that match a highlight rule. */
function applyHighlights(
  term: Terminal,
  text: string,
  session: Session,
  decorations: AppliedDecoration[]
): void {
  const rules = session.highlights
  if (!text || !rules?.length) return
  for (const item of findHighlightLines(text, rules)) {
    const background =
      item.rule.background ?? (item.rule.foreground ? undefined : HIGHLIGHT_BACKGROUND)
    try {
      const marker = term.registerMarker(-item.lineFromEnd)
      if (!marker) continue
      const decoration = term.registerDecoration({
        marker,
        x: 0,
        width: term.cols,
        backgroundColor: background,
        foregroundColor: item.rule.foreground,
        layer: 'bottom'
      })
      if (!decoration) {
        marker.dispose()
        continue
      }
      decorations.push({ decoration, marker })
    } catch {
      /* the terminal may be disposing while output is still in flight */
    }
  }

  while (decorations.length > MAX_DECORATIONS) {
    decorations.shift()?.decoration.dispose()
  }
  if (decorations.length > 50) {
    for (let index = decorations.length - 1; index >= 0; index -= 1) {
      if (decorations[index].marker.isDisposed) {
        decorations[index].decoration.dispose()
        decorations.splice(index, 1)
      }
    }
  }
}

interface TerminalPaneProps {
  runtimeId: string
  session: Session
  visible: boolean
  showClose: boolean
  /** Restored panes wait for an explicit click instead of reconnecting. */
  autoConnect?: boolean
  onClose?: () => void
}

export function TerminalPane({
  runtimeId,
  session,
  visible,
  showClose,
  autoConnect = true,
  onClose
}: TerminalPaneProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const sessionRef = useRef(session)
  const triggerEngineRef = useRef(new OutputRuleEngine<TriggerRule>(1500))
  const decorationsRef = useRef<AppliedDecoration[]>([])
  sessionRef.current = session
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const status = useApp((state) => state.statuses[runtimeId])
  const connectionStatus = status?.status
  const statusMessage = status?.message
  const previousStatusRef = useRef<string | undefined>(undefined)
  const fontSize = useApp((state) => state.fontSize)
  const setActiveRuntime = useApp((state) => state.setActiveRuntime)
  const setStatus = useApp((state) => state.setStatus)
  const setRuntimeSize = useApp((state) => state.setRuntimeSize)
  const openSessionDialog = useApp((state) => state.openSessionDialog)
  const setSearchVisible = useApp((state) => state.setSearchVisible)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily:
        '"JetBrains Mono", "Cascadia Mono", "Fira Code", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
      fontSize,
      lineHeight: 1.15,
      scrollback: 8000,
      theme: resolveColorScheme(session.terminal.colorScheme, session.terminal.theme).theme,
      convertEol: false,
      macOptionIsMeta: true
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    const unicode = new Unicode11Addon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'
    term.open(container)
    terminalRef.current = term
    fitRef.current = fit

    const performFit = (): void => {
      try {
        fit.fit()
      } catch {
        /* container may be hidden */
      }
    }
    const raf = requestAnimationFrame(performFit)

    const unregister = registerTerminal({
      runtimeId,
      terminal: term,
      search,
      focus: () => term.focus(),
      fit: performFit
    })

    const decoder = new TextDecoder()
    const writeInput = (data: string): void => {
      if (!data) return
      recorder.recordInput(runtimeId, data)
      void api.ssh.write(runtimeId, data)
    }

    const unsubscribeData = subscribeRuntimeData(runtimeId, (data) => {
      const text = decoder.decode(data, { stream: true })
      recorder.recordOutput(runtimeId, text)
      term.write(data, () => {
        void api.ssh.ack(runtimeId, data.byteLength)
        applyHighlights(term, text, sessionRef.current, decorationsRef.current)
      })
      const current = sessionRef.current
      triggerEngineRef.current.feed(stripAnsi(text), current.triggers ?? [], (match) => {
        if (match.rule.action === 'send') {
          const payload = /[\r\n]$/.test(match.rule.payload)
            ? match.rule.payload
            : `${match.rule.payload}\r`
          writeInput(payload)
        } else {
          useApp.getState().addToast(
            'info',
            tr(
              `触发器「${match.rule.pattern}」：${match.rule.payload || match.match}`,
              `Trigger "${match.rule.pattern}": ${match.rule.payload || match.match}`
            )
          )
        }
      })
    })

    const dataDisposable = term.onData(writeInput)

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void api.ssh.resize(runtimeId, cols, rows)
      setRuntimeSize(runtimeId, cols, rows)
    })

    const pointerHandler = (): void => setActiveRuntime(runtimeId)
    container.addEventListener('pointerdown', pointerHandler, true)

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && matchShortcut(event)) return false
      return true
    })

    performFit()
    if (autoConnect) {
      const cols = term.cols || 80
      const rows = term.rows || 24
      api.ssh
        .connect({ runtimeId, session, cols, rows })
        .catch((error) => setStatus(runtimeId, 'failed', (error as Error).message))
    } else {
      setStatus(runtimeId, 'idle')
    }

    const observer = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) performFit()
    })
    observer.observe(container)
    window.addEventListener('resize', performFit)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', performFit)
      container.removeEventListener('pointerdown', pointerHandler, true)
      unsubscribeData()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      unregister()
      decorationsRef.current.forEach((item) => item.decoration.dispose())
      decorationsRef.current = []
      triggerEngineRef.current.reset()
      webglRef.current?.dispose()
      webglRef.current = null
      terminalRef.current = null
      term.dispose()
      void api.ssh.disconnect(runtimeId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeId, autoConnect])

  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    term.options.fontSize = fontSize
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
    })
  }, [fontSize])

  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    term.options.theme = resolveColorScheme(
      session.terminal.colorScheme,
      session.terminal.theme
    ).theme
  }, [session.terminal.colorScheme, session.terminal.theme])

  // Echo connection state changes into the terminal itself. The status bar and
  // the overlay pill are easy to miss; a line in the scrollback makes an
  // unexpected disconnect obvious and tells the user how to get back.
  useEffect(() => {
    const previous = previousStatusRef.current
    previousStatusRef.current = connectionStatus
    if (!connectionStatus || previous === connectionStatus) return
    const term = terminalRef.current
    if (!term) return
    const notice = (text: string, color = 33): void => {
      term.write(`\r\n\x1b[${color}m[HShell] ${text}\x1b[0m\r\n`)
    }
    if (
      connectionStatus === 'reconnecting' &&
      (previous === 'connected' || previous === 'authenticating')
    ) {
      notice(
        tr(
          '连接已断开，正在自动重连…（Ctrl+Shift+W 可停止重试）',
          'Connection lost; reconnecting… (Ctrl+Shift+W stops retrying)'
        )
      )
    } else if (connectionStatus === 'connected' && previous === 'reconnecting') {
      notice(tr('已重新连接到主机。', 'Reconnected to the host.'), 32)
    } else if (
      connectionStatus === 'closed' &&
      (previous === 'connected' || previous === 'reconnecting')
    ) {
      notice(
        tr(
          `连接已断开${statusMessage ? `：${statusMessage}` : ''}`,
          `Disconnected${statusMessage ? `: ${statusMessage}` : ''}`
        )
      )
      notice(
        tr(
          '按 Ctrl+Shift+R 重新连接，或点击终端中的「重新连接」按钮。',
          'Press Ctrl+Shift+R or click "Reconnect" in the terminal.'
        )
      )
    } else if (connectionStatus === 'failed' && previous !== 'failed') {
      notice(
        tr(
          `连接失败${statusMessage ? `：${statusMessage}` : ''}`,
          `Connection failed${statusMessage ? `: ${statusMessage}` : ''}`
        ),
        31
      )
      notice(tr('按 Ctrl+Shift+R 重试。', 'Press Ctrl+Shift+R to retry.'), 31)
    }
  }, [connectionStatus, statusMessage])

  useEffect(() => {
    if (!visible) {
      webglRef.current?.dispose()
      webglRef.current = null
      return
    }
    const term = terminalRef.current
    if (!term) return
    try {
      if (!webglRef.current) {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl.dispose()
          webglRef.current = null
        })
        term.loadAddon(webgl)
        webglRef.current = webgl
      }
    } catch {
      /* fall back to the DOM renderer */
    }
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      term.focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      webglRef.current?.dispose()
      webglRef.current = null
    }
  }, [visible])

  const retry = (): void => {
    const term = terminalRef.current
    setStatus(runtimeId, 'connecting')
    void api.ssh
      .connect({
        runtimeId,
        session,
        cols: term?.cols || 80,
        rows: term?.rows || 24
      })
      .catch((error) => setStatus(runtimeId, 'failed', (error as Error).message))
  }

  const menuItems: ContextMenuItem[] = [
    {
      label: tr('复制', 'Copy'),
      icon: 'copy',
      onClick: () => {
        const selection = terminalRef.current?.getSelection()
        if (selection) void api.clipboard.writeText(selection)
      }
    },
    {
      label: tr('粘贴', 'Paste'),
      icon: 'clipboard',
      onClick: () => {
        void api.clipboard.readText().then((text) => {
          if (text) terminalRef.current?.paste(text)
        })
      }
    },
    {
      label: tr('全选', 'Select all'),
      onClick: () => terminalRef.current?.selectAll()
    },
    { label: '', separator: true },
    {
      label: tr('查找…', 'Find…'),
      icon: 'search',
      onClick: () => setSearchVisible(true)
    },
    {
      label: tr('清屏', 'Clear'),
      onClick: () => terminalRef.current?.clear()
    }
  ]

  const currentStatus = status?.status ?? 'connecting'

  return (
    <div
      className="terminal-pane"
      style={{
        background: resolveColorScheme(session.terminal.colorScheme, session.terminal.theme)
          .theme.background
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <div className="terminal-container" ref={containerRef} />

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

      {currentStatus === 'connecting' || currentStatus === 'authenticating' ? (
        <div className="terminal-status-pill">
          <span className="spinner" />
          {tr('正在连接', 'Connecting to')} {sessionTarget(session)}…
        </div>
      ) : null}

      {currentStatus === 'reconnecting' ? (
        <div className="terminal-status-pill">
          <span className="spinner" />
          {status?.message || tr('正在重连…', 'Reconnecting…')}
        </div>
      ) : null}

      {currentStatus === 'idle' ? (
        <div className="terminal-status-pill closed">
          <span>{tr('已恢复上次布局', 'Restored layout')}</span>
          <button className="pill-btn" onClick={retry}>
            {tr('连接', 'Connect')}
          </button>
        </div>
      ) : null}

      {currentStatus === 'closed' ? (
        <div className="terminal-status-pill closed">
          <span>{tr('连接已断开', 'Disconnected')}</span>
          <button className="pill-btn" onClick={retry}>
            {tr('重新连接', 'Reconnect')}
          </button>
        </div>
      ) : null}

      {currentStatus === 'failed' ? (
        <div className="terminal-error">
          <div className="terminal-error-icon">
            <Icon name="alert-triangle" size={22} />
          </div>
          <div className="terminal-error-text">
            <strong>{tr('连接失败', 'Connection failed')}</strong>
            <p>
              {status?.message ||
                (isSerialSession(session)
                  ? tr('无法打开串口设备', 'Could not open the serial device')
                  : tr('无法建立 SSH 连接', 'Could not establish an SSH connection'))}
            </p>
          </div>
          <div className="terminal-error-actions">
            <button className="btn btn-primary" onClick={retry}>
              {tr('重试', 'Retry')}
            </button>
            <button className="btn" onClick={() => openSessionDialog(session)}>
              {tr('编辑会话', 'Edit session')}
            </button>
          </div>
        </div>
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}
