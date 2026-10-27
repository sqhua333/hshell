import type { HighlightRule } from '@shared/types'
import { stripAnsi } from '@shared/ansi'

export { stripAnsi }

export interface MatchableRule {
  id: string
  pattern: string
  regex?: boolean
  caseSensitive?: boolean
  enabled?: boolean
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Highlight literals may list several keywords separated by commas (ASCII or
 * full-width), e.g. `ERROR,WARN，FATAL`. Regex rules are left untouched so
 * quantifiers such as `a{1,3}` keep working.
 */
function highlightPatternSource(pattern: string): string {
  const parts = pattern
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return ''
  return parts.map(escapeRegExp).join('|')
}

/** Compile a rule; invalid regular expressions are ignored instead of throwing. */
export function ruleRegExp(rule: MatchableRule, global = false): RegExp | null {
  if (!rule.pattern) return null
  const source = rule.regex ? rule.pattern : escapeRegExp(rule.pattern)
  const flags = `${global ? 'g' : ''}${rule.caseSensitive ? '' : 'i'}`
  try {
    return new RegExp(source, flags)
  } catch {
    return null
  }
}

/** Like `ruleRegExp`, but a literal highlight may contain several keywords. */
function highlightRegExp(rule: HighlightRule): RegExp | null {
  if (!rule.pattern) return null
  if (rule.regex) return ruleRegExp(rule)
  const source = highlightPatternSource(rule.pattern)
  if (!source) return null
  try {
    return new RegExp(source, rule.caseSensitive ? '' : 'i')
  } catch {
    return null
  }
}

export interface RuleMatch<T extends MatchableRule> {
  rule: T
  match: string
  /** Index relative to the start of the newly supplied chunk. */
  index: number
}

const MAX_CARRY = 512
const MAX_FIRES_PER_RULE = 5

/**
 * Matches output rules against a stream of terminal chunks.
 *
 * A short carry buffer lets patterns split across chunks match exactly once;
 * matches that lie entirely in the carry are not reported again. A per-rule
 * cooldown prevents a `send` action from triggering itself in a tight loop.
 */
export class OutputRuleEngine<T extends MatchableRule> {
  private carry = ''
  private fired = new Map<string, number>()

  constructor(private readonly cooldownMs = 1000) {}

  feed(text: string, rules: readonly T[], emit: (match: RuleMatch<T>) => void, now = Date.now()): void {
    if (!text) return
    const merged = this.carry + text
    const boundary = this.carry.length

    for (const rule of rules) {
      if (rule.enabled === false) continue
      const regexp = ruleRegExp(rule, true)
      if (!regexp) continue
      let count = 0
      let match: RegExpExecArray | null
      while ((match = regexp.exec(merged))) {
        if (match[0].length === 0) {
          regexp.lastIndex += 1
          continue
        }
        const end = match.index + match[0].length
        // Fully inside the carry: reported by an earlier feed already.
        if (end <= boundary) continue
        const last = this.fired.get(rule.id) ?? Number.NEGATIVE_INFINITY
        if (now - last < this.cooldownMs) break
        this.fired.set(rule.id, now)
        emit({ rule, match: match[0], index: match.index - boundary })
        count += 1
        if (count >= MAX_FIRES_PER_RULE) break
      }
    }

    this.carry = merged.slice(-MAX_CARRY)
  }

  reset(): void {
    this.carry = ''
    this.fired.clear()
  }
}

export interface HighlightLine {
  rule: HighlightRule
  /** 0 is the last line of the chunk; positive values go up. */
  lineFromEnd: number
}

/** Find the first matching highlight rule for each visible output line. */
export function findHighlightLines(
  text: string,
  rules: readonly HighlightRule[]
): HighlightLine[] {
  if (!rules.some((rule) => rule.enabled !== false)) return []
  const lines = stripAnsi(text).split('\n')
  const result: HighlightLine[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line) continue
    for (const rule of rules) {
      if (rule.enabled === false) continue
      const regexp = highlightRegExp(rule)
      if (regexp?.test(line)) {
        result.push({ rule, lineFromEnd: lines.length - 1 - index })
        break
      }
    }
  }
  return result
}
