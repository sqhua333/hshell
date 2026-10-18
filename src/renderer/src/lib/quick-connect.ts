export function parseQuickConnect(
  input: string,
  defaultUsername: string
): { username: string; host: string; port: number } | null {
  let raw = input.trim()
  if (!raw) return null
  let username = defaultUsername
  const at = raw.indexOf('@')
  if (at >= 0) {
    username = raw.slice(0, at) || defaultUsername
    raw = raw.slice(at + 1)
  }
  let host = raw
  let port = 22
  const colon = raw.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(raw.slice(colon + 1))) {
    host = raw.slice(0, colon)
    port = Math.max(1, Math.min(65535, Number(raw.slice(colon + 1))))
  }
  if (!host) return null
  return { username, host, port }
}
