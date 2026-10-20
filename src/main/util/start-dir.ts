import { join } from 'node:path'

/** Folder names desktop environments use for the user's desktop. */
export const DESKTOP_DIR_NAMES = ['Desktop', '桌面'] as const

/**
 * Folder the local SFTP pane opens in: the user's desktop when it exists,
 * otherwise the home directory. Matches the remote pane's default so both
 * sides start somewhere familiar on Windows, macOS and Linux.
 */
export function resolveStartDir(
  home: string,
  isDirectory: (path: string) => boolean
): string {
  for (const name of DESKTOP_DIR_NAMES) {
    const candidate = join(home, name)
    if (isDirectory(candidate)) return candidate
  }
  return home
}
