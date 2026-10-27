import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Terminal, type IDecoration, type IMarker } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Session, TriggerRule } from '@shared/types'
import { isLocalSession, isSerialSession, isTelnetSession, sessionTarget } from '@shared/session'
import { api } from '../api'
import { resolveColorScheme } from '../lib/color-schemes'
import { tr } from '../lib/i18n'
import { matchShortcut } from '../lib/shortcuts'
import { findHighlightLines, OutputRuleEngine, stripAnsi } from '../lib/output-rules'
import { handlePasswordKeys } from '../lib/password-input'
import { recorder } from '../lib/recorder'
import { resolveClipboardKey } from '../lib/terminal-clipboard'
import { subscribeRuntimeAiInput, subscribeRuntimeData } from '../lib/runtime-bus'
import { formatClock } from '../lib/terminal-stamps'
import { registerTerminal } from '../lib/terminal-registry'
import { useApp } from '../store'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'

interface AppliedDecoration {
  decoration: IDecoration
  marker: IMarker
}

interface LineStamp {
  marker: IMarker
  text: string
}

const HIGHLIGHT_BACKGROUND = '#ffd54f'
const MAX_DECORATIONS = 400
/** Bound the marker list; disposed markers are pruned on every repaint. */
const MAX_LINE_STAMPS = 2000
/** How long to wait for the remote to echo AI input before giving up. */
const AI_ECHO_TIMEOUT_MS = 15_000
/** Keep enough stream to match an echo split across chunks. */
const AI_ECHO_TAIL_CHARS = 16 * 1024
/**
 * Line editors such as ble.sh erase and repaint the command after receiving
 * the input, which also disposes xterm markers on that line. Wait for the
 * repaint to settle before anchoring the decoration, and re-anchor if another
 * repaint erases it.
 */
const AI_ECHO_SETTLE_MS = 200
const AI_ECHO_RETRY_MS = 120
const AI_ECHO_RETRY_LIMIT = 15
/** Stop chasing repaints this long after the echo; the line is final by then. */
const AI_ECHO_RETRY_WINDOW_MS = 3_000
const AI_TINT = { dark: '#8b5cf6', light: '#7c3aed' } as const

type Schedule = (callback: () => void, delay?: number) => void

interface PendingAiEcho {
  text: string
  expiresAt: number
}

/** Decoration(s) marking one echoed AI input while the shell may repaint it. */
interface AiEchoAnchor {
  needle: string
  extraLines: number
  expectedLine: number
  background: string
  expiresAt: number
  attempts: number
  pending: boolean
  stopped: boolean
  /** Set while disposing our own markers, so their disposal is not retried. */
  releasing: boolean
  entries: AppliedDecoration[]
}

function parseHex(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value)
  if (!match) return null
  const int = Number.parseInt(match[1], 16)
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff]
}

/**
 * Decoration colours accept only solid #RRGGBB, so blend the AI tint over the
 * palette background ourselves: a soft band that stays readable on any theme.
 */
