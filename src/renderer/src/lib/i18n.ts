import type { Language } from '@shared/types'

export type Locale = Language

const STORAGE_KEY = 'hshell:locale'

function readLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

let current: Locale = typeof window === 'undefined' ? 'zh' : readLocale()

export function getLocale(): Locale {
  return current
}

export function applyLocale(locale: Locale): void {
  current = locale
  try {
    localStorage.setItem(STORAGE_KEY, locale)
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN'
  } catch {
    /* storage may be unavailable */
  }
}

/** Pick a string for the current locale. */
export function tr(zh: string, en: string): string {
  return current === 'en' ? en : zh
}

/** Replace `{name}` placeholders in a translated string. */
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in values ? String(values[key]) : `{${key}}`
  )
}
