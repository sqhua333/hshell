import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Zmodem from 'zmodem.js'
import type { ZmodemSession } from 'zmodem.js'
import { ZmodemController, type ZmodemStatus } from '../../src/main/ssh/zmodem'

function hexHeader(name: 'ZRQINIT' | 'ZRINIT' | 'ZSKIP'): Buffer {
  const header =
    name === 'ZRINIT'
      ? Zmodem.Header.build('ZRINIT', ['CANFDX', 'CANOVIO', 'CANBRK'], 0)
      : Zmodem.Header.build(name)
  return Buffer.from(header.to_hex())
}

async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('ZmodemController detection', () => {
  it('passes ordinary terminal output through untouched', () => {
    const terminal: Buffer[] = []
    const controller = new ZmodemController({
      writeRemote: () => undefined,
      writeTerminal: (data) => terminal.push(Buffer.from(data)),
      status: () => undefined,
      host: {
        pickDownloadDirectory: async () => null,
        pickUploadFiles: async () => null
      }
    })
    controller.feed(Buffer.from('hello world\r\n'))
    controller.feed(Buffer.from('** not a header\r\n'))
    expect(Buffer.concat(terminal).toString()).toBe('hello world\r\n** not a header\r\n')
  })

  it('detects a ZRINIT header split across chunks without leaking it', async () => {
    const terminal: Buffer[] = []
    const statuses: ZmodemStatus[] = []
    const header = hexHeader('ZRINIT')
    const controller = new ZmodemController({
      writeRemote: () => undefined,
      writeTerminal: (data) => terminal.push(Buffer.from(data)),
      status: (update) => statuses.push(update),
      host: {
        pickDownloadDirectory: async () => null,
        pickUploadFiles: async () => null
      }
    })

    controller.feed(Buffer.concat([Buffer.from('before'), header.subarray(0, 3)]))
    controller.feed(header.subarray(3))
    await waitFor(() => statuses.some((update) => update.phase === 'cancelled'))

    expect(Buffer.concat(terminal).toString()).toBe('before')
    expect(statuses[0]).toMatchObject({ phase: 'detected', direction: 'upload' })
  })

  it('detects a ZRQINIT header and reports a download', async () => {
    const terminal: Buffer[] = []
    const statuses: ZmodemStatus[] = []
    const controller = new ZmodemController({
      writeRemote: () => undefined,
      writeTerminal: (data) => terminal.push(Buffer.from(data)),
      status: (update) => statuses.push(update),
      host: {
        pickDownloadDirectory: async () => null,
        pickUploadFiles: async () => null
      }
    })

    controller.feed(Buffer.concat([Buffer.from('line\n'), hexHeader('ZRQINIT')]))
    await waitFor(() => statuses.some((update) => update.phase === 'cancelled'))

    expect(Buffer.concat(terminal).toString()).toBe('line\n')
    expect(statuses[0]).toMatchObject({ phase: 'detected', direction: 'download' })
  })

  it('drops stray control headers left over from a finished session', () => {
    const terminal: Buffer[] = []
    const controller = new ZmodemController({
      writeRemote: () => undefined,
      writeTerminal: (data) => terminal.push(Buffer.from(data)),
      status: () => undefined,
      host: {
        pickDownloadDirectory: async () => null,
        pickUploadFiles: async () => null
      }
    })
    controller.feed(Buffer.concat([Buffer.from('prompt$ '), hexHeader('ZSKIP')]))
    controller.feed(hexHeader('ZSKIP'))
    expect(Buffer.concat(terminal).toString()).toBe('prompt$ ')
  })

  it('does not swallow a text line that merely resembles a header', () => {
    const terminal: Buffer[] = []
    const controller = new ZmodemController({
      writeRemote: () => undefined,
      writeTerminal: (data) => terminal.push(Buffer.from(data)),
      status: () => undefined,
      host: {
        pickDownloadDirectory: async () => null,
        pickUploadFiles: async () => null
      }
    })
    const text = Buffer.from('**\x18B0 this is not zmodem\r\n')
    controller.feed(text)
    expect(Buffer.concat(terminal).equals(text)).toBe(true)
  })
})

