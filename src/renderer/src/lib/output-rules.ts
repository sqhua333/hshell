import type { HighlightRule } from '@shared/types'

/** Matches CSI/OSC/character-set escape sequences emitted by full-screen apps. */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

/** Remove escape sequences so rules match what the user actually sees. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '').replace(/\r/g, '')
}

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
      const regexp = ruleRegExp(rule)
      if (regexp?.test(line)) {
        result.push({ rule, lineFromEnd: lines.length - 1 - index })
        break
      }
    }
  }
  return result
}
