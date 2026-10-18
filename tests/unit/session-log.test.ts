import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionLogger } from '../../src/main/storage/session-log'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hshell-log-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SessionLogger', () => {
  it('writes text logs with restrictive permissions and flushes on close', () => {
    const root = tempDir()
    const logger = new SessionLogger(join(root, 'logs'), 'demo', { format: 'text' })
    logger.write(Buffer.from('hello ', 'utf8'))
    // Split a multi-byte character across chunks.
    const bytes = Buffer.from('世界', 'utf8')
    logger.write(bytes.subarray(0, 2))
    logger.write(bytes.subarray(2))
    logger.close()

    expect(readFileSync(logger.filePath, 'utf8')).toBe('hello 世界')
    expect(dirname(logger.filePath)).toBe(join(root, 'logs'))
    expect(statSync(logger.filePath).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'logs')).mode & 0o777).toBe(0o700)
    expect(logger.size()).toBeGreaterThanOrEqual(Buffer.byteLength('hello 世界'))
  })

  it('writes an asciinema v2 header followed by output events', () => {
    const root = tempDir()
    const logger = new SessionLogger(root, 'cast', {
      format: 'asciinema',
      cols: 120,
      rows: 40,
      term: 'xterm-256color'
    })
    logger.write(Buffer.from('ls\r\n', 'utf8'))
    logger.write(Buffer.from('a.txt\r\n', 'utf8'))
    logger.close()

    const lines = readFileSync(logger.filePath, 'utf8').trim().split('\n')
    const header = JSON.parse(lines[0]) as Record<string, unknown>
    expect(header).toMatchObject({ version: 2, width: 120, height: 40 })
    expect(header.timestamp).toBeTypeOf('number')

    const events = lines.slice(1).map((line) => JSON.parse(line) as [number, string, string])
    expect(events.map((event) => event[1])).toEqual(['o', 'o'])
    expect(events.map((event) => event[2]).join('')).toBe('ls\r\na.txt\r\n')
    for (const event of events) expect(event[0]).toBeGreaterThanOrEqual(0)
  })

  it('rotates when the size limit is reached and keeps the configured number of files', () => {
    const root = tempDir()
    const logger = new SessionLogger(root, 'rotate', {
      format: 'text',
      maxBytes: 1024,
      keepFiles: 2
    })
    const first = 'a'.repeat(2048)
    logger.write(Buffer.from(first))
    logger.flush()
    logger.write(Buffer.from('second'))
    logger.flush()
    logger.write(Buffer.from('third'))
    logger.close()

    expect(existsSync(`${logger.filePath}.1`)).toBe(true)
    expect(existsSync(`${logger.filePath}.2`)).toBe(false)
    expect(readFileSync(`${logger.filePath}.1`, 'utf8')).toBe(first)
    expect(readFileSync(logger.filePath, 'utf8')).toBe('secondthird')
    expect(statSync(logger.filePath).size).toBeLessThan(1024)
  })

  it('sanitizes the label and keeps the file inside the log directory', () => {
    const root = tempDir()
    const logger = new SessionLogger(root, '../..\\evil/name', { format: 'text' })
    logger.close()
    expect(dirname(logger.filePath)).toBe(root)
    expect(basename(logger.filePath)).toMatch(/name-[0-9a-f]{8}\.log$/)
  })

  it('falls back to a safe name when the label has no usable characters', () => {
    const root = tempDir()
    const logger = new SessionLogger(root, '..', { format: 'text' })
    logger.close()
    expect(basename(logger.filePath)).toMatch(/^\d{8}-\d{6}-session-[0-9a-f]{8}\.log$/)
  })

  it('ignores writes after close', () => {
    const root = tempDir()
    const logger = new SessionLogger(root, 'closed', { format: 'text' })
    logger.write(Buffer.from('before'))
    logger.close()
    logger.write(Buffer.from('after'))
    expect(readFileSync(logger.filePath, 'utf8')).toBe('before')
  })
})
