import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { AiBindAddress, AiMcpInfo } from '@shared/types'
import type { AiWaitOptions, SessionTap } from './session-tap'
import type { SendInputHandler } from './session-writer'

export type { AiMcpInfo }

export interface AiMcpHandle {
  info: AiMcpInfo
  close(): Promise<void>
}

const ENDPOINT_FILE = 'ai-mcp.json'
const MAX_BODY_BYTES = 1024 * 1024
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function textResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }
    ],
    ...(isError ? { isError: true } : {})
  }
}

function toolFailure(error: unknown): CallToolResult {
  return textResult(`Error: ${(error as Error).message}`, true)
}

/**
 * MCP surface over the session tap. Only sessions the user marked as watched
 * are listed or readable. When a writer is supplied, `send_input` is exposed
 * too, but every call still has to be approved inside HShell.
 */
function buildServer(
  tap: SessionTap,
  version: string,
  sendInput?: SendInputHandler
): McpServer {
  const server = new McpServer({ name: 'hshell', version })

  server.registerTool(
    'list_sessions',
    {
      title: 'List AI-watched HShell sessions',
      description:
        'List terminal sessions the user has enabled for AI access, with their runtimeId, ' +
        'connection type, status and buffered sequence range. Only these sessions can be read.',
      annotations: { readOnlyHint: true }
    },
    async () => {
      try {
        return textResult({ sessions: tap.list() })
      } catch (error) {
        return toolFailure(error)
      }
    }
  )

  server.registerTool(
    'read_session',
    {
      title: 'Read buffered terminal traffic',
      description:
        'Return terminal input and output captured for a watched session, oldest first. ' +
        'Pass sinceSeq to continue after a previous read; omit it to get the most recent ' +
        'maxBytes. Text has ANSI escapes and control characters removed. `truncated` means ' +
        'the requested sinceSeq is no longer buffered; `hasMore` means call again with nextSeq.',
      inputSchema: {
        runtimeId: z.string().describe('runtimeId from list_sessions'),
        sinceSeq: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Continue after this sequence number (nextSeq from a previous read)'),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(262144)
          .optional()
          .describe('Maximum bytes to return (default 64 KiB, max 256 KiB)')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ runtimeId, sinceSeq, maxBytes }) => {
      try {
        return textResult(tap.read(runtimeId, sinceSeq, maxBytes))
      } catch (error) {
        return toolFailure(error)
      }
    }
  )

  server.registerTool(
    'wait_for_output',
    {
      title: 'Wait for new terminal output',
      description:
        'Long-poll a watched session. Resolves early when new text matches the optional ' +
        'regex `pattern`, or once the stream has been quiet for quietMs after new data, or ' +
        'when timeoutMs expires. Use after sending commands so you can see the result ' +
        'instead of polling read_session in a loop.',
      inputSchema: {
        runtimeId: z.string().describe('runtimeId from list_sessions'),
        sinceSeq: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Start after this sequence number; defaults to "new data only"'),
        pattern: z
          .string()
          .max(512)
          .optional()
          .describe('JavaScript regular expression to wait for (optional)'),
        quietMs: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .optional()
          .describe('Resolve after this long without new data (default 300 ms)'),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(120000)
          .optional()
          .describe('Give up after this long (default 10 s, max 120 s)')
      },
      annotations: { readOnlyHint: true }
    },
    async (options: AiWaitOptions & { runtimeId: string }) => {
      try {
        const { runtimeId, ...rest } = options
        return textResult(await tap.waitForOutput(runtimeId, rest))
      } catch (error) {
        return toolFailure(error)
      }
    }
  )

  if (sendInput) {
    server.registerTool(
      'send_input',
      {
        title: 'Type into a session (requires human approval)',
        description:
          'Send terminal input to a session the user allowed AI input for. HShell shows ' +
          'the exact text and your reason to the user, and only writes after they approve; ' +
          'the call blocks until then. Returns { status: "sent" | "denied" | "timeout" | ' +
          '"blocked", message? }. With submit=true (default) Enter is appended. Control ' +
          'characters other than tab/newline are rejected. Only printable text is allowed; ' +
          'the user sees everything, including anything sensitive you type.',
        inputSchema: {
          runtimeId: z.string().describe('runtimeId from list_sessions'),
          text: z
            .string()
            .min(1)
            .max(4096)
            .describe('Text to type; a newline may be included'),
          submit: z
            .boolean()
            .optional()
            .describe('Append Enter after the text (default true)'),
          reason: z
            .string()
            .max(512)
            .optional()
            .describe('Short explanation shown on the approval card')
        },
        annotations: { readOnlyHint: false, destructiveHint: true }
      },
      async ({ runtimeId, text, submit, reason }) => {
        try {
          return textResult(await sendInput({ runtimeId, text, submit, reason }))
        } catch (error) {
          return toolFailure(error)
        }
      }
    )
  }

  return server
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const expected = `Bearer ${token}`
  if (header.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(expected, 'utf8'))
}

/** Reject browser origins other than loopback (DNS-rebinding defence). */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname)
  } catch {
    return false
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) throw new Error('请求体为空')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

/** Default binding; a VM cannot reach this, which is the safe choice. */
export const LOOPBACK_HOST = '127.0.0.1'
/** Bind every interface, useful for NAT guests that reach the host via a gateway. */
export const ANY_HOST = '0.0.0.0'

interface SavedEndpoint {
  /** Preferred port so a previously registered client keeps working. */
  port: number | null
  token: string | null
  host: string | null
}

