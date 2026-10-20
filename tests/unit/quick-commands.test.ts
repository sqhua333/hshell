import { describe, expect, it } from 'vitest'
import type { QuickCommand } from '../../src/shared/types'
import {
  mergeQuickCommands,
  normalizeQuickCommands,
  parseStoredQuickCommands,
  QUICK_COMMAND_MAX
} from '../../src/renderer/src/lib/quick-commands'

let counter = 0
const ids = (): string => `gen-${++counter}`

describe('normalizeQuickCommands', () => {
  it('trims text and keeps sendEnter=false', () => {
    expect(
      normalizeQuickCommands(
        [{ id: 'a', label: '  ls  ', command: ' ls -l ', sendEnter: false }],
        ids
      )
    ).toEqual([{ id: 'a', label: 'ls', command: 'ls -l', sendEnter: false }])
  })

  it('drops malformed and empty entries', () => {
    expect(
      normalizeQuickCommands(
        [
          null,
          'nope',
          { id: 'a', label: '', command: 'ls' },
          { id: 'b', label: 'ls', command: '   ' },
          { id: 'c', label: 42, command: 'ls' },
          { id: 'd', label: 'ok', command: 'pwd' }
        ],
        ids
      )
    ).toEqual([{ id: 'd', label: 'ok', command: 'pwd' }])
  })

  it('assigns ids only when missing', () => {
    const result = normalizeQuickCommands([{ label: 'a', command: '1' }], ids)
    expect(result[0]?.id).toBe('gen-1')
  })

  it('removes duplicates by label and command', () => {
    const result = normalizeQuickCommands(
      [
        { id: 'a', label: 'ls', command: 'ls -l' },
        { id: 'b', label: ' ls ', command: 'ls -l' },
        { id: 'c', label: 'ls', command: 'ls -la' }
      ],
      ids
    )
    expect(result.map((item) => item.id)).toEqual(['a', 'c'])
  })

  it('caps the list at the shared maximum', () => {
    const input: QuickCommand[] = Array.from({ length: QUICK_COMMAND_MAX + 5 }, (_, index) => ({
      id: `q${index}`,
      label: `c${index}`,
      command: `run ${index}`
    }))
    expect(normalizeQuickCommands(input, ids)).toHaveLength(QUICK_COMMAND_MAX)
  })

  it('rejects oversized text instead of truncating it', () => {
    const result = normalizeQuickCommands(
      [
        { id: 'long', label: 'x'.repeat(65), command: 'ls' },
        { id: 'ok', label: 'fine', command: 'ls' }
      ],
      ids
    )
    expect(result.map((item) => item.id)).toEqual(['ok'])
  })

  it('returns an empty list for non-array input', () => {
    expect(normalizeQuickCommands(undefined, ids)).toEqual([])
    expect(normalizeQuickCommands({ label: 'ls' }, ids)).toEqual([])
  })
})

describe('mergeQuickCommands', () => {
  it('merges legacy per-session commands without duplicates', () => {
    const global: QuickCommand[] = [{ id: 'g', label: 'uptime', command: 'uptime' }]
    const result = mergeQuickCommands(
      global,
      [
        { quickCommands: [{ id: 's1', label: 'ls', command: 'ls -l' }] },
        {
          quickCommands: [
            { id: 'dup', label: 'uptime', command: 'uptime' },
            { id: 's2', label: 'df', command: 'df -h' }
          ]
        },
        {}
      ],
      ids
    )
    expect(result.map((item) => item.id)).toEqual(['g', 's1', 's2'])
  })

  it('keeps the existing global list when there is nothing to migrate', () => {
    const global: QuickCommand[] = [{ id: 'g', label: 'uptime', command: 'uptime' }]
    expect(mergeQuickCommands(global, [], ids)).toEqual(global)
  })
})

describe('parseStoredQuickCommands', () => {
  it('distinguishes a missing key from an empty list', () => {
    expect(parseStoredQuickCommands(null, ids)).toBeNull()
    expect(parseStoredQuickCommands('[]', ids)).toEqual([])
  })

  it('recovers from corrupt JSON by returning an empty list', () => {
    expect(parseStoredQuickCommands('{not json', ids)).toEqual([])
    expect(parseStoredQuickCommands('null', ids)).toEqual([])
  })

  it('normalizes stored entries', () => {
    expect(
      parseStoredQuickCommands('[{"id":"a","label":" ls ","command":"ls -l"}]', ids)
    ).toEqual([{ id: 'a', label: 'ls', command: 'ls -l' }])
  })
})
