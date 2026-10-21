import { describe, expect, it } from 'vitest'
import {
  needsPasteConfirm,
  pasteLineCount,
  pasteLines,
  pastePreview,
  resolveClipboardKey,
  type ClipboardKeyEvent
} from '../../src/renderer/src/lib/terminal-clipboard'

function key(
  value: string,
  modifiers: Partial<Omit<ClipboardKeyEvent, 'key'>> = {}
): ClipboardKeyEvent {
  return {
    type: 'keydown',
    key: value,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers
  }
}

describe('resolveClipboardKey', () => {
  it('copies with Ctrl+C on Windows/Linux when text is selected', () => {
    expect(resolveClipboardKey(key('c', { ctrlKey: true }), 'linux', true)).toBe('copy')
    expect(resolveClipboardKey(key('c', { ctrlKey: true }), 'win32', true)).toBe('copy')
  })

  it('leaves Ctrl+C for SIGINT when nothing is selected', () => {
    expect(resolveClipboardKey(key('c', { ctrlKey: true }), 'linux', false)).toBe('pass')
  })

  it('pastes with Ctrl+V on Windows/Linux', () => {
    expect(resolveClipboardKey(key('v', { ctrlKey: true }), 'win32', false)).toBe('paste')
  })

  it('leaves shifted and alt combinations to the global shortcut map', () => {
    expect(
      resolveClipboardKey(key('c', { ctrlKey: true, shiftKey: true }), 'linux', true)
    ).toBe('pass')
    expect(
      resolveClipboardKey(key('v', { ctrlKey: true, shiftKey: true }), 'linux', false)
    ).toBe('pass')
    expect(resolveClipboardKey(key('c', { ctrlKey: true, altKey: true }), 'linux', true)).toBe(
      'pass'
    )
  })

  it('uses Command+C/V on macOS regardless of selection', () => {
    expect(resolveClipboardKey(key('c', { metaKey: true }), 'darwin', false)).toBe('copy')
    expect(resolveClipboardKey(key('v', { metaKey: true }), 'darwin', false)).toBe('paste')
  })

  it('keeps Ctrl+C for readline on macOS', () => {
    expect(resolveClipboardKey(key('c', { ctrlKey: true }), 'darwin', true)).toBe('pass')
    expect(resolveClipboardKey(key('v', { ctrlKey: true }), 'darwin', false)).toBe('pass')
  })

  it('ignores key-up events and unrelated keys', () => {
    expect(
      resolveClipboardKey({ ...key('c', { ctrlKey: true }), type: 'keyup' }, 'linux', true)
    ).toBe('pass')
    expect(resolveClipboardKey(key('x', { ctrlKey: true }), 'linux', true)).toBe('pass')
    expect(resolveClipboardKey(key('c'), 'linux', true)).toBe('pass')
  })

  it('treats an unknown platform as Windows/Linux', () => {
    expect(resolveClipboardKey(key('c', { ctrlKey: true }), undefined, true)).toBe('copy')
  })
})

describe('multi-line paste detection', () => {
  it('counts logical lines and ignores the trailing newline', () => {
    expect(pasteLineCount('')).toBe(0)
    expect(pasteLineCount('one line')).toBe(1)
    expect(pasteLineCount('one\ntwo')).toBe(2)
    expect(pasteLineCount('one\ntwo\n')).toBe(2)
    expect(pasteLineCount('one\r\ntwo\r\n')).toBe(2)
    expect(pasteLineCount('one\rtwo')).toBe(2)
  })

  it('normalizes CRLF and lone CR for display', () => {
    expect(pasteLines('a\r\nb\rc')).toEqual(['a', 'b', 'c'])
  })

  it('requires confirmation for line breaks unless bracketed paste is on', () => {
    expect(needsPasteConfirm('ls -la', false)).toBe(false)
    expect(needsPasteConfirm('ls -la\nrm -rf build', false)).toBe(true)
    expect(needsPasteConfirm('ls -la\r\npwd', false)).toBe(true)
    expect(needsPasteConfirm('', false)).toBe(false)
    expect(needsPasteConfirm('ls\npwd', true)).toBe(false)
  })
})

describe('pastePreview', () => {
  it('reports line and character counts', () => {
    const preview = pastePreview('one\ntwo\nthree')
    expect(preview.lines).toBe(3)
    expect(preview.characters).toBe(13)
    expect(preview.text).toBe('one\ntwo\nthree')
    expect(preview.truncated).toBe(false)
  })

  it('clips long pastes and marks them as truncated', () => {
    const text = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n')
    const preview = pastePreview(text, 3, 80)
    expect(preview.lines).toBe(8)
    expect(preview.text).toBe('1\n2\n3')
    expect(preview.truncated).toBe(true)
  })

  it('clips very long lines', () => {
    const preview = pastePreview('x'.repeat(30), 6, 10)
    expect(preview.text).toBe(`${'x'.repeat(10)}…`)
    expect(preview.truncated).toBe(true)
  })

  it('handles empty input', () => {
    const preview = pastePreview('')
    expect(preview).toEqual({ text: '', lines: 0, characters: 0, truncated: false })
  })
})
