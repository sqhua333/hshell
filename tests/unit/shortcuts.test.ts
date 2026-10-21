import { describe, expect, it } from 'vitest'
import { matchShortcut } from '../../src/renderer/src/lib/shortcuts'

function key(
  value: string,
  modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {}
): KeyboardEvent {
  return {
    key: value,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers
  } as KeyboardEvent
}

describe('terminal clipboard shortcuts', () => {
  it('does not register contextual Ctrl+C / Ctrl+V globally', () => {
    // The terminal decides whether Ctrl+C copies or sends SIGINT. Registering
    // it globally would steal SIGINT from the shell.
    expect(matchShortcut(key('c', { ctrlKey: true }))).toBeNull()
    expect(matchShortcut(key('v', { ctrlKey: true }))).toBeNull()
  })

  it('keeps the explicit copy and paste combinations global', () => {
    expect(matchShortcut(key('c', { ctrlKey: true, shiftKey: true }))?.action).toBe('edit:copy')
    expect(matchShortcut(key('v', { ctrlKey: true, shiftKey: true }))?.action).toBe('edit:paste')
    expect(matchShortcut(key('Insert', { ctrlKey: true }))?.action).toBe('edit:copy')
    expect(matchShortcut(key('Insert', { shiftKey: true }))?.action).toBe('edit:paste')
  })
})
