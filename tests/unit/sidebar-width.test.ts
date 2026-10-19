import { describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX
} from '../../src/renderer/src/lib/sidebar-width'

describe('clampSidebarWidth', () => {
  it('keeps widths inside the allowed range', () => {
    expect(clampSidebarWidth(300)).toBe(300)
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_PX)
    expect(clampSidebarWidth(5000)).toBe(SIDEBAR_MAX_PX)
  })

  it('rounds pointer positions to whole pixels', () => {
    expect(clampSidebarWidth(300.6)).toBe(301)
  })

  it('falls back to the default for invalid values', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_PX)
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_PX)
  })
})
