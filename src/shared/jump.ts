export interface JumpHop {
  username?: string
  host: string
  port: number
}

const MAX_HOPS = 8
const HOST_PATTERN = /^[A-Za-z0-9._\-:[\]]+$/

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value)) throw new Error(`ProxyJump 端口无效：${value}`)
  const port = Number(value)
  if (port < 1 || port > 65535) throw new Error(`ProxyJump 端口超出范围：${value}`)
  return port
}

function parseHop(raw: string): JumpHop {
  const text = raw.trim()
  if (!text) throw new Error('ProxyJump 包含空的跳板机')
  if (text.length > 512) throw new Error('ProxyJump 过长')

  let rest = text
  let username: string | undefined
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    username = rest.slice(0, at)
    rest = rest.slice(at + 1)
    if (!username || /[\s\u0000-\u001f\u007f]/.test(username)) {
      throw new Error('ProxyJump 用户名无效')
    }
  }

  let host: string
  let port = 22
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    if (end < 0) throw new Error('ProxyJump IPv6 地址缺少 ]')
    host = rest.slice(1, end)
    const tail = rest.slice(end + 1)
    if (tail) {
      if (!tail.startsWith(':')) throw new Error(`ProxyJump 格式无效：${raw}`)
      port = parsePort(tail.slice(1))
    }
    if (!host.includes(':')) throw new Error(`ProxyJump 地址无效：${raw}`)
  } else {
    const parts = rest.split(':')
    if (parts.length > 2) {
      throw new Error('IPv6 跳板机地址需要用 [addr]:port 括起来')
    }
    host = parts[0]
    if (parts.length === 2) port = parsePort(parts[1])
  }

  if (!host || host.length > 255) throw new Error(`ProxyJump 主机名无效：${raw}`)
  if (!HOST_PATTERN.test(host)) throw new Error(`ProxyJump 主机名包含无效字符：${raw}`)
  if (host.startsWith('-')) throw new Error(`ProxyJump 主机名无效：${raw}`)

  return { username, host, port }
}

/**
 * Parse OpenSSH `ProxyJump` syntax: a comma-separated chain of
 * `[user@]host[:port]` entries, with bracketed IPv6 addresses.
 * `none` and an empty value both mean "no jump host".
 */
export function parseProxyJump(input: string | null | undefined): JumpHop[] {
  if (!input) return []
  const text = input.trim()
  if (!text || text.toLowerCase() === 'none') return []
  const parts = text.split(',')
  if (parts.length > MAX_HOPS) throw new Error(`ProxyJump 最多支持 ${MAX_HOPS} 跳`)
  return parts.map(parseHop)
}

/** Format a hop back to OpenSSH syntax (used for display and tests). */
export function formatProxyJump(hops: JumpHop[]): string {
  return hops
    .map((hop) => {
      const host = hop.host.includes(':') ? `[${hop.host}]` : hop.host
      return `${hop.username ? `${hop.username}@` : ''}${host}:${hop.port}`
    })
    .join(',')
}
