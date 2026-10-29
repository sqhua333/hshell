/**
 * Addresses a client can use for the MCP server.
 *
 * The listen address and the address clients dial are different things: a
 * server bound to `0.0.0.0` is reachable on loopback, every NIC, or through a
 * NAT/port-forward entry such as `10.0.2.2`. The dialog therefore keeps the
 * listen address fixed and lets the user pick (or type) the client-side host;
 * only the copied URL and `claude mcp add` command change.
 */

import type { AiBindAddress, AiMcpInfo } from '@shared/types'

export const ENDPOINT_HOST_STORAGE_KEY = 'hshell.ai.endpointHost'
export const LOOPBACK = '127.0.0.1'
export const ANY_HOST = '0.0.0.0'

/** Host shown by default for the current binding. */
export function defaultEndpointHost(info: AiMcpInfo): string {
  try {
    return new URL(info.url).hostname
  } catch {
    return info.host === ANY_HOST ? LOOPBACK : info.host
  }
}

/** Accept `http://host:port/path` or a bare host; drop scheme, port and path. */
export function normalizeEndpointHost(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^(\[[0-9a-f:]+\]|[^:[\]]+):\d+$/i, '$1')
    .trim()
}

/** A bare IPv4/host name, or an IPv6 literal in brackets. */
export function isPlausibleHost(host: string): boolean {
  return /^(\[[0-9a-f:]+\]|[A-Za-z0-9._-]+)$/i.test(host)
}

/**
 * Hosts that actually reach the server for this binding. A specific NIC binds
 * only that address; `0.0.0.0` also accepts loopback, every NIC and (through a
 * forward/NAT) an arbitrary host the user enters.
 */
export function endpointHosts(info: AiMcpInfo, bindings: AiBindAddress[]): string[] {
  if (info.host === ANY_HOST) {
    const hosts = [LOOPBACK, ...bindings.map((item) => item.address)]
    return hosts.filter((host, index) => hosts.indexOf(host) === index)
  }
  return [info.host]
}

export function endpointUrl(info: AiMcpInfo, host: string): string {
  return `http://${host}:${info.port}/mcp`
}

/** Pick the persisted choice when it still reaches the current binding. */
export function initialEndpointHost(
  info: AiMcpInfo,
  bindings: AiBindAddress[],
  saved: string | null
): { host: string; custom: string } {
  const hosts = endpointHosts(info, bindings)
  if (saved && hosts.includes(saved)) return { host: saved, custom: '' }
  if (saved && info.host === ANY_HOST && isPlausibleHost(saved)) {
    return { host: 'custom', custom: saved }
  }
  return { host: defaultEndpointHost(info), custom: '' }
}
