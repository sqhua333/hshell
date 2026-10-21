/**
 * Pick a tab title for a new local shell. The first one is just "本地终端" /
 * "Local shell"; later ones get a numeric suffix so tabs stay distinguishable.
 */
export function localShellTitle(base: string, existing: readonly string[]): string {
  if (!existing.includes(base)) return base
  let index = 2
  while (existing.includes(`${base} ${index}`)) index += 1
  return `${base} ${index}`
}
