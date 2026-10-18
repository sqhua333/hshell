import { describe, expect, it } from 'vitest'
import {
  highlightRuleSchema,
  quickCommandSchema,
  recordingSaveSchema,
  triggerRuleSchema
} from '@shared/schemas'

describe('quick command schema', () => {
  it('accepts a command button', () => {
    const parsed = quickCommandSchema.parse({
      id: 'qc-1',
      label: '  Disk usage  ',
      command: 'df -h',
      sendEnter: false
    })
    expect(parsed.label).toBe('Disk usage')
    expect(parsed.sendEnter).toBe(false)
  })

  it('rejects empty labels and oversized commands', () => {
    expect(() => quickCommandSchema.parse({ id: 'x', label: ' ', command: 'ls' })).toThrow()
    expect(() =>
      quickCommandSchema.parse({ id: 'x', label: 'ok', command: 'a'.repeat(4097) })
    ).toThrow()
  })
})

describe('trigger rule schema', () => {
  it('accepts send and notify rules', () => {
    expect(
      triggerRuleSchema.parse({
        id: 'tr-1',
        pattern: 'Password:',
        action: 'send',
        payload: 'secret\r'
      }).action
    ).toBe('send')
    expect(
      triggerRuleSchema.parse({
        id: 'tr-2',
        pattern: '^ERROR',
        regex: true,
        caseSensitive: true,
        action: 'notify',
        payload: 'error seen'
      }).regex
    ).toBe(true)
  })

  it('rejects unknown actions and empty patterns', () => {
    expect(() =>
      triggerRuleSchema.parse({ id: 'x', pattern: 'x', action: 'exploit', payload: '' })
    ).toThrow()
    expect(() =>
      triggerRuleSchema.parse({ id: 'x', pattern: '', action: 'notify', payload: '' })
    ).toThrow()
  })
})

describe('highlight rule schema', () => {
  it('accepts hex colors', () => {
    const parsed = highlightRuleSchema.parse({
      id: 'hl-1',
      pattern: 'ERROR',
      background: '#FFD54F',
      foreground: '#1f2937'
    })
    expect(parsed.background).toBe('#FFD54F')
  })

  it('rejects non-hex colors and long patterns', () => {
    expect(() =>
      highlightRuleSchema.parse({ id: 'hl', pattern: 'x', background: 'red' })
    ).toThrow()
    expect(() =>
      highlightRuleSchema.parse({ id: 'hl', pattern: 'a'.repeat(513) })
    ).toThrow()
  })
})

describe('recording save schema', () => {
  it('accepts script content and a safe file name', () => {
    expect(
      recordingSaveSchema.parse({ content: 'console.log(1)', defaultName: 'hshell-demo.mjs' })
        .defaultName
    ).toBe('hshell-demo.mjs')
  })

  it('rejects path separators and empty content', () => {
    expect(() => recordingSaveSchema.parse({ content: 'x', defaultName: '../evil.mjs' })).toThrow()
    expect(() => recordingSaveSchema.parse({ content: '', defaultName: 'ok.mjs' })).toThrow()
  })
})
