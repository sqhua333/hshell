/** Clipboard behavior shared by the terminal key handler, menu and dialogs. */
export type ClipboardKeyAction = 'copy' | 'paste' | 'pass'

export interface ClipboardKeyEvent {
  type?: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Decide whether Ctrl/Cmd+C or Ctrl/Cmd+V should copy, paste, or go to the
 * shell.
 *
 * VS Code keeps Ctrl+C for SIGINT and uses Ctrl+Shift+C/V for the clipboard.
 * HShell follows the friendlier terminal convention on Windows/Linux: Ctrl+C
 * copies when text is selected and sends SIGINT otherwise. macOS keeps Ctrl+C
 * for the shell because readline uses it; Command+C/V do the clipboard work.
 * Shifted combinations stay with the global shortcut map so they are not
 * handled twice.
 */
export function resolveClipboardKey(
  event: ClipboardKeyEvent,
  platform: string | undefined,
  hasSelection: boolean
): ClipboardKeyAction {
  if (event.type && event.type !== 'keydown') return 'pass'
  if (event.altKey || event.shiftKey) return 'pass'
  const isMac = platform === 'darwin'
  if (isMac) {
    if (!event.metaKey) return 'pass'
  } else if (!event.ctrlKey) {
    return 'pass'
  }
  const key = event.key.toLowerCase()
  if (key === 'c') return isMac || hasSelection ? 'copy' : 'pass'
  if (key === 'v') return 'paste'
  return 'pass'
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function pasteLines(text: string): string[] {
  if (!text) return []
  const lines = normalizeNewlines(text).split('\n')
  // A trailing newline terminates the last line; it does not add an empty one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function pasteLineCount(text: string): number {
  return pasteLines(text).length
}

/**
 * Multi-line text pasted into a normal shell is executed line by line, so a
 * single paste can run commands the user did not review. Programs that enable
 * bracketed paste receive the text as one block instead, which is safe.
 */
export function needsPasteConfirm(text: string, bracketedPasteMode: boolean): boolean {
  return Boolean(text) && !bracketedPasteMode && /[\r\n]/.test(text)
}

export interface PastePreview {
  /** Preview text, clipped to the requested number of lines and characters. */
  text: string
  lines: number
  characters: number
  truncated: boolean
}

export function pastePreview(
  text: string,
  maxLines = 6,
  maxLineLength = 180
): PastePreview {
  const lines = pasteLines(text)
  let truncated = lines.length > maxLines
  const shown = lines.slice(0, maxLines).map((line) => {
    if (line.length <= maxLineLength) return line
    truncated = true
    return `${line.slice(0, maxLineLength)}…`
  })
  return {
    text: shown.join('\n'),
    lines: lines.length,
    characters: text.length,
    truncated
  }
}
