import type { SplitDirection } from '@shared/types'

export interface PaneState {
  id: string
  runtimeId: string
  sessionId: string
  /** Restored panes wait for the user instead of reconnecting on startup. */
  autoConnect: boolean
}

export interface PaneNode {
  type: 'pane'
  pane: PaneState
}

export interface SplitNode {
  type: 'split'
  id: string
  direction: SplitDirection
  /** Percentages aligned with `children`; omitted means equal shares. */
  sizes?: number[]
  children: LayoutNode[]
}

export type LayoutNode = PaneNode | SplitNode

/** Where the new pane goes relative to the pane it splits. */
export type SplitSide = 'before' | 'after'

export interface PaneRect {
  left: number
  top: number
  width: number
  height: number
}

export interface SplitGeometry {
  id: string
  direction: SplitDirection
  rect: PaneRect
  /** Effective (normalized) sizes, useful while dragging. */
  sizes: number[]
  /** Cumulative positions of the dividers, as fractions of the split's axis. */
  offsets: number[]
}

export interface LayoutGeometry {
  panes: Map<string, PaneRect>
  splits: SplitGeometry[]
}

export function paneNode(pane: PaneState): PaneNode {
  return { type: 'pane', pane }
}

export function splitNode(
  direction: SplitDirection,
  children: LayoutNode[],
  sizes?: number[]
): SplitNode {
  return {
    type: 'split',
    id: `split-${nextSplitId++}`,
    direction,
    children,
    ...(sizes ? { sizes } : {})
  }
}

let nextSplitId = 1

/** Effective percentages for a split: explicit sizes when valid, equal shares otherwise. */
export function effectiveSizes(node: SplitNode): number[] {
  const count = node.children.length
  if (count === 0) return []
  const raw = node.sizes
  if (!raw || raw.length !== count || raw.some((size) => !Number.isFinite(size) || size <= 0)) {
    return Array.from({ length: count }, () => 100 / count)
  }
  const total = raw.reduce((sum, size) => sum + size, 0)
  if (!(total > 0)) return Array.from({ length: count }, () => 100 / count)
  return raw.map((size) => (size / total) * 100)
}

export function collectPanes(node: LayoutNode): PaneState[] {
  if (node.type === 'pane') return [node.pane]
  return node.children.flatMap(collectPanes)
}

export function findPane(node: LayoutNode, paneId: string): PaneState | null {
  if (node.type === 'pane') return node.pane.id === paneId ? node.pane : null
  for (const child of node.children) {
    const found = findPane(child, paneId)
    if (found) return found
  }
  return null
}

function containsPane(node: LayoutNode, paneId: string): boolean {
  return findPane(node, paneId) !== null
}

/**
 * Split the pane `targetPaneId` with `newPane`, keeping every other pane's
 * share intact.
 *
 * - Splitting inside a row that already runs in the same direction inserts a
 *   sibling and gives each half of the target's share.
 * - A different direction turns the target pane into a nested split, so the
 *   surrounding panes keep their exact size.
 */
export function splitAt(
  root: LayoutNode,
  targetPaneId: string,
  newPane: PaneState,
  direction: SplitDirection,
  side: SplitSide = 'after'
): LayoutNode | null {
  if (root.type === 'pane') {
    if (root.pane.id !== targetPaneId) return null
    return splitNode(
      direction,
      side === 'before' ? [paneNode(newPane), root] : [root, paneNode(newPane)],
      [50, 50]
    )
  }

  const index = root.children.findIndex((child) => containsPane(child, targetPaneId))
  if (index < 0) return null
  const child = root.children[index]

  if (child.type === 'pane') {
    if (root.direction === direction) {
      const sizes = effectiveSizes(root)
      const share = sizes[index]
      const nextSizes = [
        ...sizes.slice(0, index),
        share / 2,
        share / 2,
        ...sizes.slice(index + 1)
      ]
      const insertAt = side === 'before' ? index : index + 1
      const children = [
        ...root.children.slice(0, insertAt),
        paneNode(newPane),
        ...root.children.slice(insertAt)
      ]
      return { ...root, sizes: nextSizes, children }
    }
    const nested = splitNode(
      direction,
      side === 'before' ? [paneNode(newPane), child] : [child, paneNode(newPane)],
      [50, 50]
    )
    return {
      ...root,
      children: root.children.map((item, itemIndex) => (itemIndex === index ? nested : item))
    }
  }

  const replaced = splitAt(child, targetPaneId, newPane, direction, side)
  if (!replaced) return null
  return {
    ...root,
    children: root.children.map((item, itemIndex) => (itemIndex === index ? replaced : item))
  }
}

export interface RemoveResult {
  layout: LayoutNode | null
  removed: PaneState | null
}

/** Remove a pane, collapse now-single-child splits and keep the remaining ratios. */
export function removePane(root: LayoutNode, paneId: string): RemoveResult {
  if (root.type === 'pane') {
    return root.pane.id === paneId
      ? { layout: null, removed: root.pane }
      : { layout: root, removed: null }
  }

  const sizes = root.sizes ? effectiveSizes(root) : null
  const keptChildren: LayoutNode[] = []
  const keptSizes: number[] = []
  let removed: PaneState | null = null

  root.children.forEach((child, index) => {
    const result = removePane(child, paneId)
    if (result.removed) removed = result.removed
    if (result.layout) {
      keptChildren.push(result.layout)
      keptSizes.push(sizes ? sizes[index] : 1)
    }
  })

  if (!removed) return { layout: root, removed: null }
  if (keptChildren.length === 0) return { layout: null, removed }
  if (keptChildren.length === 1) return { layout: keptChildren[0], removed }

  let nextSizes: number[] | undefined
  if (sizes) {
    const total = keptSizes.reduce((sum, size) => sum + size, 0)
    nextSizes = keptSizes.map((size) => (size / total) * 100)
  }
  return { layout: { ...root, children: keptChildren, sizes: nextSizes }, removed }
}

export function setSplitSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (root.type === 'pane') return root
  if (root.id === splitId) {
    if (sizes.length !== root.children.length) return root
    if (sizes.some((size) => !Number.isFinite(size) || size < 0)) return root
    return { ...root, sizes: [...sizes] }
  }
  let changed = false
  const children = root.children.map((child) => {
    const next = setSplitSizes(child, splitId, sizes)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...root, children } : root
}

/** Walk the tree and compute pane rectangles plus divider geometry in fractions. */
export function computeGeometry(root: LayoutNode): LayoutGeometry {
  const panes = new Map<string, PaneRect>()
  const splits: SplitGeometry[] = []

  const walk = (node: LayoutNode, rect: PaneRect): void => {
    if (node.type === 'pane') {
      panes.set(node.pane.id, rect)
      return
    }
    const sizes = effectiveSizes(node)
    const offsets: number[] = []
    let offset = 0
    const horizontal = node.direction === 'horizontal'
    for (let index = 0; index < node.children.length; index += 1) {
      if (index > 0) offsets.push(offset)
      const fraction = sizes[index] / 100
      const childRect: PaneRect = horizontal
        ? {
            left: rect.left + offset,
            top: rect.top,
            width: rect.width * fraction,
            height: rect.height
          }
        : {
            left: rect.left,
            top: rect.top + offset,
            width: rect.width,
            height: rect.height * fraction
          }
      walk(node.children[index], childRect)
      offset += fraction
    }
    splits.push({ id: node.id, direction: node.direction, rect, sizes, offsets })
  }

  walk(root, { left: 0, top: 0, width: 1, height: 1 })
  return { panes, splits }
}
