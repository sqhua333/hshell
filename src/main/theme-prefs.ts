import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type UiTheme = 'light' | 'dark'

/** Keep in sync with the `--bg` values in the renderer stylesheet. */
export const WINDOW_BACKGROUND: Record<UiTheme, string> = {
  light: '#eef1f5',
  dark: '#171b22'
}

const FILE = 'ui-prefs.json'

interface UiPrefs {
  theme: UiTheme
}

/**
 * Saved theme, or `null` when the user has never chosen one. The distinction
 * lets the renderer fall back to its legacy localStorage value after an
 * upgrade, instead of silently resetting a dark-theme user to light.
 */
export function readUiTheme(dir: string): UiTheme | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as Partial<UiPrefs>
    return parsed.theme === 'dark' ? 'dark' : parsed.theme === 'light' ? 'light' : null
  } catch {
    return null
  }
}

export function writeUiTheme(dir: string, theme: unknown): void {
  const value: UiTheme = theme === 'dark' ? 'dark' : 'light'
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, FILE), JSON.stringify({ theme: value }), { mode: 0o600 })
  } catch {
    /* persisting the preference is best-effort */
  }
}