describe('ZmodemController transfers', () => {
  it('uploads a local file to a ZMODEM receiver', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hshell-zmodem-up-'))
    const file = join(dir, 'payload.bin')
    const payload = Buffer.from(Array.from({ length: 100_000 }, (_, i) => i % 251))
    writeFileSync(file, payload)

    const statuses: ZmodemStatus[] = []
    let peer: ZmodemSession | undefined
    const controller = new ZmodemController({
      writeRemote: (data) => peer?.consume(Array.from(data)),
      writeTerminal: () => undefined,
      status: (update) => statuses.push(update),
      host: {
        pickDownloadDirectory: async () => null,
        pickUploadFiles: async () => [file]
      }
    })

    peer = Zmodem.Session.parse(Array.from(hexHeader('ZRQINIT')))
    expect(peer?.type).toBe('receive')
    const received: Buffer[] = []
    peer!.on('offer', (offer) => {
      void offer.accept({
        on_input: (chunk) => {
          received.push(Buffer.from(chunk))
        }
      })
    })
    peer!.set_sender((octets) => controller.feed(Buffer.from(octets)))
    void peer!.start()

    await waitFor(() => statuses.some((update) => update.phase === 'complete'))
    expect(Buffer.concat(received).equals(payload)).toBe(true)
  }, 15_000)

  it('reports an error when the remote receiver skips the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hshell-zmodem-skip-'))
    const file = join(dir, 'rejected.bin')
    writeFileSync(file, Buffer.from('payload'))

    const statuses: ZmodemStatus[] = []
    let peer: ZmodemSession | undefined
    const controller = new ZmodemController({
      writeRemote: (data) => peer?.consume(Array.from(data)),
      writeTerminal: () => undefined,
      status: (update) => statuses.push(update),
      host: {
        pickDownloadDirectory: async () => null,
        pickUploadFiles: async () => [file]
      }
    })

    peer = Zmodem.Session.parse(Array.from(hexHeader('ZRQINIT')))
    peer!.on('offer', (offer) => offer.skip())
    peer!.set_sender((octets) => controller.feed(Buffer.from(octets)))
    void peer!.start()

    await waitFor(() => statuses.some((update) => update.phase === 'error'))
    const error = statuses.find((update) => update.phase === 'error')
    expect(error).toMatchObject({ direction: 'upload', fileName: 'rejected.bin' })
    expect(error?.message).toContain('远端拒绝接收')
    expect(statuses.some((update) => update.phase === 'complete')).toBe(false)
  }, 15_000)

  it('reports an error instead of completing when the local write fails', async () => {
    const missingDir = join(tmpdir(), `hshell-zmodem-missing-${Date.now()}`)
    const payload = Buffer.from('data that cannot be written\n'.repeat(100))
    const statuses: ZmodemStatus[] = []

    let peer: ZmodemSession | undefined
    let skippedInitialZrinit = false
    const controller = new ZmodemController({
      writeRemote: (data) => {
        const bytes = Buffer.from(data)
        const zrinitPrefix = Buffer.from([0x2a, 0x2a, 0x18, 0x42, 0x30, 0x31])
        if (!skippedInitialZrinit && bytes.subarray(0, 6).equals(zrinitPrefix)) {
          skippedInitialZrinit = true
          return
        }
        peer?.consume(Array.from(bytes))
      },
      writeTerminal: () => undefined,
      status: (update) => statuses.push(update),
      host: {
        pickDownloadDirectory: async () => missingDir,
        pickUploadFiles: async () => null
      }
    })

    peer = Zmodem.Session.parse(Array.from(hexHeader('ZRINIT')))
    peer!.set_sender((octets) => controller.feed(Buffer.from(octets)))
    controller.feed(hexHeader('ZRQINIT'))
    await waitFor(() => statuses.some((update) => update.phase === 'detected'))

    const transfer = await peer!.send_offer({
      name: 'blocked.txt',
      size: payload.length,
      mtime: new Date(),
      files_remaining: 1,
      bytes_remaining: payload.length
    })
    await transfer!.end(new Uint8Array(payload))

    await waitFor(() => statuses.some((update) => update.phase === 'error'))
    const error = statuses.find((update) => update.phase === 'error')
    expect(error).toMatchObject({ direction: 'download', fileName: 'blocked.txt' })
    expect(error?.message).toContain('接收失败')
    expect(statuses.some((update) => update.phase === 'file-complete')).toBe(false)
  }, 15_000)

  it('receives a file offered by a ZMODEM sender', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hshell-zmodem-down-'))
    const payload = Buffer.from('hello from the remote side\n'.repeat(2000))
    const statuses: ZmodemStatus[] = []

    let peer: ZmodemSession | undefined
    let skippedInitialZrinit = false
    const controller = new ZmodemController({
      writeRemote: (data) => {
        const bytes = Buffer.from(data)
        // The peer below is initialised with an equivalent ZRINIT, so skip
        // the receiver's initial ZRINIT to keep its state machine happy.
        // Later ZRINITs (after ZEOF) must reach the sender to finish.
        const zrinitPrefix = Buffer.from([0x2a, 0x2a, 0x18, 0x42, 0x30, 0x31])
        if (!skippedInitialZrinit && bytes.subarray(0, 6).equals(zrinitPrefix)) {
          skippedInitialZrinit = true
          return
        }
        peer?.consume(Array.from(bytes))
      },
      writeTerminal: () => undefined,
      status: (update) => statuses.push(update),
      host: {
        pickDownloadDirectory: async () => dir,
        pickUploadFiles: async () => null
      }
    })

    peer = Zmodem.Session.parse(Array.from(hexHeader('ZRINIT')))
    expect(peer?.type).toBe('send')
    peer!.set_sender((octets) => controller.feed(Buffer.from(octets)))

    // Remote `sz` announces itself with ZRQINIT.
    controller.feed(hexHeader('ZRQINIT'))
    await waitFor(() => statuses.some((update) => update.phase === 'detected'))

    const transfer = await peer!.send_offer({
      name: 'incoming.txt',
      size: payload.length,
      mtime: new Date(),
      files_remaining: 1,
      bytes_remaining: payload.length
    })
    expect(transfer).toBeDefined()
    await transfer!.end(new Uint8Array(payload))

    await waitFor(() => statuses.some((update) => update.phase === 'file-complete'))
    await waitFor(() => {
      try {
        return readFileSync(join(dir, 'incoming.txt')).length === payload.length
      } catch {
        return false
      }
    })
    expect(readFileSync(join(dir, 'incoming.txt')).equals(payload)).toBe(true)
  }, 15_000)
})
