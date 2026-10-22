import { describe, expect, it } from 'vitest'
import type { TriggerRule } from '@shared/types'
import {
  findHighlightLines,
  OutputRuleEngine,
  ruleRegExp,
  stripAnsi
} from '../../src/renderer/src/lib/output-rules'

const rule = (overrides: Partial<TriggerRule> = {}): TriggerRule => ({
  id: 'rule-1',
  pattern: 'ERROR',
  action: 'notify',
  payload: 'found',
  ...overrides
})

describe('stripAnsi', () => {
  it('removes CSI colors and cursor sequences', () => {
    expect(stripAnsi('\u001b[31mERROR\u001b[0m: failed')).toBe('ERROR: failed')
    expect(stripAnsi('a\u001b[2Kb')).toBe('ab')
  })

  it('keeps plain text untouched', () => {
    expect(stripAnsi('plain text')).toBe('plain text')
  })
})

describe('ruleRegExp', () => {
  it('escapes literal patterns', () => {
    expect(ruleRegExp({ id: '1', pattern: 'a.b' })?.test('a.b')).toBe(true)
    expect(ruleRegExp({ id: '1', pattern: 'a.b' })?.test('axb')).toBe(false)
  })

  it('honors regex and case sensitivity flags', () => {
    expect(ruleRegExp({ id: '1', pattern: 'er+or', regex: true })?.test('errr')).toBe(false)
    expect(ruleRegExp({ id: '1', pattern: '^err', regex: true })?.test('error')).toBe(true)
    expect(ruleRegExp({ id: '1', pattern: 'ERROR' })?.test('error')).toBe(true)
    expect(
      ruleRegExp({ id: '1', pattern: 'ERROR', caseSensitive: true })?.test('error')
    ).toBe(false)
  })

  it('returns null for invalid regular expressions', () => {
    expect(ruleRegExp({ id: '1', pattern: '(', regex: true })).toBeNull()
  })
})

describe('OutputRuleEngine', () => {
  it('matches a pattern split across two chunks exactly once', () => {
    const engine = new OutputRuleEngine(0)
    const matches: string[] = []
    engine.feed('xx ER', [rule()], (match) => matches.push(match.match))
    engine.feed('ROR yy', [rule()], (match) => matches.push(match.match))
    expect(matches).toEqual(['ERROR'])
  })

  it('applies a per-rule cooldown', () => {
    const engine = new OutputRuleEngine(1000)
    const matches: string[] = []
    engine.feed('ERROR', [rule()], (match) => matches.push(match.match), 1_000)
    engine.feed('ERROR', [rule()], (match) => matches.push(match.match), 1_500)
    engine.feed('ERROR', [rule()], (match) => matches.push(match.match), 2_500)
    expect(matches).toHaveLength(2)
  })

  it('ignores disabled rules and invalid regexes', () => {
    const engine = new OutputRuleEngine(0)
    const matches: string[] = []
    engine.feed(
      'ERROR',
      [rule({ enabled: false }), rule({ id: 'bad', regex: true, pattern: '(' })],
      (match) => matches.push(match.match)
    )
    expect(matches).toEqual([])
  })

  it('does not loop forever on empty regex matches', () => {
    const engine = new OutputRuleEngine(0)
    const matches: string[] = []
    engine.feed('abc', [rule({ regex: true, pattern: 'x*' })], (match) => matches.push(match.match))
    expect(matches).toEqual([])
  })

  it('caps fires per rule per chunk', () => {
    const engine = new OutputRuleEngine(0)
    const matches: string[] = []
    engine.feed('ERROR '.repeat(20), [rule()], (match) => matches.push(match.match))
    expect(matches).toHaveLength(5)
  })
})

describe('findHighlightLines', () => {
  const highlight = {
    id: 'hl-1',
    pattern: 'ERROR',
    background: '#ff0000'
  }

  it('reports each matching line relative to the end', () => {
    const result = findHighlightLines('ok\nERROR one\nok\nERROR two\n', [highlight])
    expect(result).toHaveLength(2)
    expect(result[0].lineFromEnd).toBe(3)
    expect(result[1].lineFromEnd).toBe(1)
  })

  it('applies only the first matching rule per line', () => {
    const result = findHighlightLines('WARN ERROR', [
      { id: 'warn', pattern: 'WARN', background: '#ffff00' },
      { ...highlight, id: 'error' }
    ])
    expect(result).toHaveLength(1)
    expect(result[0].rule.id).toBe('warn')
  })

  it('ignores disabled rules', () => {
    expect(
      findHighlightLines('ERROR', [{ ...highlight, enabled: false }])
    ).toEqual([])
  })

  it('supports regular expressions with case sensitivity', () => {
    const rules = [{ id: 're', pattern: '^fail', regex: true, caseSensitive: true }]
    expect(findHighlightLines('FAILED\nfailed', rules)).toHaveLength(1)
  })

  it('matches any literal keyword separated by commas', () => {
    const rules = [
      {
        id: 'multi',
        pattern: 'ERROR, WARNING，fatal',
        background: '#ff0000'
      }
    ]
    expect(findHighlightLines('ERROR one\nWARNING two\nfatal three', rules)).toHaveLength(3)
    expect(findHighlightLines('error is case-insensitive too', rules)).toHaveLength(1)
    expect(findHighlightLines('all good', rules)).toEqual([])
  })

  it('keeps literal commas out of the alternation and escapes metacharacters', () => {
    const rules = [{ id: 'literal', pattern: 'a.b,ERROR', background: '#ff0000' }]
    expect(findHighlightLines('a.b', rules)).toHaveLength(1)
    expect(findHighlightLines('axb', rules)).toEqual([])
  })

  it('does not split regex rules on commas', () => {
    const rules = [{ id: 're', pattern: 'ERROR,WARNING', regex: true }]
    expect(findHighlightLines('ERROR', rules)).toEqual([])
    expect(findHighlightLines('ERROR,WARNING', rules)).toHaveLength(1)
  })
})
