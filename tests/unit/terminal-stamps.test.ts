import { describe, expect, it } from 'vitest'
import { formatClock, STAMP_GUTTER_PX } from '../../src/renderer/src/lib/terminal-stamps'

describe('formatClock', () => {
  it('formats local time as a zero-padded 24-hour clock', () => {
    expect(formatClock(new Date(2026, 0, 5, 3, 4, 9))).toBe('03:04:09')
    expect(formatClock(new Date(2026, 9, 19, 15, 42, 0))).toBe('15:42:00')
  })

  it('uses 24-hour hours around midnight and noon', () => {
    expect(formatClock(new Date(2026, 9, 19, 0, 0, 0))).toBe('00:00:00')
    expect(formatClock(new Date(2026, 9, 19, 12, 0, 0))).toBe('12:00:00')
    expect(formatClock(new Date(2026, 9, 19, 23, 59, 59))).toBe('23:59:59')
  })

  it('reserves room for the 8-character clock', () => {
    expect(STAMP_GUTTER_PX).toBeGreaterThanOrEqual(64)
  })
})