function aiEchoBackground(session: Session): string {
  const scheme = resolveColorScheme(session.terminal.colorScheme, session.terminal.theme)
  const background = scheme.theme.background ?? (scheme.dark ? '#000000' : '#ffffff')
  const base = parseHex(background)
  const tint = parseHex(scheme.dark ? AI_TINT.dark : AI_TINT.light)
  if (!base || !tint) return scheme.dark ? '#2a2140' : '#efe7fd'
  const alpha = scheme.dark ? 0.24 : 0.14
  const mixed = tint.map((value, index) =>
    Math.round(base[index] + (value - base[index]) * alpha)
  )
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function aiEchoDecoration(
  term: Terminal,
  lineFromEnd: number,
  background: string
): AppliedDecoration | null {
  try {
    const marker = term.registerMarker(-lineFromEnd)
    if (!marker) return null
    const decoration = term.registerDecoration({
      marker,
      x: 0,
      width: term.cols,
      backgroundColor: background,
      layer: 'bottom'
    })
    if (!decoration) {
      marker.dispose()
      return null
    }
    return { decoration, marker }
  } catch {
    /* the terminal may be disposing while output is still in flight */
    return null
  }
}

/** The expected line after a repaint, or the nearest line with the same text. */
function locateAiEchoLine(term: Terminal, expected: number, needle: string): number | null {
  const buffer = term.buffer.active
  const first = needle.split('\n')[0]
  if (!first) return null
  for (let delta = 0; delta <= 3; delta += 1) {
    const candidates = delta === 0 ? [expected] : [expected + delta, expected - delta]
    for (const candidate of candidates) {
      if (candidate < 0 || candidate >= buffer.length) continue
      const text = buffer.getLine(candidate)?.translateToString(true) ?? ''
      if (text.includes(first)) return candidate
    }
  }
  return null
}

function clearAiEchoEntries(anchor: AiEchoAnchor): void {
  anchor.releasing = true
  for (const entry of anchor.entries) {
    entry.decoration.dispose()
    if (!entry.marker.isDisposed) entry.marker.dispose()
  }
  anchor.entries = []
  anchor.releasing = false
}

function releaseAiEcho(anchor: AiEchoAnchor): void {
  anchor.stopped = true
  clearAiEchoEntries(anchor)
}

/**
 * Anchor the tint to the line the echo now sits on. The shell may erase the
 * line again to repaint it; a disposed marker then schedules another attempt
 * until the line settles.
 */
function anchorAiEcho(term: Terminal, anchor: AiEchoAnchor, schedule: Schedule): void {
  if (anchor.stopped) return
  clearAiEchoEntries(anchor)
  const line = locateAiEchoLine(term, anchor.expectedLine, anchor.needle)
  if (line === null) {
    retryAiEcho(term, anchor, schedule)
    return
  }
  anchor.expectedLine = line
  const buffer = term.buffer.active
  const cursorLine = buffer.baseY + buffer.cursorY
  for (let index = 0; index <= anchor.extraLines; index += 1) {
    const lineFromEnd = cursorLine - (line + index)
    if (lineFromEnd < 0) continue
    const entry = aiEchoDecoration(term, lineFromEnd, anchor.background)
    if (!entry) continue
    entry.marker.onDispose(() => {
      if (anchor.stopped || anchor.releasing) return
      retryAiEcho(term, anchor, schedule)
    })
    anchor.entries.push(entry)
  }
  if (anchor.entries.length === 0) retryAiEcho(term, anchor, schedule)
}

function retryAiEcho(term: Terminal, anchor: AiEchoAnchor, schedule: Schedule): void {
  if (anchor.stopped || anchor.pending) return
  if (anchor.attempts >= AI_ECHO_RETRY_LIMIT || Date.now() > anchor.expiresAt) return
  anchor.attempts += 1
  anchor.pending = true
  schedule(() => {
    anchor.pending = false
    anchorAiEcho(term, anchor, schedule)
  }, AI_ECHO_RETRY_MS)
}

/**
 * Mark the line(s) the remote echoed an approved AI input on. The text comes
 * from the writer before the echo arrives; matching it in the output keeps the
 * highlight off the shell's own prompt and output. Anchoring is delayed until
 * the line editor finishes repainting the line.
 */
function applyAiInputEcho(
  term: Terminal,
  stream: string,
  pending: PendingAiEcho[],
  anchors: AiEchoAnchor[],
  session: Session,
  now: number,
  schedule: Schedule
): void {
  if (pending.length === 0 || !stream) return
  // The tty translates the input's Enters into CR LF; ignore CR so the match
  // does not depend on how the echo spells the line break.
  const clean = stripAnsi(stream).replace(/\r/g, '')
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const item = pending[index]
    if (now > item.expiresAt) {
      pending.splice(index, 1)
      continue
    }
    const needle = stripAnsi(item.text)
      .replace(/\r/g, '')
      .replace(/\n+$/, '')
    if (!needle) {
      pending.splice(index, 1)
      continue
    }
    // A repainting line editor can echo the text twice; the later occurrence
    // is the one that ends up on screen with the prompt.
    const at = clean.lastIndexOf(needle)
    if (at < 0) continue
    pending.splice(index, 1)
    const startFromEnd = (clean.slice(at).match(/\n/g) ?? []).length
    const buffer = term.buffer.active
    const anchor: AiEchoAnchor = {
      needle,
      extraLines: (needle.match(/\n/g) ?? []).length,
      expectedLine: buffer.baseY + buffer.cursorY - startFromEnd,
      background: aiEchoBackground(session),
      expiresAt: now + AI_ECHO_RETRY_WINDOW_MS,
      attempts: 0,
      pending: false,
      stopped: false,
      releasing: false,
      entries: []
    }
    anchors.push(anchor)
    while (anchors.length > 8) releaseAiEcho(anchors.shift()!)
    schedule(() => anchorAiEcho(term, anchor, schedule), AI_ECHO_SETTLE_MS)
  }
}

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
  const stampsRef = useRef<HTMLDivElement>(null)
  const stampsScheduleRef = useRef<(() => void) | null>(null)
  const showTimestamps = session.terminal.showTimestamps ?? false
  const stampsEnabledRef = useRef(showTimestamps)
  stampsEnabledRef.current = showTimestamps
  sessionRef.current = session
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const status = useApp((state) => state.statuses[runtimeId])
  const connectionStatus = status?.status
  const failureDismissed = useApp((state) => state.failedDismissed[runtimeId] ?? false)
  const statusMessage = status?.message
  const passwordPrompt = useApp((state) => state.passwordPrompt)
  const passwordPromptRef = useRef(passwordPrompt)
  passwordPromptRef.current = passwordPrompt
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
      macOptionIsMeta: true,
      // Right-click copies a selection or opens our menu; word selection
      // would fight both behaviors.
      rightClickSelectsWord: false
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
    // When password authentication fails the terminal itself asks for the
    // password; its input must not reach the (already closed) SSH channel.
    let passwordValue = ''
    const handlePasswordInput = (data: string): boolean => {
      const prompt = passwordPromptRef.current
      if (!prompt || prompt.runtimeId !== runtimeId) return false
      const result = handlePasswordKeys(passwordValue, data)
      passwordValue = result.input
      if (result.echo) term.write(result.echo)
      if (result.action === 'cancel') {
        passwordValue = ''
        term.write('^C\r\n')
        useApp.getState().setPasswordPrompt(null)
        void api.ssh.cancelPassword(prompt.requestId).catch(() => undefined)
        return true
      }
      if (result.action === 'submit') {
        if (!passwordValue) {
          term.write('\x07')
          return true
        }
        const password = passwordValue
        passwordValue = ''
        term.write('\r\n')
        useApp.getState().setPasswordPrompt(null)
        void api.ssh.providePassword(prompt.requestId, password).catch((error) => {
          useApp.getState().setStatus(runtimeId, 'failed', (error as Error).message)
        })
      }
      return true
    }
    const writeInput = (data: string): void => {
      if (!data) return
      if (handlePasswordInput(data)) return
      recorder.recordInput(runtimeId, data)
      void api.ssh.write(runtimeId, data)
    }

    // Timestamp gutter: markers follow lines as scrollback trims, so the
    // overlay only needs each marker's current line number.
    const lineStamps: LineStamp[] = []
    let lastStampMarker: IMarker | null = null
    let stampsRaf = 0
    let stampsSignature = ''

    const stampLine = (): void => {
      if (!stampsEnabledRef.current) return
      const buffer = term.buffer.active
      const currentLine = buffer.baseY + buffer.cursorY
      if (lastStampMarker && !lastStampMarker.isDisposed && lastStampMarker.line === currentLine) {
        return
      }
      try {
        const marker = term.registerMarker(0)
        if (!marker) return
        lineStamps.push({ marker, text: formatClock() })
        lastStampMarker = marker
        while (lineStamps.length > MAX_LINE_STAMPS) lineStamps.shift()?.marker.dispose()
      } catch {
        /* terminal may be disposing while output is in flight */
      }
    }

    const renderStamps = (): void => {
      stampsRaf = 0
      const host = stampsRef.current
      if (!host) return
      if (!stampsEnabledRef.current) {
        if (host.childElementCount) host.replaceChildren()
        stampsSignature = ''
        return
      }
      const buffer = term.buffer.active
      const screen = term.element?.querySelector('.xterm-screen')
      const cellHeight =
        screen && term.rows > 0 ? screen.getBoundingClientRect().height / term.rows : 0
      if (lineStamps.length > 200) {
        for (let index = lineStamps.length - 1; index >= 0; index -= 1) {
          if (lineStamps[index].marker.isDisposed) lineStamps.splice(index, 1)
        }
      }
      const byLine = new Map<number, string>()
      for (const item of lineStamps) {
        if (!item.marker.isDisposed) byLine.set(item.marker.line, item.text)
      }
      const rows: Array<{ text: string }> = []
      const signature: string[] = []
      for (let row = 0; row < term.rows; row += 1) {
        const line = buffer.viewportY + row
        // A wrapped continuation shares the logical line; the stamp belongs
        // on its first visual row only.
        const wrapped = buffer.getLine(line)?.isWrapped ?? false
        const text = wrapped ? '' : (byLine.get(line) ?? '')
        rows.push({ text })
        signature.push(`${line}:${wrapped ? 1 : 0}:${text}`)
      }
      const next = `${cellHeight}|${rows.length}|${signature.join('|')}`
      if (next === stampsSignature && host.childElementCount === rows.length) return
      stampsSignature = next
      const fragment = document.createDocumentFragment()
      for (const row of rows) {
        const element = document.createElement('div')
        element.className = 'terminal-stamp'
        if (cellHeight) {
          element.style.height = `${cellHeight}px`
          element.style.lineHeight = `${cellHeight}px`
        }
        element.textContent = row.text
        fragment.appendChild(element)
      }
      host.replaceChildren(fragment)
    }
    const scheduleStamps = (): void => {
      if (!stampsRaf) stampsRaf = requestAnimationFrame(renderStamps)
    }
    stampsScheduleRef.current = scheduleStamps

    const lineFeedDisposable = term.onLineFeed(stampLine)
    const renderDisposable = term.onRender(scheduleStamps)
    const scrollDisposable = term.onScroll(() => scheduleStamps())

    // AI input is echoed by the remote; remember what was typed so the echo can
    // be tinted. Resetting the tail avoids matching a previous identical echo.
    const pendingAiEchoes: PendingAiEcho[] = []
    const aiEchoAnchors: AiEchoAnchor[] = []
    let aiEchoTail = ''
    const aiSettleTimers = new Set<number>()
    const scheduleAiSettle: Schedule = (callback, delay = AI_ECHO_SETTLE_MS) => {
      const timer = window.setTimeout(() => {
        aiSettleTimers.delete(timer)
        callback()
      }, delay)
      aiSettleTimers.add(timer)
    }
    const unsubscribeAiInput = subscribeRuntimeAiInput(runtimeId, (text) => {
      aiEchoTail = ''
      pendingAiEchoes.push({ text, expiresAt: Date.now() + AI_ECHO_TIMEOUT_MS })
      while (pendingAiEchoes.length > 8) pendingAiEchoes.shift()
    })

    const unsubscribeData = subscribeRuntimeData(runtimeId, (data) => {
      const text = decoder.decode(data, { stream: true })
      recorder.recordOutput(runtimeId, text)
      // Mark the line before this chunk is parsed when output starts at column
      // zero (first prompt, or a chunk beginning a new line).
      if (stampsEnabledRef.current && term.buffer.active.cursorX === 0) stampLine()
      term.write(data, () => {
        void api.ssh.ack(runtimeId, data.byteLength)
        applyHighlights(term, text, sessionRef.current, decorationsRef.current)
        aiEchoTail = (aiEchoTail + text).slice(-AI_ECHO_TAIL_CHARS)
        applyAiInputEcho(
          term,
          aiEchoTail,
          pendingAiEchoes,
          aiEchoAnchors,
          sessionRef.current,
          Date.now(),
          scheduleAiSettle
        )
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
      if (event.type !== 'keydown') return true
      if (matchShortcut(event)) return false
      // While the inline password prompt is active, Ctrl+C must cancel it
      // rather than copy whatever happens to be selected in the scrollback.
      const passwordActive = passwordPromptRef.current?.runtimeId === runtimeId
      const action = resolveClipboardKey(
        event,
        api.app.platform,
        !passwordActive && term.hasSelection()
      )
      if (action === 'pass') return true
      event.preventDefault()
      const state = useApp.getState()
      if (action === 'copy') void state.copySelection(runtimeId)
      else void state.pasteClipboard(runtimeId)
      return false
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
      unsubscribeAiInput()
      aiSettleTimers.forEach((timer) => window.clearTimeout(timer))
      aiSettleTimers.clear()
      aiEchoAnchors.forEach(releaseAiEcho)
      dataDisposable.dispose()
      resizeDisposable.dispose()
      lineFeedDisposable.dispose()
      renderDisposable.dispose()
      scrollDisposable.dispose()
      if (stampsRaf) cancelAnimationFrame(stampsRaf)
      stampsRaf = 0
      stampsScheduleRef.current = null
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
      stampsScheduleRef.current?.()
    })
  }, [fontSize])

  // Toggling the gutter changes the terminal width, so refit and repaint.
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      stampsScheduleRef.current?.()
      if (showTimestamps) term.refresh(0, term.rows - 1)
    })
    return () => cancelAnimationFrame(raf)
  }, [showTimestamps])

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
        isLocalSession(sessionRef.current)
          ? tr(
              `本地终端已退出${statusMessage ? `：${statusMessage}` : ''}`,
              `Local shell exited${statusMessage ? `: ${statusMessage}` : ''}`
            )
          : tr(
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
        isLocalSession(sessionRef.current)
          ? tr(
              `本地终端启动失败${statusMessage ? `：${statusMessage}` : ''}`,
              `Could not start the local shell${statusMessage ? `: ${statusMessage}` : ''}`
            )
          : tr(
              `连接失败${statusMessage ? `：${statusMessage}` : ''}`,
              `Connection failed${statusMessage ? `: ${statusMessage}` : ''}`
            ),
        31
      )
      notice(tr('按 Ctrl+Shift+R 重试。', 'Press Ctrl+Shift+R to retry.'), 31)
    }
  }, [connectionStatus, statusMessage])

  // Password authentication failed: ask for the password in the terminal and
  // keep the keystrokes local (see handlePasswordInput above).
  useEffect(() => {
    if (!passwordPrompt || passwordPrompt.runtimeId !== runtimeId) return
    const term = terminalRef.current
    if (!term) return
    const title =
      passwordPrompt.attempt > 1
        ? tr('密码不正确，请重新输入密码', 'Incorrect password; try again')
        : tr('密码认证失败，请输入密码', 'Password authentication failed; enter password')
    term.write(
      `\r\n\x1b[33m[HShell] ${title}（${passwordPrompt.username}@${passwordPrompt.host}）\x1b[0m\r\n`
    )
    term.write(
      `\x1b[33m${tr('输入不会显示，回车确认，Ctrl+C 取消。', 'Input is hidden. Enter confirms, Ctrl+C cancels.')}\x1b[0m\r\n`
    )
    term.write(tr('密码：', 'Password: '))
    term.focus()
  }, [passwordPrompt, runtimeId])

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

  const isMac = api.app.platform === 'darwin'
  const hasSelection = Boolean(terminalRef.current?.hasSelection())
  const menuItems: ContextMenuItem[] = [
    {
      label: tr('复制', 'Copy'),
      icon: 'copy',
      hint: isMac ? 'Cmd+C' : 'Ctrl+C',
      disabled: !hasSelection,
      onClick: () => void useApp.getState().copySelection(runtimeId)
    },
    {
      label: tr('粘贴', 'Paste'),
      icon: 'clipboard',
      hint: isMac ? 'Cmd+V' : 'Ctrl+V',
      onClick: () => void useApp.getState().pasteClipboard(runtimeId)
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
        // Right click pastes, like most terminal emulators. Shift+right click
        // still opens the actions menu (copy, select all, find, clear).
        if (!event.shiftKey) {
          void useApp.getState().pasteClipboard(runtimeId)
          return
        }
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      {showTimestamps ? (
        <div
          className="terminal-stamps"
          ref={stampsRef}
          aria-hidden="true"
          style={{
            color: resolveColorScheme(session.terminal.colorScheme, session.terminal.theme)
              .theme.foreground
          }}
        />
      ) : null}
      <div
        className={`terminal-container${showTimestamps ? ' with-stamps' : ''}`}
        ref={containerRef}
      />

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
          <span>
            {isLocalSession(session)
              ? tr('本地终端已退出', 'Local shell exited')
              : tr('连接已断开', 'Disconnected')}
          </span>
          <button className="pill-btn" onClick={retry}>
            {isLocalSession(session) ? tr('重新启动', 'Restart') : tr('重新连接', 'Reconnect')}
          </button>
        </div>
      ) : null}

      {currentStatus === 'failed' && !failureDismissed ? (
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
                  : isLocalSession(session)
                    ? tr('无法启动本地终端', 'Could not start the local shell')
                    : isTelnetSession(session)
                      ? tr('无法建立 Telnet 连接', 'Could not establish a Telnet connection')
                      : tr('无法建立 SSH 连接', 'Could not establish an SSH connection'))}
            </p>
          </div>
          <div className="terminal-error-actions">
            <button className="btn btn-primary" onClick={retry}>
              {tr('重试', 'Retry')}
            </button>
            {isLocalSession(session) ? null : (
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
            )}
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
