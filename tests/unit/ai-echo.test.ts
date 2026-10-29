import { describe, expect, it } from 'vitest'
import {
  aiEchoProbe,
  aiTagLeft,
  findAiEchoMatch,
  squashWhitespace
} from '../../src/renderer/src/lib/ai-echo'

const needle = 'echo "==A=="; uname -a; echo "==END=="'

describe('AI echo matching', () => {
  it('finds the echoed text after the prompt', () => {
    const stream = `root@SYSD:/# ${needle}\r\n`
    const match = findAiEchoMatch(stream, needle)
    expect(match).toEqual({
      start: 'root@SYSD:/# '.length,
      end: 'root@SYSD:/# '.length + needle.length
    })
  })

  it('prefers the last echo when a line editor repaints the line', () => {
    const stream = `${needle}\r\nroot@SYSD:/# ${needle}`
    const match = findAiEchoMatch(stream, needle)
    expect(stream.slice(match!.start, match!.end)).toBe(needle)
    expect(match!.start).toBe(needle.length + '\r\nroot@SYSD:/# '.length)
  })

  it('tolerates the line breaks and padding a serial console inserts', () => {
    const command = 'dumpe2fs -h /dev/mmcblk3p6 2>&1; echo "==END=="'
    const echoed = 'dumpe2fs -h /dev \r\n/mmcblk3p6 2>&1; echo "==END=="'
    const stream = `root@SYSD:/# ${echoed}\r\n`
    const match = findAiEchoMatch(stream, command)
    expect(match).not.toBeNull()
    expect(squashWhitespace(stream.slice(match!.start, match!.end))).toBe(
      squashWhitespace(command)
    )
  })

  it('waits for the whole echo before matching a mangled one', () => {
    const payload = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(2)
    const command = `echo '${payload}'; printf 'OK%s\\n' DONE`
    // zle and friends repeat the boundary character when they redraw a line
    // that is wider than the terminal.
    const middle = payload.length / 2
    const echoed = `${payload.slice(0, middle)}${payload[middle]}${payload.slice(middle)}`
    // The head is already on screen, but most of the command is still in
    // flight: decorating now would tint only the first row.
    const partial = `root@SYSD:/# echo '${echoed.slice(0, 30)}`
    expect(findAiEchoMatch(partial, command)).toBeNull()

    const stream = `root@SYSD:/# echo '${echoed}'; printf 'OK%s\\n' DONE\r\n`
    const match = findAiEchoMatch(stream, command)
    expect(match).not.toBeNull()
    expect(stream.slice(match!.start, match!.start + 6)).toBe("echo '")
    expect(squashWhitespace(stream.slice(match!.start, match!.end))).toContain(
      squashWhitespace(payload).slice(-24)
    )
  })

  it('returns null when the text never arrives', () => {
    expect(findAiEchoMatch('root@SYSD:/# ls\r\n', needle)).toBeNull()
    expect(findAiEchoMatch('', needle)).toBeNull()
    expect(findAiEchoMatch(needle, '')).toBeNull()
  })
})

describe('aiEchoProbe', () => {
  it('drops whitespace and keeps a short distinctive prefix', () => {
    expect(aiEchoProbe(needle)).toBe('echo"==A==";uname-a;echo')
    expect(aiEchoProbe('ls', 24)).toBe('ls')
  })
})

describe('short inputs', () => {
  it('does not fuzzy-match a short command against scattered characters', () => {
    const stream = 'lorem ipsum dolor sit amet\r\n'
    expect(findAiEchoMatch(stream, 'ls')).toBeNull()
  })
})

describe('aiTagLeft', () => {
  it('places the tag one cell after the echoed text', () => {
    expect(aiTagLeft(10, 80, 8, 40)).toBe(88)
  })

  it('keeps the tag inside the terminal when the row is full', () => {
    expect(aiTagLeft(79, 80, 8, 40)).toBe(640 - 40 - 2)
    expect(aiTagLeft(500, 80, 8, 40)).toBe(598)
  })

  it('falls back to the left edge for an empty row', () => {
    expect(aiTagLeft(0, 80, 8, 40)).toBe(8)
  })
})
