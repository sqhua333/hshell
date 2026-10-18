import { describe, expect, it } from 'vitest'
import {
  COLOR_SCHEMES,
  findColorScheme,
  legacyThemeForScheme,
  resolveColorScheme
} from '../../src/renderer/src/lib/color-schemes'

describe('color schemes', () => {
  it('offers unique, complete built-in schemes', () => {
    expect(COLOR_SCHEMES.length).toBeGreaterThanOrEqual(10)
    expect(new Set(COLOR_SCHEMES.map((scheme) => scheme.id)).size).toBe(COLOR_SCHEMES.length)
    for (const scheme of COLOR_SCHEMES) {
      expect(scheme.theme.background).toMatch(/^#[0-9a-f]{6}$/i)
      expect(scheme.theme.foreground).toMatch(/^#[0-9a-f]{6}$/i)
      expect(scheme.name.length).toBeGreaterThan(0)
      expect(scheme.nameEn.length).toBeGreaterThan(0)
    }
  })

  it('resolves a stored scheme id first', () => {
    expect(resolveColorScheme('dracula', 'light').id).toBe('dracula')
    expect(findColorScheme('nord')?.dark).toBe(true)
    expect(findColorScheme('missing')).toBeUndefined()
  })

  it('falls back to the legacy theme for older sessions', () => {
    expect(resolveColorScheme(undefined, 'dark').id).toBe('hshell-dark')
    expect(resolveColorScheme(undefined, 'light').id).toBe('hshell-light')
    expect(resolveColorScheme(undefined, 'solarized').id).toBe('solarized-dark')
  })

  it('falls back to the default scheme for unknown values', () => {
    expect(resolveColorScheme('nope', undefined).id).toBe('hshell-dark')
    expect(resolveColorScheme(undefined, 'bogus' as 'dark').id).toBe('hshell-dark')
  })

  it('maps schemes back to a legacy theme value', () => {
    expect(legacyThemeForScheme('hshell-dark')).toBe('dark')
    expect(legacyThemeForScheme('hshell-light')).toBe('light')
    expect(legacyThemeForScheme('solarized-light')).toBe('solarized')
    expect(legacyThemeForScheme('monokai')).toBe('dark')
    expect(legacyThemeForScheme('unknown')).toBe('dark')
  })
})
