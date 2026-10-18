import { afterEach, describe, expect, it } from 'vitest'
import { applyLocale, fmt, getLocale, tr } from '../../src/renderer/src/lib/i18n'

afterEach(() => applyLocale('zh'))

describe('i18n', () => {
  it('defaults to Chinese and switches to English', () => {
    applyLocale('zh')
    expect(getLocale()).toBe('zh')
    expect(tr('新建会话', 'New session')).toBe('新建会话')

    applyLocale('en')
    expect(getLocale()).toBe('en')
    expect(tr('新建会话', 'New session')).toBe('New session')
  })

  it('returns the Chinese string when no English translation is needed', () => {
    applyLocale('en')
    expect(tr('SSH', 'SSH')).toBe('SSH')
  })

  it('substitutes placeholders without throwing on unknown keys', () => {
    expect(fmt('导入 {count} 个会话', { count: 3 })).toBe('导入 3 个会话')
    expect(fmt('{a}-{b}', { a: 'x' })).toBe('x-{b}')
  })
})
