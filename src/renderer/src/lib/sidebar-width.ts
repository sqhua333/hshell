export const SIDEBAR_MIN_PX = 180
export const SIDEBAR_MAX_PX = 520
export const SIDEBAR_DEFAULT_PX = 252

/** Keep the session manager usable without letting it crowd out the terminal. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_PX
  return Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, Math.round(width)))
}
