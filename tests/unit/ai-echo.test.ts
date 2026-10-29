import { describe, expect, it } from 'vitest'
import { aiEchoProbe, findAiEchoMatch, squashWhitespace } from '../../src/renderer/src/lib/ai-echo'

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
