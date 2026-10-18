import type {
  LayoutTab,
  LegacyLayoutTab,
  Session,
  StoredLayoutNode,
  WindowLayout
} from '@shared/types'
import {
  collectPanes,
  effectiveSizes,
  paneNode,
  splitNode,
  type LayoutNode,
  type PaneState
} from './pane-layout'

export interface LayoutTabLike {
  id?: string
  layout: LayoutNode
}

export interface RestoredTab {
  session: Session
  layout: LayoutNode
}

export interface RestoreResult {
  tabs: RestoredTab[]
  activeIndex: number
}

function serializeNode(node: LayoutNode): StoredLayoutNode {
  if (node.type === 'pane') return { type: 'pane', sessionId: node.pane.sessionId }
  const sizes =
    node.sizes && node.sizes.length === node.children.length ? effectiveSizes(node) : undefined
  return {
    type: 'split',
    direction: node.direction,
    ...(sizes ? { sizes } : {}),
    children: node.children.map(serializeNode)
  }
}

/** Serialize the live tab state into the shape stored in layouts.json. */
export function buildLayout(tabs: LayoutTabLike[], activeTabId: string | null): WindowLayout {
  const active = tabs.findIndex((tab) => tab.id === activeTabId)
  return {
    tabs: tabs.map((tab) => ({ layout: serializeNode(tab.layout) })),
    activeIndex: active >= 0 ? active : 0
  }
}

function isLegacyTab(tab: LayoutTab | LegacyLayoutTab): tab is LegacyLayoutTab {
  return 'panes' in tab && !('layout' in tab)
}

function isValidSizes(sizes: number[] | undefined, count: number): sizes is number[] {
  return (
    Array.isArray(sizes) &&
    sizes.length === count &&
    sizes.every((size) => Number.isFinite(size) && size >= 0 && size <= 100)
  )
}

function legacyToStored(tab: LegacyLayoutTab): StoredLayoutNode {
  if (tab.panes.length === 1) return { type: 'pane', sessionId: tab.panes[0].sessionId }
  return {
    type: 'split',
    direction: tab.direction,
    ...(isValidSizes(tab.sizes, tab.panes.length) ? { sizes: [...tab.sizes] } : {}),
    children: tab.panes.map((pane) => ({ type: 'pane' as const, sessionId: pane.sessionId }))
  }
}

/**
 * Drop panes whose session no longer exists, collapse single-child splits and
 * keep the sizes that still line up with the surviving children.
 */
function pruneStoredNode(
  node: StoredLayoutNode,
  hasSession: (sessionId: string) => boolean
): StoredLayoutNode | null {
  if (node.type === 'pane') return hasSession(node.sessionId) ? node : null

  const sized = isValidSizes(node.sizes, node.children.length) ? node.sizes : undefined
  const children: StoredLayoutNode[] = []
  const keptSizes: number[] = []

  node.children.forEach((child, index) => {
    const kept = pruneStoredNode(child, hasSession)
    if (!kept) return
    children.push(kept)
    if (sized) keptSizes.push(sized[index])
  })

  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return {
    type: 'split',
    direction: node.direction,
    ...(sized ? { sizes: keptSizes } : {}),
    children
  }
}

function toRuntimeNode(
  node: StoredLayoutNode,
  makePane: (sessionId: string) => PaneState
): LayoutNode {
  if (node.type === 'pane') return paneNode(makePane(node.sessionId))
  return splitNode(
    node.direction,
    node.children.map((child) => toRuntimeNode(child, makePane)),
    node.sizes
  )
}

/**
 * Rebuild tabs from a persisted layout. Both the nested format and the legacy
 * flat row are accepted. Tabs and panes whose session was deleted are dropped.
 */
export function restoreLayout(
  layout: WindowLayout,
  sessions: Session[],
  makePane: (sessionId: string) => PaneState
): RestoreResult {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const hasSession = (sessionId: string): boolean => byId.has(sessionId)
  const tabs: RestoredTab[] = []
  let activeIndex = 0
  const target = Math.min(Math.max(layout.activeIndex, 0), Math.max(0, layout.tabs.length - 1))

  layout.tabs.forEach((tab, index) => {
    const stored = pruneStoredNode(
      isLegacyTab(tab) ? legacyToStored(tab) : tab.layout,
      hasSession
    )
    if (!stored) return
    const runtime = toRuntimeNode(stored, makePane)
    const firstPane = collectPanes(runtime)[0]
    const session = firstPane ? byId.get(firstPane.sessionId) : undefined
    if (!session) return
    if (index === target) activeIndex = tabs.length
    tabs.push({ session, layout: runtime })
  })

  return { tabs, activeIndex: Math.min(activeIndex, Math.max(0, tabs.length - 1)) }
}
