export interface PasswordKeyResult {
  /** Masked characters to echo into the terminal (already includes erase). */
  echo: string
  input: string
  /** Set when the key sequence finished the prompt. */
  action?: 'submit' | 'cancel'
}

/**
 * Apply terminal input while the inline password prompt is active.
 *
 * Passwords are never echoed; one `*` is written per accepted character.
 * Ctrl+C cancels, Enter submits, Backspace/Delete removes the last character.
 * Escape sequences (arrow keys, function keys) are ignored as a whole.
 */
export function handlePasswordKeys(current: string, data: string): PasswordKeyResult {
  let input = current
  let echo = ''
  if (data.startsWith('\x1b')) return { echo, input }

  for (const char of data) {
    if (char === '\r' || char === '\n') return { echo, input, action: 'submit' }
    if (char === '\x03') return { echo, input, action: 'cancel' }
    if (char === '\x7f' || char === '\b') {
      if (input.length > 0) {
        input = input.slice(0, -1)
        echo += '\b \b'
      }
      continue
    }
    const code = char.codePointAt(0) ?? 0
    // Drop other control characters rather than putting them in the password.
    if (code < 0x20 || code === 0x7f) continue
    input += char
    echo += '*'
  }
  return { echo, input }
}
