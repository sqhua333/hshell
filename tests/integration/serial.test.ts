import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SerialPort } from 'serialport'
import Zmodem from 'zmodem.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppEvent, Session } from '@shared/types'
import { SerialManager } from '../../src/main/serial/manager'

/**
 * Exercises the serial backend over a virtual serial pair created by socat.
 * The suite is skipped when socat is not installed (e.g. minimal CI images).
 */
const HAS_SOCAT = spawnSync('socat', ['-V'], { stdio: 'ignore' }).status === 0

const SERIAL: Session['serial'] = {
  path: '',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none'
}

const SESSION: Session = {
  id: 's-serial',
  name: 'serial-test',
  folderId: null,
  host: '',
  port: 1,
  username: 'serial',
  auth: { method: 'agent' },
  connectionType: 'serial',
  serial: SERIAL,
  terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
  createdAt: 0,
  updatedAt: 0
}

const RUNTIME = 'rt-serial'

async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function openPort(path: string, attempts = 1): Promise<SerialPort> {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate: 115200, autoOpen: false })
    port.open((error) => {
      if (!error) {
        resolve(port)
        return
      }
      // The previous owner may still be releasing the device.
      if (attempts > 1 && /EBUSY|Resource busy/i.test(error.message)) {
        setTimeout(() => resolve(openPort(path, attempts - 1)), 100)
        return
      }
      reject(error)
    })
  })
}

function closePort(port: SerialPort): Promise<void> {
  return new Promise((resolve) => {
    if (!port.isOpen) {
      resolve()
      return
    }
    port.close(() => resolve())
  })
}

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

interface Pair {
  a: string
  b: string
}

async function startSocatPair(): Promise<Pair> {
  const dir = mkdtempSync(join(tmpdir(), 'hshell-serial-'))
  const a = join(dir, 'a')
  const b = join(dir, 'b')
  const child: ChildProcess = spawn(
    'socat',
    ['-d', '-d', `pty,raw,echo=0,link=${a}`, `pty,raw,echo=0,link=${b}`],
    { stdio: 'ignore' }
  )
  cleanup.push(() => {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  })
  await waitFor(() => existsSync(a) && existsSync(b))
  return { a, b }
}

