import type { FileEntry } from '@shared/types'

export interface FileSelection {
  selected: FileEntry[]
  /** Item a following Shift+click ranges from; usually the last clicked row. */
  anchor: string | null
}

/**
 * Click behaviour copied from desktop file managers: plain click selects one
 * row, Ctrl/Cmd toggles a row, Shift extends from the anchor. Rows that left
 * the listing (refresh, navigation) are dropped by filtering against `entries`.
 */
export function updateFileSelection(
  entries: FileEntry[],
  selected: FileEntry[],
  anchor: string | null,
  entry: FileEntry,
  modifiers: { toggle: boolean; range: boolean }
): FileSelection {
  if (modifiers.range && anchor) {
    const from = entries.findIndex((item) => item.path === anchor)
    const to = entries.findIndex((item) => item.path === entry.path)
    if (from >= 0 && to >= 0) {
      const [start, end] = from <= to ? [from, to] : [to, from]
      return { selected: entries.slice(start, end + 1), anchor }
    }
  }
  if (modifiers.toggle) {
    const paths = new Set(selected.map((item) => item.path))
    if (paths.has(entry.path)) paths.delete(entry.path)
    else paths.add(entry.path)
    return {
      selected: entries.filter((item) => paths.has(item.path)),
      anchor: entry.path
    }
  }
  return { selected: [entry], anchor: entry.path }
}
