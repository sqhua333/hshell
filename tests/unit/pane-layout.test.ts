import { describe, expect, it } from 'vitest'
import {
  collectPanes,
  computeGeometry,
  effectiveSizes,
  findPane,
  paneNode,
  removePane,
  setSplitSizes,
  splitAt,
  splitAtNode,
  splitNode,
  type LayoutNode,
  type PaneState,
  type SplitNode
} from '../../src/renderer/src/lib/pane-layout'

let seq = 0
function pane(sessionId = 's'): PaneState {
  seq += 1
  return { id: `pane-${seq}`, runtimeId: `rt-${seq}`, sessionId, autoConnect: true }
}

function asSplit(node: LayoutNode): SplitNode {
  if (node.type !== 'split') throw new Error('expected a split node')
  return node
}

function sessionIds(node: LayoutNode): string[] {
  return collectPanes(node).map((item) => item.sessionId)
}

describe('effectiveSizes', () => {
  it('returns equal shares when sizes are missing', () => {
    expect(effectiveSizes(splitNode('horizontal', [paneNode(pane()), paneNode(pane())]))).toEqual([
      50, 50
    ])
  })

  it('normalizes explicit sizes to 100', () => {
    expect(
      effectiveSizes(splitNode('vertical', [paneNode(pane()), paneNode(pane())], [30, 70]))
    ).toEqual([30, 70])
    expect(
      effectiveSizes(splitNode('vertical', [paneNode(pane()), paneNode(pane())], [1, 3]))
    ).toEqual([25, 75])
  })

  it('falls back to equal shares for invalid sizes', () => {
    const children = [paneNode(pane()), paneNode(pane()), paneNode(pane())]
    for (const sizes of [
      [10],
      [10, 10, -1],
      [0, 0, 0],
      [Number.NaN, 50, 50]
    ]) {
      expect(effectiveSizes(splitNode('horizontal', children, sizes))).toEqual([
        100 / 3,
        100 / 3,
        100 / 3
      ])
    }
  })
})