function createManager(logsDir?: string): {
  manager: SerialManager
  events: AppEvent[]
  statuses: string[]
} {
  const events: AppEvent[] = []
  const statuses: string[] = []
  const manager = new SerialManager(
    (event) => {
      events.push(event)
      if (event.type === 'ssh:status') statuses.push(event.status)
    },
    {
      pickDownloadDirectory: async () => null,
      pickUploadFiles: async () => null
    },
    logsDir
  )
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

describe.skipIf(!HAS_SOCAT)('serial connections', () => {
  it('opens a port and exchanges data in both directions', async () => {
    const pair = await startSocatPair()
    const peer = await openPort(pair.b)
    cleanup.push(() => closePort(peer))
    const peerData: Buffer[] = []
    peer.on('data', (chunk: Buffer) => peerData.push(chunk))

    const { manager, events, statuses } = createManager()
    await manager.connect({
      runtimeId: RUNTIME,
      session: { ...SESSION, serial: { ...SERIAL, path: pair.a } },
      cols: 80,
      rows: 24
    })
    await waitFor(() => statuses.includes('connected'))

    peer.write('from-device\r\n')
    await waitFor(() => dataReceived(events).includes('from-device'))
    expect(dataReceived(events)).toContain('from-device')

    manager.write(RUNTIME, 'from-host\r\n')
    await waitFor(() => Buffer.concat(peerData).toString('utf8').includes('from-host'))
    expect(Buffer.concat(peerData).toString('utf8')).toContain('from-host')

    manager.resize(RUNTIME, 120, 40)
    manager.ack(RUNTIME, 16)

    manager.disconnect(RUNTIME)
    await waitFor(() => statuses.includes('closed'))
    await closePort(peer)
    // The device must be released for the next process.
    const reopened = await openPort(pair.a, 20)
    await closePort(reopened)
  }, 20_000)

  it('passes ANSI color sequences through to the renderer unchanged', async () => {
    const pair = await startSocatPair()
    const peer = await openPort(pair.b)
    cleanup.push(() => closePort(peer))

    const { manager, events, statuses } = createManager()
    await manager.connect({
      runtimeId: RUNTIME,
      session: { ...SESSION, serial: { ...SERIAL, path: pair.a } },
      cols: 80,
      rows: 24
    })
    await waitFor(() => statuses.includes('connected'))

    const colored = '\u001b[31mred\u001b[0m \u001b[32mgreen\u001b[0m\r\n'
    peer.write(colored)
    await waitFor(() => dataReceived(events).includes('red'))
    // The serial path must not strip or rewrite SGR sequences; xterm applies
    // them with the session's palette.
    expect(dataReceived(events)).toContain(colored)

    manager.disconnect(RUNTIME)
  }, 20_000)

  it('writes terminal output to a session log', async () => {
    const pair = await startSocatPair()
    const peer = await openPort(pair.b)
    cleanup.push(() => closePort(peer))
    const logsDir = mkdtempSync(join(tmpdir(), 'hshell-serial-logs-'))
    cleanup.push(() => rmSync(logsDir, { recursive: true, force: true }))

    const { manager, statuses } = createManager(logsDir)
    await manager.connect({
      runtimeId: RUNTIME,
      session: {
        ...SESSION,
        serial: { ...SERIAL, path: pair.a },
        logging: { enabled: true, format: 'text' }
      },
      cols: 80,
      rows: 24
    })
    await waitFor(() => statuses.includes('connected'))

    peer.write('logged-serial-line\r\n')
    await new Promise((resolve) => setTimeout(resolve, 300))
    manager.disconnect(RUNTIME)

    await waitFor(() => readdirSync(logsDir).some((name) => name.endsWith('.log')))
    const file = readdirSync(logsDir).find((name) => name.endsWith('.log'))!
    expect(readFileSync(join(logsDir, file), 'utf8')).toContain('logged-serial-line')
  }, 20_000)

  it('routes ZMODEM protocol bytes away from the terminal', async () => {
    const pair = await startSocatPair()
    const peer = await openPort(pair.b)
    cleanup.push(() => closePort(peer))

    const { manager, events, statuses } = createManager()
    await manager.connect({
      runtimeId: RUNTIME,
      session: { ...SESSION, serial: { ...SERIAL, path: pair.a } },
      cols: 80,
      rows: 24
    })
    await waitFor(() => statuses.includes('connected'))

    peer.write('before\n')
    await waitFor(() => dataReceived(events).includes('before'))
    const header = Buffer.from(Zmodem.Header.build('ZRQINIT').to_hex())
    peer.write(header)

    await waitFor(() =>
      events.some(
        (event) => event.type === 'zmodem:status' && event.phase === 'detected'
      )
    )
    expect(dataReceived(events)).not.toContain('\x18B0')
  }, 20_000)

  it('reports a missing device with a clear error', async () => {
    const { manager, statuses, events } = createManager()
    await manager.connect({
      runtimeId: RUNTIME,
      session: {
        ...SESSION,
        serial: { ...SERIAL, path: join(tmpdir(), 'hshell-missing-serial-device') }
      },
      cols: 80,
      rows: 24
    })
    await waitFor(() => statuses.includes('failed'))
    const failure = events.find(
      (event): event is Extract<AppEvent, { type: 'ssh:status' }> =>
        event.type === 'ssh:status' && event.status === 'failed'
    )
    expect(failure?.message).toContain('找不到串口设备')
  }, 10_000)

  it('rejects an invalid baud rate before opening the device', async () => {
    const { manager, statuses, events } = createManager()
    await manager.connect({
      runtimeId: RUNTIME,
      session: {
        ...SESSION,
        serial: { ...SERIAL, path: '/dev/ttyUSB0', baudRate: 12 }
      },
      cols: 80,
      rows: 24
    })
    await waitFor(() => statuses.includes('failed'))
    const failure = events.find(
      (event): event is Extract<AppEvent, { type: 'ssh:status' }> =>
        event.type === 'ssh:status' && event.status === 'failed'
    )
    expect(failure?.message).toContain('波特率')
  }, 10_000)
})
