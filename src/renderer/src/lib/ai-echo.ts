/**
 * Matching for echoing approved AI input back to the terminal.
 *
 * The exact text written by the session writer is compared against the
 * terminal stream. A line editor can repaint the echo, and serial consoles
 * insert soft line breaks (plus the padding space that comes with them) at
 * their own margins, so whitespace is ignored when the exact text is not
 * found, and the hit is mapped back to the original string.
 */

export interface AiEchoMatch {
  /** Index of the first matched character in the original stream. */
  start: number
  /** Index just past the last matched character in the original stream. */
  end: number
}

interface Squashed {
  text: string
  /** For each character of `text`, its index in the original string. */
  map: number[]
}

function squash(text: string): Squashed {
  let kept = ''
  const map: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char.trim() === '') continue
    kept += char
    map.push(index)
  }
  return { text: kept, map }
}

/**
 * Whitespace-insensitive matching is only used for longer inputs: on a short
 * command such as `ls` it would happily pair characters from unrelated output.
 */
const MIN_FUZZY_CHARS = 8

/** The value of `text` with all whitespace removed. */
export function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, '')
}

export function findAiEchoMatch(stream: string, needle: string): AiEchoMatch | null {
  if (!needle) return null
  const exact = stream.lastIndexOf(needle)
  if (exact >= 0) return { start: exact, end: exact + needle.length }
  const target = squash(needle).text
  if (target.length < MIN_FUZZY_CHARS) return null
  const squashedStream = squash(stream)
  const at = squashedStream.text.lastIndexOf(target)
  if (at < 0) return null
  return {
    start: squashedStream.map[at],
    end: squashedStream.map[at + target.length - 1] + 1
  }
}

/**
 * Short whitespace-free prefix used to find the echoed line in the screen
 * buffer, where the command may be split across wrapped rows.
 */
export function aiEchoProbe(needle: string, maxChars = 24): string {
  return squash(needle).text.slice(0, maxChars)
}

/**
 * Left offset (px) for the "AI input" tag that follows the echoed text on its
 * row: one cell after the last character, clamped so the tag stays inside the
 * terminal even when the command fills the row.
 */
export function aiTagLeft(
  afterColumns: number,
  cols: number,
  cellWidth: number,
  tagWidth: number
): number {
  const ideal = (Math.max(0, afterColumns) + 1) * cellWidth
  const right = Math.max(0, cols * cellWidth - tagWidth - 2)
  return Math.min(ideal, right)
}
