import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readUiTheme,
  WINDOW_BACKGROUND,
  writeUiTheme
} from '../../src/main/theme-prefs'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hshell-theme-prefs-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ui theme preferences', () => {
  it('reports no preference before the user has chosen a theme', () => {
    expect(readUiTheme(tempDir())).toBeNull()
  })

  it('round-trips both themes', () => {
    const dir = tempDir()
    writeUiTheme(dir, 'dark')
    expect(readUiTheme(dir)).toBe('dark')
    writeUiTheme(dir, 'light')
    expect(readUiTheme(dir)).toBe('light')
  })

  it('normalizes unknown values to light', () => {
    const dir = tempDir()
    writeUiTheme(dir, 'solarized')
    expect(readUiTheme(dir)).toBe('light')
  })

  it('treats a corrupt preference file as unset', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'ui-prefs.json'), '{not json')
    expect(readUiTheme(dir)).toBeNull()
  })

  it('keeps the window background in sync with the renderer themes', () => {
    expect(WINDOW_BACKGROUND.light).toBe('#eef1f5')
    expect(WINDOW_BACKGROUND.dark).toBe('#171b22')
  })
})
