import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import { isFtpSession, sessionTarget } from '@shared/session'
import type { SplitDirection } from '@shared/types'
import { isElectron } from '../api'
import { tr } from '../lib/i18n'
import {
  computeGeometry,
  type LayoutGeometry,
  type PaneRect,
  type SplitGeometry,
  type SplitSide
} from '../lib/pane-layout'
import {
  isSessionDrag,
  isTabDrag,
  readSessionDragId,
  readTabDragId
} from '../lib/session-drag'
import { getTerminal } from '../lib/terminal-registry'
import { useApp } from '../store'
import { FtpPane } from './FtpPane'
import { Icon } from './Icon'
import { SessionDock } from './SessionDock'
import { TabBar } from './TabBar'
import { ZmodemProgress } from './ZmodemProgress'

// xterm and its addons are by far the largest renderer dependency. Loading
// them lazily keeps the initial bundle small so the window becomes usable
// sooner; the chunk is prefetched right after the first paint.
const TerminalPane = lazy(() =>
  import('./TerminalPane').then((module) => ({ default: module.TerminalPane }))
)

function Welcome(): ReactElement {
  const sessions = useApp((state) => state.sessions)
  const openSession = useApp((state) => state.openSession)
  const openSessionDialog = useApp((state) => state.openSessionDialog)
  const openLocalShell = useApp((state) => state.openLocalShell)

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
        <button className="btn" onClick={() => openLocalShell()}>
          <Icon name="terminal" size={15} />
          {tr('本地终端', 'Local terminal')}
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
          <kbd>Ctrl+F</kbd> {tr('查找', 'Find')}
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

interface DropTarget {
  tabId: string
  paneId: string
  direction: SplitDirection
  side: SplitSide
  rect: PaneRect
}

/**
 * Pick the pane under the pointer and the edge closest to it. That edge
 * becomes the side of the new pane, so dropping on a pane's left half opens
 * the dragged session on the left, top half on top, and so on.
 */
function resolveDropTarget(
  event: ReactDragEvent<HTMLDivElement>,
  geometry: LayoutGeometry
): Omit<DropTarget, 'tabId'> | null {
  const bounds = event.currentTarget.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return null
  const x = event.clientX - bounds.left
  const y = event.clientY - bounds.top
  for (const [paneId, rect] of geometry.panes) {
    const left = rect.left * bounds.width
    const top = rect.top * bounds.height
    const width = rect.width * bounds.width
    const height = rect.height * bounds.height
    if (x < left || x > left + width || y < top || y > top + height) continue
    const edge = [
      { name: 'left' as const, distance: x - left },
      { name: 'right' as const, distance: left + width - x },
      { name: 'top' as const, distance: y - top },
      { name: 'bottom' as const, distance: top + height - y }
    ].sort((a, b) => a.distance - b.distance)[0].name
    return {
      paneId,
      direction: edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical',
      side: edge === 'left' || edge === 'top' ? 'before' : 'after',
      rect
    }
  }
  return null
}

/** Rectangle of the half-pane preview shown while dragging a session over it. */
function dropZoneRect(rect: PaneRect, direction: SplitDirection, side: SplitSide): PaneRect {
  if (direction === 'horizontal') {
    return {
      left: rect.left + (side === 'before' ? 0 : rect.width / 2),
      top: rect.top,
      width: rect.width / 2,
      height: rect.height
    }
  }
  return {
    left: rect.left,
    top: rect.top + (side === 'before' ? 0 : rect.height / 2),
    width: rect.width,
    height: rect.height / 2
  }
}

function DropPreview({ target }: { target: DropTarget }): ReactElement {
  const zone = dropZoneRect(target.rect, target.direction, target.side)
  return (
    <>
      <div
        className="pane-drop-target"
        style={{
          left: `${target.rect.left * 100}%`,
          top: `${target.rect.top * 100}%`,
          width: `${target.rect.width * 100}%`,
          height: `${target.rect.height * 100}%`
        }}
      />
      <div
        className={`pane-drop-zone ${target.direction}`}
        style={{
          left: `${zone.left * 100}%`,
          top: `${zone.top * 100}%`,
          width: `${zone.width * 100}%`,
          height: `${zone.height * 100}%`
        }}
      />
    </>
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
  const splitPaneWithSession = useApp((state) => state.splitPaneWithSession)
  const splitPaneWithTab = useApp((state) => state.splitPaneWithTab)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DividerDrag | null>(null)
  const [query, setQuery] = useState('')
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  useEffect(() => {
    // Give the first frame time to settle, then load terminal code so opening
    // a session later does not show the placeholder.
    const timer = window.setTimeout(
      () => void import('./TerminalPane').catch(() => undefined),
      1200
    )
    return () => window.clearTimeout(timer)
  }, [])

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

  const handleDragOver = (
    event: ReactDragEvent<HTMLDivElement>,
    tabId: string
  ): void => {
    if (!isSessionDrag(event.dataTransfer) && !isTabDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = isTabDrag(event.dataTransfer) ? 'move' : 'copy'
    const geometry = geometryByTab.get(tabId)
    if (!geometry) return
    const target = resolveDropTarget(event, geometry)
    setDropTarget((previous) => {
      if (!target) return null
      if (
        previous &&
        previous.tabId === tabId &&
        previous.paneId === target.paneId &&
        previous.direction === target.direction &&
        previous.side === target.side
      ) {
        return previous
      }
      return { ...target, tabId }
    })
  }

  const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!isSessionDrag(event.dataTransfer) && !isTabDrag(event.dataTransfer)) return
    const related = event.relatedTarget as Node | null
    if (related && event.currentTarget.contains(related)) return
    setDropTarget(null)
  }

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>, tabId: string): void => {
    if (!isSessionDrag(event.dataTransfer) && !isTabDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    const geometry = geometryByTab.get(tabId)
    const target = geometry ? resolveDropTarget(event, geometry) : null
    const draggedTabId = readTabDragId(event.dataTransfer)
    const sessionId = readSessionDragId(event.dataTransfer)
    setDropTarget(null)
    if (!target) return
    if (draggedTabId) {
      splitPaneWithTab(tabId, target.paneId, draggedTabId, target.direction, target.side)
    } else if (sessionId) {
      splitPaneWithSession(tabId, target.paneId, sessionId, target.direction, target.side)
    }
  }

  // A drag cancelled outside the canvas (Esc, dropped elsewhere) never fires
  // dragleave here, so clear the preview on the window-level end event.
  useEffect(() => {
    const clear = (): void => setDropTarget(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

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
              <div
                className="pane-canvas"
                ref={tab.id === activeTabId ? canvasRef : undefined}
                onDragOver={(event) => handleDragOver(event, tab.id)}
                onDragLeave={handleDragLeave}
                onDrop={(event) => handleDrop(event, tab.id)}
              >
                {tab.panes.map((pane) => {
                  const rect = geometryByTab.get(tab.id)?.panes.get(pane.id)
                  if (!rect) return null
                  const paneSession =
                    sessions.find((item) => item.id === pane.sessionId) ??
                    tab.paneSessions?.[pane.sessionId] ??
                    tab.session
                  return (
                    <div
                      key={pane.id}
                      className="pane-cell"
                      data-pane-id={pane.id}
                      data-session-id={pane.sessionId}
                      style={{
                        left: `${rect.left * 100}%`,
                        top: `${rect.top * 100}%`,
                        width: `${rect.width * 100}%`,
                        height: `${rect.height * 100}%`
                      }}
                    >
                      {isFtpSession(paneSession) ? (
                        <FtpPane
                          runtimeId={pane.runtimeId}
                          session={paneSession}
                          visible={tab.id === activeTabId}
                          showClose={tab.panes.length > 1}
                          autoConnect={pane.autoConnect}
                          onClose={() => closePane(tab.id, pane.id)}
                        />
                      ) : (
                        <Suspense
                          fallback={
                            <div className="terminal-loading">
                              {tr('正在加载终端…', 'Loading terminal…')}
                            </div>
                          }
                        >
                          <TerminalPane
                            runtimeId={pane.runtimeId}
                            session={paneSession}
                            visible={tab.id === activeTabId}
                            showClose={tab.panes.length > 1}
                            autoConnect={pane.autoConnect}
                            onClose={() => closePane(tab.id, pane.id)}
                          />
                        </Suspense>
                      )}
                    </div>
                  )
                })}
                {dropTarget && dropTarget.tabId === tab.id ? (
                  <DropPreview target={dropTarget} />
                ) : null}
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

      <ZmodemProgress />

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
