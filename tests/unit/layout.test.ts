import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Session, StoredLayoutNode, WindowLayout } from '@shared/types'
import { LayoutStore } from '../../src/main/storage/layout-store'
import { buildLayout, restoreLayout } from '../../src/renderer/src/lib/layout'
import { collectPanes, type LayoutNode, type PaneState } from '../../src/renderer/src/lib/pane-layout'

function session(id: string): Session {
  return {
    id,
    name: id,
    folderId: null,
    host: '127.0.0.1',
    port: 22,
    username: 'tester',
    auth: { method: 'password' },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    createdAt: 0,
    updatedAt: 0
  }
}

let paneSeq = 0
function makePane(sessionId: string): PaneState {
  paneSeq += 1
  return {
    id: `pane-${paneSeq}`,
    runtimeId: `rt-${paneSeq}`,
    sessionId,
    autoConnect: false
  }
}

function paneNode(sessionId: string) {
  return { type: 'pane' as const, pane: makePane(sessionId) }
}

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hshell-layout-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('layout serialization', () => {
  it('keeps the nested tree, direction and sizes', () => {
    const layout = buildLayout(
      [
        {
          id: 'tab-1',
          layout: {
            type: 'split',
            id: 'split-1',
            direction: 'vertical',
            sizes: [30, 70],
            children: [
              paneNode('a'),
              {
                type: 'split',
                id: 'split-2',
                direction: 'horizontal',
                sizes: [50, 50],
                children: [paneNode('b'), paneNode('c')]
              }
            ]
          }
        }
      ],
      'tab-1'
    )
    expect(layout).toEqual({
      tabs: [
        {
          layout: {
            type: 'split',
            direction: 'vertical',
            sizes: [30, 70],
            children: [
              { type: 'pane', sessionId: 'a' },
              {
                type: 'split',
                direction: 'horizontal',
                sizes: [50, 50],
                children: [
                  { type: 'pane', sessionId: 'b' },
                  { type: 'pane', sessionId: 'c' }
                ]
              }
            ]
          }
        }
      ],
      activeIndex: 0
    })
  })

  it('drops stale size arrays and clamps a missing active tab', () => {
    const layout = buildLayout(
      [
        {
          id: 'tab-1',
          layout: {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [100],
            children: [paneNode('a'), paneNode('b')]
          }
        }
      ],
      'missing'
    )
    const tab = layout.tabs[0] as { layout: StoredLayoutNode }
    expect(tab.layout).toMatchObject({ type: 'split', direction: 'horizontal' })
    expect('sizes' in tab.layout ? tab.layout.sizes : undefined).toBeUndefined()
    expect(layout.activeIndex).toBe(0)
  })

  it('omits sizes for equal splits that were never resized', () => {
    const layout = buildLayout(
      [
        {
          id: 'tab-1',
          layout: {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            children: [paneNode('a'), paneNode('b')]
          }
        }
      ],
      'tab-1'
    )
    const tab = layout.tabs[0] as { layout: StoredLayoutNode }
    expect('sizes' in tab.layout ? tab.layout.sizes : undefined).toBeUndefined()
  })
})

