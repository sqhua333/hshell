import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Session } from '@shared/types'
import {
  ANY_HOST,
  LOOPBACK_HOST,
  isValidBindHost,
  listBindAddresses,
  startAiMcpServer,
  type AiMcpHandle
} from '../../src/main/ai/mcp-server'
import { SessionTap } from '../../src/main/ai/session-tap'

function makeSession(): Session {
  return {
    id: 's-mcp',
    name: 'mcp-target',
    folderId: null,
    host: 'example.com',
    port: 22,
    username: 'root',
    auth: { method: 'password' },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    createdAt: 0,
    updatedAt: 0
  }
}

function textOf(result: CallToolResult): string {
  const block = result.content?.[0]
  return block && block.type === 'text' ? block.text : ''
}

let handle: AiMcpHandle | null = null
let userData: string | null = null

afterEach(async () => {
  await handle?.close()
  handle = null
  if (userData) rmSync(userData, { recursive: true, force: true })
  userData = null
})

async function connect(tap: SessionTap, host?: string): Promise<Client> {
  userData = mkdtempSync(join(tmpdir(), 'hshell-mcp-'))
  handle = await startAiMcpServer(
    tap,
    userData,
    '0.0.0-test',
    host === undefined ? {} : { host }
  )
  // 0.0.0.0 is a listen address, not a connectable one, so dial loopback.
  const endpoint = new URL(handle.info.url)
  if (handle.info.host === ANY_HOST) endpoint.hostname = LOOPBACK_HOST
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: { Authorization: `Bearer ${handle.info.token}` }
    }
  })
  const client = new Client({ name: 'hshell-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

describe('AI MCP server', () => {
  it('rejects requests without the bearer token', async () => {
    userData = mkdtempSync(join(tmpdir(), 'hshell-mcp-'))
    handle = await startAiMcpServer(new SessionTap(), userData, '0.0.0-test')
    const response = await fetch(handle.info.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(response.status).toBe(401)

    const forbidden = await fetch(handle.info.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${handle.info.token}`,
        origin: 'https://evil.example'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(forbidden.status).toBe(403)
  })

  it('reuses the saved token, port and listen address across launches', async () => {
    userData = mkdtempSync(join(tmpdir(), 'hshell-mcp-'))
    const tap = new SessionTap()
    const first = await startAiMcpServer(tap, userData, '0.0.0-test', {
      host: ANY_HOST
    })
    const { url, token, host } = first.info
    expect(host).toBe(ANY_HOST)
    await first.close()

    handle = await startAiMcpServer(tap, userData, '0.0.0-test')
    expect(handle.info.token).toBe(token)
    expect(handle.info.url).toBe(url)
    expect(handle.info.host).toBe(ANY_HOST)
  })

  it('serves watched sessions when bound to all interfaces', async () => {
    const tap = new SessionTap()
    tap.register('rt-1', makeSession())
    tap.setWatched('rt-1', true)
    tap.recordOutput('rt-1', Buffer.from('from any interface'))
    const client = await connect(tap, ANY_HOST)
    const result = (await client.callTool({
      name: 'read_session',
      arguments: { runtimeId: 'rt-1' }
    })) as CallToolResult
    expect(textOf(result)).toContain('from any interface')
    await client.close()
  })

  it('validates bind addresses and lists real IPv4 NICs only', async () => {
    expect(isValidBindHost(LOOPBACK_HOST)).toBe(true)
    expect(isValidBindHost(ANY_HOST)).toBe(true)
    expect(isValidBindHost('203.0.113.9')).toBe(false)
    for (const item of listBindAddresses()) {
      expect(item.name).not.toBe('')
      expect(item.address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/)
    }
  })

  it('rejects an explicitly requested address that is not local', async () => {
    userData = mkdtempSync(join(tmpdir(), 'hshell-mcp-'))
    await expect(
      startAiMcpServer(new SessionTap(), userData, '0.0.0-test', {
        host: '203.0.113.9'
      })
    ).rejects.toThrow(/不可用/)
  })

  it('lists only read-only tools and only watched sessions', async () => {
    const tap = new SessionTap()
    tap.register('rt-1', makeSession())
    tap.recordOutput('rt-1', Buffer.from('hidden'))

    const client = await connect(tap)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'list_sessions',
      'read_session',
      'wait_for_output'
    ])
    for (const tool of tools.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
    }

    const hidden = (await client.callTool({
      name: 'list_sessions',
      arguments: {}
    })) as CallToolResult
    expect(JSON.parse(textOf(hidden)).sessions).toEqual([])

    tap.setWatched('rt-1', true)
    tap.recordOutput('rt-1', Buffer.from('visible'))
    const listed = (await client.callTool({
      name: 'list_sessions',
      arguments: {}
    })) as CallToolResult
    const sessions = JSON.parse(textOf(listed)).sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0].runtimeId).toBe('rt-1')
    expect(sessions[0].latestSeq).toBe(2)

    const read = (await client.callTool({
      name: 'read_session',
      arguments: { runtimeId: 'rt-1' }
    })) as CallToolResult
    const payload = JSON.parse(textOf(read))
    expect(payload.chunks.map((chunk: { text: string }) => chunk.text)).toEqual([
      'hidden',
      'visible'
    ])
    expect(payload.nextSeq).toBe(3)

    await client.close()
  })

  it('waits for matching output over MCP', async () => {
    const tap = new SessionTap()
    tap.register('rt-1', makeSession())
    tap.setWatched('rt-1', true)
    const client = await connect(tap)
    setTimeout(() => tap.recordOutput('rt-1', Buffer.from('login: ready')), 20)
    const result = (await client.callTool({
      name: 'wait_for_output',
      arguments: { runtimeId: 'rt-1', pattern: 'ready', timeoutMs: 2000 }
    })) as CallToolResult
    const payload = JSON.parse(textOf(result))
    expect(payload.matched).toBe(true)
    expect(payload.chunks[0].text).toContain('login: ready')
    await client.close()
  })
})
