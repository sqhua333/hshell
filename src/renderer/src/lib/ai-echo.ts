/**
 * Matching for echoing approved AI input back to the terminal.
 *
 * The exact text written by the session writer is compared against the
 * terminal stream. A line editor can repaint the echo, and consoles insert
 * soft line breaks (plus the padding space that comes with them) at their own
 * margins, so whitespace is ignored when the exact text is not found. A shell
 * that repaints its own input can also repeat the character at the wrap
 * boundary, so as a last resort the head and tail of the input are matched
 * separately. Every hit is mapped back to the original string.
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

/** Non-whitespace characters used to find the head and tail of an echo. */
const EDGE_CHARS = 24

export function findAiEchoMatch(stream: string, needle: string): AiEchoMatch | null {
  if (!needle) return null
  const exact = stream.lastIndexOf(needle)
  if (exact >= 0) return { start: exact, end: exact + needle.length }
  const target = squash(needle).text
  if (target.length < MIN_FUZZY_CHARS) return null
  const squashedStream = squash(stream)
  const flat = squashedStream.text
  const map = squashedStream.map
  const at = flat.lastIndexOf(target)
  if (at >= 0) {
    return { start: map[at], end: map[at + target.length - 1] + 1 }
  }
  // A shell that repaints a line longer than the terminal width repeats the
  // character at the soft-wrap boundary (`...ZI3` + newline + `mVEzi`), so the
  // echo is no longer a clean copy of the input. Match its head and tail
  // separately: both are far from the wraps, and together they still locate the
  // echoed rows.
  const head = target.slice(0, Math.min(EDGE_CHARS, target.length))
  const headAt = flat.lastIndexOf(head)
  if (headAt < 0) return null
  const tail = target.slice(-Math.min(EDGE_CHARS, target.length))
  const tailAt = flat.indexOf(tail, headAt + head.length)
  // The echo can arrive in pieces; until roughly all of it is here, wait so
  // the whole wrapped block is decorated at once instead of just its head.
  if (tailAt < 0 && headAt + target.length > flat.length) return null
  const endAt =
    tailAt >= 0
      ? Math.min(tailAt + tail.length - 1, flat.length - 1)
      : Math.min(headAt + target.length, flat.length - 1)
  return { start: map[headAt], end: map[endAt] + 1 }
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