/** Non-loopback IPv4 addresses that currently exist on this machine. */
export function listBindAddresses(): AiBindAddress[] {
  const result: AiBindAddress[] = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      // IPv6 adds bracket formatting and is rarely needed for a local VM.
      if (entry.family === 'IPv4' && !entry.internal) {
        result.push({ name, address: entry.address })
      }
    }
  }
  return result.sort(
    (a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address)
  )
}

export function isValidBindHost(host: string): boolean {
  return (
    host === LOOPBACK_HOST ||
    host === ANY_HOST ||
    listBindAddresses().some((item) => item.address === host)
  )
}

/** The address a client should use when the server listens on 0.0.0.0. */
function displayHost(host: string): string {
  if (host !== ANY_HOST) return host
  return listBindAddresses()[0]?.address ?? LOOPBACK_HOST
}

/**
 * Reuse the endpoint details from a previous launch: the port and token are
 * baked into the client's `claude mcp add` command, so rotating them on every
 * start would silently break that configuration. Only a token minted by this
 * module (32 base64url characters) is accepted from disk.
 */
function readSavedEndpoint(userData: string): SavedEndpoint {
  try {
    const raw = JSON.parse(readFileSync(join(userData, ENDPOINT_FILE), 'utf8')) as {
      port?: unknown
      token?: unknown
      host?: unknown
    }
    const token =
      typeof raw.token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(raw.token)
        ? raw.token
        : null
    const port =
      typeof raw.port === 'number' &&
      Number.isInteger(raw.port) &&
      raw.port > 0 &&
      raw.port < 65536
        ? raw.port
        : null
    // An adapter that disappeared since the last launch falls back to loopback
    // instead of preventing the server from starting.
    const host =
      typeof raw.host === 'string' && isValidBindHost(raw.host) ? raw.host : null
    return { port, token, host }
  } catch {
    return { port: null, token: null, host: null }
  }
}

/** Listen on `host:port` (port 0 = random) and report the port actually bound. */
function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const cleanup = (): void => {
      server.off('error', onError)
      server.off('listening', onListening)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onListening = (): void => {
      cleanup()
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Bind the requested address, degrading gracefully: a taken port switches to
 * a random one, and an adapter that vanished (VPN down) falls back to
 * loopback. The caller reports the address actually bound.
 */
async function bindServer(
  server: Server,
  requestedHost: string,
  preferredPort: number
): Promise<{ host: string; port: number }> {
  let host = requestedHost
  let port = preferredPort
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return { host, port: await listen(server, host, port) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code === 'EADDRINUSE' || code === 'EACCES') && port !== 0) {
        port = 0
        continue
      }
      if (
        host !== LOOPBACK_HOST &&
        (code === 'EADDRNOTAVAIL' || code === 'ENETDOWN' || code === 'EINVAL')
      ) {
        host = LOOPBACK_HOST
        port = preferredPort
        continue
      }
      throw error
    }
  }
  throw new Error('无法绑定 MCP 监听地址')
}

export interface AiMcpOptions {
  host?: string
  /** Exposes `send_input` through the approval broker; omit for read-only. */
  sendInput?: SendInputHandler
}

/**
 * Start the MCP endpoint. It binds loopback by default; `options.host` may
 * select a NIC address (or 0.0.0.0) so a VM can reach it, which the UI warns
 * about explicitly. The bearer token and port are written to
 * `userData/ai-mcp.json` (mode 0600) so the user can configure an MCP client
 * once; later launches reuse them when the address is still available. The
 * server is stateless and closes with the app.
 */
export async function startAiMcpServer(
  tap: SessionTap,
  userData: string,
  version: string,
  options: AiMcpOptions = {}
): Promise<AiMcpHandle> {
  const saved = readSavedEndpoint(userData)
  // An explicit request is validated up front so the dialog can show an error,
  // while a stale saved adapter quietly falls back to loopback.
  const host = options.host ?? saved.host ?? LOOPBACK_HOST
  if (options.host !== undefined && !isValidBindHost(host)) {
    throw new Error(`监听地址当前不可用：${host}`)
  }
  const token = saved.token ?? randomBytes(24).toString('base64url')
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (!originAllowed(req)) {
        sendJson(res, 403, { error: 'origin not allowed' })
        return
      }
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      if (req.method !== 'POST' || req.url?.split('?')[0] !== '/mcp') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      let body: unknown
      try {
        body = await readBody(req)
      } catch (error) {
        sendJson(res, 400, { error: (error as Error).message })
        return
      }
      const mcp = buildServer(tap, version, options.sendInput)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      })
      res.on('close', () => {
        void transport.close().catch(() => undefined)
        void mcp.close().catch(() => undefined)
      })
      try {
        await mcp.connect(transport)
        await transport.handleRequest(req, res, body)
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message })
        else res.end()
      }
    })()
  })

  const bound = await bindServer(server, host, saved.port ?? 0)
  const info: AiMcpInfo = {
    // 0.0.0.0 is not a connectable address; show the first NIC instead.
    url: `http://${displayHost(bound.host)}:${bound.port}/mcp`,
    token,
    host: bound.host
  }
  try {
    mkdirSync(userData, { recursive: true })
    writeFileSync(
      join(userData, ENDPOINT_FILE),
      JSON.stringify({ ...info, port: bound.port }, null, 2),
      { mode: 0o600 }
    )
  } catch {
    // The endpoint still works; the renderer can show the config directly.
  }

  return {
    info,
    async close() {
      await new Promise<void>((done) => {
        server.close(() => done())
        // Do not wait for keep-alive sockets to drain during quit.
        server.closeAllConnections?.()
      })
    }
  }
}
