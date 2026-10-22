import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppEvent, Session } from '@shared/types'
import { TelnetManager } from '../../src/main/telnet/manager'
import { DO, IAC, OPT_NAWS, OPT_SGA, OPT_TTYPE, SB, SE, WILL } from '../../src/main/telnet/protocol'

const RUNTIME = 'rt-telnet'

const SESSION: Session = {
  id: 's-telnet',
  name: 'telnet-test',
  folderId: null,
  host: '127.0.0.1',
  port: 2323,
  username: 'alice',
  auth: { method: 'password', password: 's3cret' },
  connectionType: 'telnet',
  telnet: { autoLogin: true },
  terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
  createdAt: 0,
  updatedAt: 0
}

async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

interface TestServer {
  server: net.Server
  port: number
  fromClient: () => Buffer
  toClient: (data: Buffer | string) => void
}

async function startServer(): Promise<TestServer> {
  const received: Buffer[] = []
  let socket: net.Socket | null = null
  const server = net.createServer((connection) => {
    socket = connection
    connection.on('data', (chunk) => received.push(chunk))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not start')
  return {
    server,
    port: address.port,
    fromClient: () => Buffer.concat(received),
    toClient: (data) => socket?.write(data)
  }
}

const cleanup: Array<() => void> = []

afterEach(() => {
  for (const task of cleanup.splice(0).reverse()) task()
})

function createManager(): {
  manager: TelnetManager
  events: AppEvent[]
  statuses: string[]
} {
  const events: AppEvent[] = []
  const statuses: string[] = []
  const manager = new TelnetManager((event) => {
    events.push(event)
    if (event.type === 'ssh:status') statuses.push(event.status)
  })
  cleanup.push(() => manager.disconnect(RUNTIME))
  return { manager, events, statuses }
}

function dataReceived(events: AppEvent[]): string {
  return Buffer.concat(
    events
      .filter((event): event is Extract<AppEvent, { type: 'ssh:data' }> => event.type === 'ssh:data')
      .map((event) => Buffer.from(event.data))
  ).toString('utf8')
}

describe('telnet connections', () => {
  it('negotiates options, exchanges data and reports the window size', async () => {
    const testServer = await startServer()
    cleanup.push(() => testServer.server.close())
    const { manager, events, statuses } = createManager()

    await manager.connect({
      runtimeId: RUNTIME,
      session: { ...SESSION, port: testServer.port },
      cols: 120,
      rows: 40
    })
    await waitFor(() => statuses.includes('connected'))

    await waitFor(() => testServer.fromClient().includes(Buffer.from([IAC, WILL, OPT_TTYPE])))
    expect(testServer.fromClient().includes(Buffer.from([IAC, WILL, OPT_NAWS]))).toBe(true)

    // The server accepts the options; the client answers and then receives
    // plain application data with every IAC sequence stripped.
    testServer.toClient(
      Buffer.concat([
        Buffer.from([IAC, DO, OPT_TTYPE]),
        Buffer.from([IAC, DO, OPT_NAWS]),
        Buffer.from([IAC, DO, OPT_SGA]),
        Buffer.from('welcome\r\n')
      ])
    )
    await waitFor(() => dataReceived(events).includes('welcome'))
    expect(dataReceived(events)).toBe('welcome\r\n')

    await waitFor(() =>
      testServer.fromClient().includes(
        Buffer.from([IAC, SB, OPT_NAWS, 0, 120, 0, 40, IAC, SE])
      )
    )

    manager.resize(RUNTIME, 100, 30)
    await waitFor(() =>
      testServer.fromClient().includes(
        Buffer.from([IAC, SB, OPT_NAWS, 0, 100, 0, 30, IAC, SE])
      )
    )

    manager.write(RUNTIME, 'ls\r')
    await waitFor(() => testServer.fromClient().toString('utf8').includes('ls\r\n'))

    manager.disconnect(RUNTIME)
    await waitFor(() => statuses.includes('closed'))
  }, 15_000)

  it('sends the configured credentials when the host prompts', async () => {
    const testServer = await startServer()
    cleanup.push(() => testServer.server.close())
    const { manager, statuses } = createManager()

    await manager.connect({
      runtimeId: RUNTIME,
      session: { ...SESSION, port: testServer.port },
      cols: 80,
      rows: 24
    })
    await waitFor(() => statuses.includes('connected'))

    testServer.toClient('login: ')
    await waitFor(() => testServer.fromClient().toString('utf8').includes('alice\r\n'))

    testServer.toClient('Password: ')
    await waitFor(() => testServer.fromClient().toString('utf8').includes('s3cret\r\n'))

    manager.disconnect(RUNTIME)
  }, 15_000)

  it('reports a refused connection with a readable error', async () => {
    const testServer = await startServer()
    const port = testServer.port
    await new Promise<void>((resolve) => testServer.server.close(() => resolve()))

    const { manager, events, statuses } = createManager()
    await manager.connect({
      runtimeId: RUNTIME,
      session: { ...SESSION, port },
      cols: 80,
      rows: 24
    })
    await waitFor(() => statuses.includes('failed'))
    const failure = events.find(
      (event): event is Extract<AppEvent, { type: 'ssh:status' }> =>
        event.type === 'ssh:status' && event.status === 'failed'
    )
    expect(failure?.message).toContain('连接被拒绝')
  }, 15_000)
})
