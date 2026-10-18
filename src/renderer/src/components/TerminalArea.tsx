import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import { sessionTarget } from '@shared/session'
import type { SplitDirection } from '@shared/types'
import { isElectron } from '../api'
import { tr } from '../lib/i18n'
import { computeGeometry, type SplitGeometry } from '../lib/pane-layout'
import { getTerminal } from '../lib/terminal-registry'
import { useApp } from '../store'
import { Icon } from './Icon'
import { SessionDock } from './SessionDock'
import { TabBar } from './TabBar'
import { TerminalPane } from './TerminalPane'

function Welcome(): ReactElement {
  const sessions = useApp((state) => state.sessions)
  const openSession = useApp((state) => state.openSession)
  const openSessionDialog = useApp((state) => state.openSessionDialog)

  return (
    <div className="welcome">
      <div className="welcome-logo">
        <Icon name="terminal" size={34} />
      </div>
      <h1>HShell</h1>
      <p className="welcome-sub">{tr('安全、简洁的跨平台 SSH / 串口客户端', 'A secure, focused cross-platform SSH and serial client')}</p>

      <div className="welcome-actions">
        <button className="btn btn-primary" onClick={() => openSessionDialog(null)}>
          <Icon name="plus" size={15} />
          {tr('新建会话', 'New session')}
        </button>
        {sessions[0] ? (
          <button className="btn" onClick={() => openSession(sessions[0])}>
            <Icon name="terminal" size={15} />
            {tr('连接', 'Connect')} {sessions[0].name}
          </button>
        ) : null}
      </div>

      {sessions.length > 0 ? (
        <div className="welcome-recent">
          <div className="welcome-section">{tr('最近会话', 'Recent sessions')}</div>
          <div className="welcome-grid">
            {sessions.slice(0, 4).map((session) => (
              <button
                className="welcome-card"
                key={session.id}
                onClick={() => openSession(session)}
              >
                <span
                  className="welcome-card-dot"
                  style={{ background: session.color || 'var(--accent)' }}
                />
                <span className="welcome-card-text">
                  <strong>{session.name}</strong>
                  <span>{sessionTarget(session)}</span>
                </span>
                <Icon name="chevron-right" size={14} className="welcome-card-arrow" />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="welcome-hints">
        <span>
          <kbd>Ctrl+N</kbd> {tr('新建会话', 'New session')}
        </span>
        <span>
          <kbd>Ctrl+T</kbd> {tr('新建标签', 'New tab')}
        </span>
        <span>
          <kbd>Ctrl+Shift+F</kbd> {tr('查找', 'Find')}
        </span>
        <span>
          <kbd>F1</kbd> {tr('快捷键', 'Shortcuts')}
        </span>
      </div>

      {!isElectron ? (
        <div className="welcome-demo">
          {tr('当前为浏览器演示模式，终端连接的是模拟 Shell。使用 ', 'Browser demo mode: the terminal is connected to a simulated shell. Use ')}<code>npm run dev</code>{' '}
          {tr('启动 Electron 客户端即可连接真实主机。', 'to launch the Electron client and connect to real hosts.')}
        </div>
      ) : null}
    </div>
  )
}

interface DividerDrag {
  tabId: string
  splitId: string
  direction: SplitDirection
  index: number
  startA: number
  startB: number
  startPos: number
  axisPx: number
  sizes: number[]
}

export function TerminalArea(): ReactElement {
  const tabs = useApp((state) => state.tabs)
  const sessions = useApp((state) => state.sessions)
  const activeTabId = useApp((state) => state.activeTabId)
  const activeRuntimeId = useApp((state) => state.activeRuntimeId)
  const searchVisible = useApp((state) => state.searchVisible)
  const setSearchVisible = useApp((state) => state.setSearchVisible)
  const setTabSizes = useApp((state) => state.setTabSizes)
  const closePane = useApp((state) => state.closePane)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DividerDrag | null>(null)
  const [query, setQuery] = useState('')

  const geometryByTab = useMemo(
    () => new Map(tabs.map((tab) => [tab.id, computeGeometry(tab.layout)])),
    [tabs]
  )

  const startDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    tabId: string,
    geometry: SplitGeometry,
    index: number
  ): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const bounds = canvas.getBoundingClientRect()
    const axisPx =
      geometry.direction === 'horizontal'
        ? bounds.width * geometry.rect.width
        : bounds.height * geometry.rect.height
    if (axisPx <= 0) return
    dragRef.current = {
      tabId,
      splitId: geometry.id,
      direction: geometry.direction,
      index,
      startA: geometry.sizes[index],
      startB: geometry.sizes[index + 1],
      startPos: geometry.direction === 'horizontal' ? event.clientX : event.clientY,
      axisPx,
      sizes: [...geometry.sizes]
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const pos = drag.direction === 'horizontal' ? event.clientX : event.clientY
    const total = drag.startA + drag.startB
    const min = Math.min(10, total / 2)
    const nextA = Math.min(
      Math.max(drag.startA + ((pos - drag.startPos) / drag.axisPx) * 100, min),
      total - min
    )
    const sizes = [...drag.sizes]
    sizes[drag.index] = nextA
    sizes[drag.index + 1] = total - nextA
    setTabSizes(drag.tabId, drag.splitId, sizes)
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  useEffect(() => {
    if (!searchVisible) return
    const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [searchVisible])

  const runSearch = (backwards: boolean): void => {
    if (!query) return
    const handle = getTerminal(activeRuntimeId)
    if (!handle) return
    if (backwards) handle.search.findPrevious(query, { incremental: true })
    else handle.search.findNext(query, { incremental: true })
  }

  return (
    <div className="terminal-area">
      <TabBar />

      {tabs.length === 0 ? (
        <Welcome />
      ) : (
        <div className="tab-views">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab-view ${tab.id === activeTabId ? 'active' : ''}`}
            >
              {/*
                Panes are absolutely positioned siblings keyed by pane id. The
                tree only decides their rectangles, so splitting or closing a
                pane never moves (and therefore never remounts) another
                terminal. Nesting also allows mixed directions.
              */}
              <div className="pane-canvas" ref={tab.id === activeTabId ? canvasRef : undefined}>
                {tab.panes.map((pane) => {
                  const rect = geometryByTab.get(tab.id)?.panes.get(pane.id)
                  if (!rect) return null
                  return (
                    <div
                      key={pane.id}
                      className="pane-cell"
                      style={{
                        left: `${rect.left * 100}%`,
                        top: `${rect.top * 100}%`,
                        width: `${rect.width * 100}%`,
                        height: `${rect.height * 100}%`
                      }}
                    >
                      <TerminalPane
                        runtimeId={pane.runtimeId}
                        session={
                          sessions.find((item) => item.id === pane.sessionId) ?? tab.session
                        }
                        visible={tab.id === activeTabId}
                        showClose={tab.panes.length > 1}
                        autoConnect={pane.autoConnect}
                        onClose={() => closePane(tab.id, pane.id)}
                      />
                    </div>
                  )
                })}
                {(geometryByTab.get(tab.id)?.splits ?? []).flatMap((geometry) =>
                  geometry.offsets.map((offset, index) => (
                    <div
                      key={`${geometry.id}:${index}`}
                      role="separator"
                      aria-orientation={geometry.direction === 'horizontal' ? 'vertical' : 'horizontal'}
                      className={`pane-handle ${geometry.direction}`}
                      style={
                        geometry.direction === 'horizontal'
                          ? {
                              left: `${(geometry.rect.left + geometry.rect.width * offset) * 100}%`,
                              top: `${geometry.rect.top * 100}%`,
                              height: `${geometry.rect.height * 100}%`
                            }
                          : {
                              top: `${(geometry.rect.top + geometry.rect.height * offset) * 100}%`,
                              left: `${geometry.rect.left * 100}%`,
                              width: `${geometry.rect.width * 100}%`
                            }
                      }
                      onPointerDown={(event) => startDrag(event, tab.id, geometry, index)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    />
                  ))
                )}
              </div>
              <SessionDock
                tab={tab}
                activeRuntimeId={activeRuntimeId}
                visible={tab.id === activeTabId}
              />
            </div>
          ))}
        </div>
      )}

      {searchVisible && tabs.length > 0 ? (
        <div className="terminal-search">
          <Icon name="search" size={14} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              const handle = getTerminal(activeRuntimeId)
              if (event.target.value) {
                handle?.search.findNext(event.target.value, { incremental: true })
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runSearch(event.shiftKey)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setSearchVisible(false)
              }
            }}
            placeholder={tr('在终端中查找…', 'Find in terminal…')}
            spellCheck={false}
          />
          <button className="icon-btn mini" title={tr('上一个 (Shift+Enter)', 'Previous (Shift+Enter)')} onClick={() => runSearch(true)}>
            <Icon name="chevron-down" size={13} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button className="icon-btn mini" title={tr('下一个 (Enter)', 'Next (Enter)')} onClick={() => runSearch(false)}>
            <Icon name="chevron-down" size={13} />
          </button>
          <button className="icon-btn mini" title={tr('关闭 (Esc)', 'Close (Esc)')} onClick={() => setSearchVisible(false)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