describe('layout restore', () => {
  const sessions = [session('a'), session('b'), session('c')]

  it('rebuilds tabs and preserves the active tab index', () => {
    const layout: WindowLayout = {
      tabs: [
        { layout: { type: 'pane', sessionId: 'a' } },
        {
          layout: {
            type: 'split',
            direction: 'vertical',
            sizes: [40, 60],
            children: [
              { type: 'pane', sessionId: 'b' },
              { type: 'pane', sessionId: 'c' }
            ]
          }
        }
      ],
      activeIndex: 1
    }
    const restored = restoreLayout(layout, sessions, makePane)
    expect(restored.tabs.map((tab) => tab.session.id)).toEqual(['a', 'b'])
    expect(collectPanes(restored.tabs[0].layout).map((pane) => pane.sessionId)).toEqual(['a'])
    expect(collectPanes(restored.tabs[1].layout).map((pane) => pane.sessionId)).toEqual(['b', 'c'])
    expect(restored.tabs[1].layout).toMatchObject({ direction: 'vertical', sizes: [40, 60] })
    expect(restored.activeIndex).toBe(1)
  })

  it('restores legacy flat rows and their sizes', () => {
    const layout: WindowLayout = {
      tabs: [
        { panes: [{ sessionId: 'a' }], direction: 'horizontal' },
        {
          panes: [{ sessionId: 'b' }, { sessionId: 'c' }],
          direction: 'vertical',
          sizes: [40, 60]
        }
      ],
      activeIndex: 1
    }
    const restored = restoreLayout(layout, sessions, makePane)
    expect(restored.tabs.map((tab) => tab.session.id)).toEqual(['a', 'b'])
    expect(restored.tabs[0].layout.type).toBe('pane')
    expect(restored.tabs[1].layout).toMatchObject({
      type: 'split',
      direction: 'vertical',
      sizes: [40, 60]
    })
  })

  it('skips tabs whose sessions were deleted and collapses empty splits', () => {
    const layout: WindowLayout = {
      tabs: [
        { panes: [{ sessionId: 'gone' }], direction: 'horizontal' },
        { panes: [{ sessionId: 'a' }, { sessionId: 'gone' }], direction: 'horizontal', sizes: [50, 50] },
        { panes: [{ sessionId: 'b' }], direction: 'horizontal' }
      ],
      activeIndex: 2
    }
    const restored = restoreLayout(layout, sessions, makePane)
    expect(restored.tabs.map((tab) => tab.session.id)).toEqual(['a', 'b'])
    expect(restored.tabs[0].layout.type).toBe('pane')
    expect(restored.activeIndex).toBe(1)
  })

  it('keeps only surviving panes of a nested split and their sizes', () => {
    const layout: WindowLayout = {
      tabs: [
        {
          layout: {
            type: 'split',
            direction: 'vertical',
            sizes: [30, 70],
            children: [
              { type: 'pane', sessionId: 'a' },
              {
                type: 'split',
                direction: 'horizontal',
                sizes: [25, 75],
                children: [
                  { type: 'pane', sessionId: 'gone' },
                  { type: 'pane', sessionId: 'b' }
                ]
              }
            ]
          }
        }
      ],
      activeIndex: 0
    }
    const restored = restoreLayout(layout, sessions, makePane)
    const tree = restored.tabs[0].layout as LayoutNode
    // The inner split collapses to a single pane; the outer sizes stay.
    expect(tree).toMatchObject({ type: 'split', direction: 'vertical', sizes: [30, 70] })
    expect(collectPanes(tree).map((pane) => pane.sessionId)).toEqual(['a', 'b'])
    expect((tree as { children: LayoutNode[] }).children[1].type).toBe('pane')
  })

  it('falls back to the first tab when the stored active tab was removed', () => {
    const layout: WindowLayout = {
      tabs: [
        { panes: [{ sessionId: 'gone' }], direction: 'horizontal' },
        { panes: [{ sessionId: 'a' }], direction: 'horizontal' }
      ],
      activeIndex: 0
    }
    const restored = restoreLayout(layout, sessions, makePane)
    expect(restored.tabs).toHaveLength(1)
    expect(restored.activeIndex).toBe(0)
  })

  it('restores a four-pane legacy split with its sizes', () => {
    const layout: WindowLayout = {
      tabs: [
        {
          panes: [
            { sessionId: 'a' },
            { sessionId: 'b' },
            { sessionId: 'c' },
            { sessionId: 'a' }
          ],
          direction: 'vertical',
          sizes: [20, 30, 25, 25]
        }
      ],
      activeIndex: 0
    }
    const restored = restoreLayout(layout, sessions, makePane)
    expect(collectPanes(restored.tabs[0].layout).map((pane) => pane.sessionId)).toEqual([
      'a',
      'b',
      'c',
      'a'
    ])
    expect(restored.tabs[0].layout).toMatchObject({ sizes: [20, 30, 25, 25] })
  })

  it('returns an empty result for an empty layout', () => {
    expect(restoreLayout({ tabs: [], activeIndex: 0 }, sessions, makePane)).toEqual({
      tabs: [],
      activeIndex: 0
    })
  })
})

describe('LayoutStore', () => {
  it('round-trips the nested layout format', () => {
    const dir = tempDir()
    const store = new LayoutStore(dir)
    const layout: WindowLayout = {
      tabs: [
        {
          layout: {
            type: 'split',
            direction: 'vertical',
            sizes: [40, 60],
            children: [
              { type: 'pane', sessionId: 'a' },
              {
                type: 'split',
                direction: 'horizontal',
                children: [
                  { type: 'pane', sessionId: 'b' },
                  { type: 'pane', sessionId: 'c' }
                ]
              }
            ]
          }
        }
      ],
      activeIndex: 0
    }
    store.save(layout)
    expect(store.get()).toEqual(layout)
    const raw = JSON.parse(readFileSync(join(dir, 'layouts.json'), 'utf8')) as {
      schemaVersion: number
    }
    expect(raw.schemaVersion).toBe(1)
  })

  it('still accepts and preserves legacy flat layouts', () => {
    const dir = tempDir()
    const store = new LayoutStore(dir)
    const layout: WindowLayout = {
      tabs: [{ panes: [{ sessionId: 'a' }], direction: 'horizontal' }],
      activeIndex: 0
    }
    store.save(layout)
    expect(store.get()).toEqual(layout)
  })

  it('returns an empty layout for a corrupt file without throwing', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'layouts.json'), 'not json')
    expect(new LayoutStore(dir).get()).toEqual({ tabs: [], activeIndex: 0 })
  })

  it('rejects invalid layouts before writing', () => {
    const dir = tempDir()
    const store = new LayoutStore(dir)
    expect(() =>
      store.save({ tabs: [{ panes: [], direction: 'horizontal' }], activeIndex: 0 } as WindowLayout)
    ).toThrow()
  })

  it('rejects a split whose sizes do not match its children', () => {
    const dir = tempDir()
    const store = new LayoutStore(dir)
    expect(() =>
      store.save({
        tabs: [
          {
            layout: {
              type: 'split',
              direction: 'horizontal',
              sizes: [100],
              children: [
                { type: 'pane', sessionId: 'a' },
                { type: 'pane', sessionId: 'b' }
              ]
            }
          }
        ],
        activeIndex: 0
      } as WindowLayout)
    ).toThrow()
  })
})
