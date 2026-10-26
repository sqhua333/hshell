import { describe, expect, it } from 'vitest'
import type { FileEntry } from '@shared/types'
import { updateFileSelection } from '../../src/renderer/src/lib/file-selection'

function entry(name: string): FileEntry {
  return {
    name,
    path: `/dir/${name}`,
    type: 'file',
    size: 1,
    mtime: 0,
    mode: 0o644
  }
}

const entries = ['a', 'b', 'c', 'd'].map(entry)
const names = (selection: ReturnType<typeof updateFileSelection>): string[] =>
  selection.selected.map((item) => item.name)

describe('updateFileSelection', () => {
  it('replaces the selection on a plain click', () => {
    const result = updateFileSelection(entries, [entries[0]], entries[0].path, entries[2], {
      toggle: false,
      range: false
    })
    expect(names(result)).toEqual(['c'])
    expect(result.anchor).toBe('/dir/c')
  })

  it('toggles rows with Ctrl/Cmd and keeps the clicked row as anchor', () => {
    const first = updateFileSelection(entries, [], null, entries[0], { toggle: true, range: false })
    expect(names(first)).toEqual(['a'])
    const second = updateFileSelection(entries, first.selected, first.anchor, entries[2], {
      toggle: true,
      range: false
    })
    expect(names(second)).toEqual(['a', 'c'])
    expect(second.anchor).toBe('/dir/c')
    const removed = updateFileSelection(entries, second.selected, second.anchor, entries[0], {
      toggle: true,
      range: false
    })
    expect(names(removed)).toEqual(['c'])
  })

  it('extends the selection from the anchor on Shift+click', () => {
    const clicked = updateFileSelection(entries, [entries[0]], entries[0].path, entries[2], {
      toggle: false,
      range: true
    })
    expect(names(clicked)).toEqual(['a', 'b', 'c'])
    expect(clicked.anchor).toBe('/dir/a')
  })

  it('supports a range that grows upwards', () => {
    const clicked = updateFileSelection(entries, [entries[3]], entries[3].path, entries[1], {
      toggle: false,
      range: true
    })
    expect(names(clicked)).toEqual(['b', 'c', 'd'])
    expect(clicked.anchor).toBe('/dir/d')
  })

  it('falls back to a single selection when the anchor is gone', () => {
    const result = updateFileSelection(entries, [], 'missing', entries[1], {
      toggle: false,
      range: true
    })
    expect(names(result)).toEqual(['b'])
    expect(result.anchor).toBe('/dir/b')
  })

  it('replaces the range when Shift+clicking with an anchor', () => {
    const first = updateFileSelection(entries, [entries[0]], entries[0].path, entries[1], {
      toggle: false,
      range: true
    })
    expect(names(first)).toEqual(['a', 'b'])
    const second = updateFileSelection(entries, first.selected, first.anchor, entries[3], {
      toggle: false,
      range: true
    })
    expect(names(second)).toEqual(['a', 'b', 'c', 'd'])
  })
})