describe('splitAt', () => {
  it('splits a lone pane into two equal halves', () => {
    const a = pane('a')
    const next = pane('b')
    const result = asSplit(splitAt(paneNode(a), a.id, next, 'horizontal'))
    expect(result.direction).toBe('horizontal')
    expect(result.sizes).toEqual([50, 50])
    expect(sessionIds(result)).toEqual(['a', 'b'])
  })

  it('halves only the target pane when splitting in the same direction', () => {
    const a = pane('a')
    const b = pane('b')
    const next = pane('c')
    const root = splitNode('vertical', [paneNode(a), paneNode(b)], [50, 50])
    const result = asSplit(splitAt(root, a.id, next, 'vertical'))
    expect(result.children).toHaveLength(3)
    expect(result.sizes).toEqual([25, 25, 50])
    expect(sessionIds(result)).toEqual(['a', 'c', 'b'])
  })

  it('keeps a 1/4 + 1/4 + 1/2 layout when splitting the same half again', () => {
    const a = pane('a')
    const b = pane('b')
    const root = splitNode('vertical', [paneNode(a), paneNode(b)], [50, 50])
    const second = asSplit(splitAt(root, a.id, pane('c'), 'vertical'))
    const d = pane('d')
    const firstChild = collectPanes(second.children[0])[0]
    const result = asSplit(splitAt(second, firstChild.id, d, 'vertical'))
    expect(result.sizes).toEqual([12.5, 12.5, 25, 50])
    expect(sessionIds(result)).toEqual(['a', 'd', 'c', 'b'])
  })

  it('nests a different direction without resizing the outer split', () => {
    const a = pane('a')
    const b = pane('b')
    const next = pane('c')
    const root = splitNode('vertical', [paneNode(a), paneNode(b)], [40, 60])
    const result = asSplit(splitAt(root, b.id, next, 'horizontal'))

    expect(result.direction).toBe('vertical')
    expect(result.sizes).toEqual([40, 60])
    expect(result.children).toHaveLength(2)
    expect(result.children[0].type).toBe('pane')

    const nested = asSplit(result.children[1])
    expect(nested.direction).toBe('horizontal')
    expect(nested.sizes).toEqual([50, 50])
    expect(sessionIds(nested)).toEqual(['b', 'c'])

    // The untouched pane keeps its exact share.
    expect(computeGeometry(result).panes.get(a.id)).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 0.4
    })
  })

  it('splits a nested pane in its own direction', () => {
    const a = pane('a')
    const b = pane('b')
    const c = pane('c')
    const root = splitNode(
      'vertical',
      [
        paneNode(a),
        splitNode('horizontal', [paneNode(b), paneNode(c)], [50, 50])
      ],
      [40, 60]
    )
    const next = pane('d')
    const result = asSplit(splitAt(root, b.id, next, 'horizontal'))
    expect(result.sizes).toEqual([40, 60])
    const nested = asSplit(result.children[1])
    expect(nested.sizes).toEqual([25, 25, 50])
    expect(sessionIds(result)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('places the new pane before the target when dropping on the left/top edge', () => {
    const a = pane('a')
    const next = pane('b')
    const result = asSplit(splitAt(paneNode(a), a.id, next, 'horizontal', 'before'))
    expect(sessionIds(result)).toEqual(['b', 'a'])
    expect(result.sizes).toEqual([50, 50])
  })

  it('inserts before the target in a same-direction row and halves its share', () => {
    const a = pane('a')
    const b = pane('b')
    const root = splitNode('vertical', [paneNode(a), paneNode(b)], [50, 50])
    const result = asSplit(splitAt(root, b.id, pane('c'), 'vertical', 'before'))
    expect(result.sizes).toEqual([50, 25, 25])
    expect(sessionIds(result)).toEqual(['a', 'c', 'b'])
  })

  it('nests the new pane before a different-direction target', () => {
    const a = pane('a')
    const b = pane('b')
    const root = splitNode('vertical', [paneNode(a), paneNode(b)], [40, 60])
    const result = asSplit(splitAt(root, b.id, pane('c'), 'horizontal', 'before'))
    expect(result.sizes).toEqual([40, 60])
    const nested = asSplit(result.children[1])
    expect(nested.sizes).toEqual([50, 50])
    expect(sessionIds(nested)).toEqual(['c', 'b'])
  })

  it('propagates the side through nested splits', () => {
    const a = pane('a')
    const b = pane('b')
    const c = pane('c')
    const root = splitNode(
      'vertical',
      [paneNode(a), splitNode('horizontal', [paneNode(b), paneNode(c)], [50, 50])],
      [40, 60]
    )
    const result = splitAt(root, c.id, pane('d'), 'horizontal', 'before')
    expect(sessionIds(result as LayoutNode)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('returns null for an unknown pane', () => {
    const root = splitNode('horizontal', [paneNode(pane('a')), paneNode(pane('b'))])
    expect(splitAt(root, 'missing', pane('c'), 'vertical')).toBeNull()
  })

  it('works on the second child of a three-way split', () => {
    const a = pane('a')
    const b = pane('b')
    const c = pane('c')
    const root = splitNode(
      'horizontal',
      [paneNode(a), paneNode(b), paneNode(c)],
      [20, 30, 50]
    )
    const result = asSplit(splitAt(root, b.id, pane('d'), 'horizontal'))
    expect(result.sizes).toEqual([20, 15, 15, 50])
    expect(sessionIds(result)).toEqual(['a', 'b', 'd', 'c'])
  })
})

describe('splitAtNode', () => {
  it('inserts an entire tab layout as a nested split', () => {
    const a = pane('a')
    const b = pane('b')
    const root = splitNode('horizontal', [paneNode(a), paneNode(b)], [50, 50])
    const moved = splitNode('vertical', [paneNode(pane('c')), paneNode(pane('d'))])
    const result = asSplit(splitAtNode(root, a.id, moved, 'horizontal')!)
    expect(result.direction).toBe('horizontal')
    expect(effectiveSizes(result)).toEqual([25, 25, 50])
    expect(sessionIds(result)).toEqual(['a', 'c', 'd', 'b'])
    expect(asSplit(result.children[1]).direction).toBe('vertical')
  })

  it('places the moved layout before the target and keeps the other share', () => {
    const a = pane('a')
    const b = pane('b')
    const root = splitNode('horizontal', [paneNode(a), paneNode(b)], [50, 50])
    const moved = splitNode('vertical', [paneNode(pane('c')), paneNode(pane('d'))])
    const result = asSplit(splitAtNode(root, b.id, moved, 'horizontal', 'before')!)
    expect(effectiveSizes(result)).toEqual([50, 25, 25])
    expect(sessionIds(result)).toEqual(['a', 'c', 'd', 'b'])
  })
})

describe('removePane', () => {
  it('removes a pane and renormalizes the remaining shares', () => {
    const a = pane('a')
    const b = pane('b')
    const c = pane('c')
    const root = splitNode(
      'vertical',
      [paneNode(a), paneNode(b), paneNode(c)],
      [25, 25, 50]
    )
    const result = removePane(root, b.id)
    const layout = result.layout as SplitNode
    expect(result.removed?.id).toBe(b.id)
    expect(sessionIds(layout)).toEqual(['a', 'c'])
    expect(layout.sizes).toBeDefined()
    expect(layout.sizes?.[0]).toBeCloseTo(100 / 3)
    expect(layout.sizes?.[1]).toBeCloseTo(200 / 3)
  })

  it('collapses a split that ends up with a single child', () => {
    const a = pane('a')
    const b = pane('b')
    const root = splitNode('horizontal', [paneNode(a), paneNode(b)], [50, 50])
    const result = removePane(root, b.id)
    expect(result.layout?.type).toBe('pane')
    expect(sessionIds(result.layout as LayoutNode)).toEqual(['a'])
  })

  it('collapses only the nested split and keeps the outer sizes', () => {
    const a = pane('a')
    const b = pane('b')
    const c = pane('c')
    const root = splitNode(
      'vertical',
      [paneNode(a), splitNode('horizontal', [paneNode(b), paneNode(c)], [30, 70])],
      [40, 60]
    )
    const result = removePane(root, c.id)
    const layout = asSplit(result.layout as LayoutNode)
    expect(layout.sizes).toEqual([40, 60])
    expect(layout.children[1].type).toBe('pane')
    expect(sessionIds(layout)).toEqual(['a', 'b'])
  })

  it('returns null when the last pane is removed', () => {
    const a = pane('a')
    expect(removePane(paneNode(a), a.id)).toEqual({ layout: null, removed: a })
  })

  it('is a no-op for an unknown pane', () => {
    const root = splitNode('horizontal', [paneNode(pane()), paneNode(pane())])
    expect(removePane(root, 'missing')).toEqual({ layout: root, removed: null })
  })
})

describe('setSplitSizes', () => {
  it('updates the matching split and leaves others alone', () => {
    const inner = splitNode('horizontal', [paneNode(pane()), paneNode(pane())], [50, 50])
    const root = splitNode('vertical', [paneNode(pane()), inner], [40, 60])
    const next = asSplit(setSplitSizes(root, inner.id, [30, 70]))
    expect(next.sizes).toEqual([40, 60])
    expect(asSplit(next.children[1]).sizes).toEqual([30, 70])
  })

  it('ignores sizes with the wrong length or invalid numbers', () => {
    const root = splitNode('horizontal', [paneNode(pane()), paneNode(pane())], [50, 50])
    expect(setSplitSizes(root, root.id, [100])).toBe(root)
    expect(setSplitSizes(root, root.id, [Number.NaN, 50])).toBe(root)
    expect(setSplitSizes(root, root.id, [-10, 110])).toBe(root)
    expect(setSplitSizes(root, 'unknown', [30, 70])).toBe(root)
  })
})

describe('computeGeometry', () => {
  it('maps a single pane to the whole canvas', () => {
    const a = pane('a')
    const geometry = computeGeometry(paneNode(a))
    expect(geometry.panes.get(a.id)).toEqual({ left: 0, top: 0, width: 1, height: 1 })
    expect(geometry.splits).toEqual([])
  })

  it('computes mixed-direction rects and divider offsets', () => {
    const a = pane('a')
    const b = pane('b')
    const c = pane('c')
    const inner = splitNode('horizontal', [paneNode(b), paneNode(c)], [50, 50])
    const root = splitNode('vertical', [paneNode(a), inner], [40, 60])
    const geometry = computeGeometry(root)

    expect(geometry.panes.get(a.id)).toEqual({ left: 0, top: 0, width: 1, height: 0.4 })
    expect(geometry.panes.get(b.id)).toEqual({ left: 0, top: 0.4, width: 0.5, height: 0.6 })
    expect(geometry.panes.get(c.id)).toEqual({ left: 0.5, top: 0.4, width: 0.5, height: 0.6 })

    const innerGeometry = geometry.splits.find((item) => item.id === inner.id)
    const rootGeometry = geometry.splits.find((item) => item.id === root.id)
    expect(rootGeometry).toMatchObject({ direction: 'vertical', sizes: [40, 60], offsets: [0.4] })
    expect(innerGeometry).toMatchObject({
      direction: 'horizontal',
      sizes: [50, 50],
      offsets: [0.5]
    })
    expect(innerGeometry?.rect).toEqual({ left: 0, top: 0.4, width: 1, height: 0.6 })
  })

  it('keeps a nested split inside its parent rectangle', () => {
    // Split the right half horizontally, then split its bottom half again in
    // the same direction: the third pane belongs in the bottom-right quarter,
    // and the fourth must stay inside the right edge of the canvas.
    const panes = ['a', 'b', 'c', 'd'].map((id) => pane(id))
    const bottom = splitNode('horizontal', [paneNode(panes[2]), paneNode(panes[3])], [50, 50])
    const right = splitNode('vertical', [paneNode(panes[1]), bottom], [50, 50])
    const root = splitNode('horizontal', [paneNode(panes[0]), right], [50, 50])
    const geometry = computeGeometry(root)

    expect(geometry.panes.get(panes[2].id)).toEqual({
      left: 0.5,
      top: 0.5,
      width: 0.25,
      height: 0.5
    })
    expect(geometry.panes.get(panes[3].id)).toEqual({
      left: 0.75,
      top: 0.5,
      width: 0.25,
      height: 0.5
    })
    const nested = geometry.splits.find((item) => item.id === bottom.id)
    expect(nested?.rect).toEqual({ left: 0.5, top: 0.5, width: 0.5, height: 0.5 })
  })

  it('positions several dividers in a four-way split', () => {
    const panes = ['a', 'b', 'c', 'd'].map((id) => pane(id))
    const root = splitNode(
      'vertical',
      panes.map(paneNode),
      [25, 25, 25, 25]
    )
    const geometry = computeGeometry(root)
    const split = geometry.splits[0]
    expect(split.offsets).toEqual([0.25, 0.5, 0.75])
    expect(geometry.panes.get(panes[3].id)).toEqual({
      left: 0,
      top: 0.75,
      width: 1,
      height: 0.25
    })
  })
})

describe('findPane', () => {
  it('finds panes at any depth', () => {
    const a = pane('a')
    const b = pane('b')
    const root = splitNode('vertical', [
      paneNode(a),
      splitNode('horizontal', [paneNode(b)])
    ])
    expect(findPane(root, b.id)?.sessionId).toBe('b')
    expect(findPane(root, 'missing')).toBeNull()
  })
})
