/** Local wall-clock stamp shown in the terminal gutter (`HH:mm:ss`, 24-hour). */
export function formatClock(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Width reserved for the gutter, in CSS pixels. */
export const STAMP_GUTTER_PX = 78
