import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveStartDir } from '../../src/main/util/start-dir'

describe('resolveStartDir', () => {
  it('prefers the desktop when it exists', () => {
    const existing = new Set([join('/home/demo', 'Desktop'), join('/home/demo', '桌面')])
    expect(resolveStartDir('/home/demo', (path) => existing.has(path))).toBe(
      join('/home/demo', 'Desktop')
    )
  })

  it('falls back to a localized desktop folder', () => {
    const existing = new Set([join('/home/demo', '桌面')])
    expect(resolveStartDir('/home/demo', (path) => existing.has(path))).toBe(
      join('/home/demo', '桌面')
    )
  })

  it('returns the home directory when no desktop exists', () => {
    expect(resolveStartDir('/home/demo', () => false)).toBe('/home/demo')
  })

  it('checks desktop candidates in a stable order', () => {
    const seen: string[] = []
    resolveStartDir('/home/demo', (path) => {
      seen.push(path)
      return false
    })
    expect(seen).toEqual([join('/home/demo', 'Desktop'), join('/home/demo', '桌面')])
  })
})
