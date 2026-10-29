import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import { SessionTap, cleanTapText } from '../../src/main/ai/session-tap'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-ai',
    name: 'ai-target',
    folderId: null,
    host: 'example.com',
    port: 22,
    username: 'root',
    auth: { method: 'password' },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function watchedTap(runtimeId = 'rt-1'): SessionTap {
  const tap = new SessionTap()
  tap.register(runtimeId, makeSession())
  tap.setWatched(runtimeId, true)
  return tap
}

function textOf(result: { chunks: Array<{ text: string }> }): string {
  return result.chunks.map((chunk) => chunk.text).join('')
}

describe('cleanTapText', () => {
  it('strips ANSI, carriage returns and control characters', () => {
    expect(cleanTapText('\x1b[31mred\x1b[0m\r\nnext\x00\x07')).toBe('red\nnext')
    // A bare CR overwrites the line on a terminal; keep the line break instead.
    expect(cleanTapText('progress 10%\rprogress 100%')).toBe('progress 10%\nprogress 100%')
  })
})

describe('SessionTap buffering', () => {
  it('ignores traffic for sessions it never registered', () => {
    const tap = new SessionTap()
    expect(() => tap.recordOutput('missing', Buffer.from('x'))).not.toThrow()
    expect(() => tap.recordInput('missing', 'x')).not.toThrow()
    expect(() => tap.setWatched('missing', true)).toThrow()
  })

  it('only lists and reads sessions the user marked as watched', () => {
    const tap = new SessionTap()
    tap.register('rt-1', makeSession())
    tap.recordOutput('rt-1', Buffer.from('secret output'))
    expect(tap.list()).toEqual([])
    expect(() => tap.read('rt-1')).toThrow(/AI 观察/)

    tap.setWatched('rt-1', true)
    expect(tap.watchedIds()).toEqual(['rt-1'])
    const [summary] = tap.list()
    expect(summary.runtimeId).toBe('rt-1')
    expect(summary.target).toBe('root@example.com:22')
    expect(summary.latestSeq).toBe(1)
    expect(textOf(tap.read('rt-1'))).toBe('secret output')
  })

  it('tracks status events and records input separately from output', () => {
    const tap = watchedTap()
    tap.observeEvent({ type: 'ssh:status', runtimeId: 'rt-1', status: 'connected' })
    tap.recordInput('rt-1', 'ls\r')
    tap.recordOutput('rt-1', Buffer.from('file.txt\n'))
    expect(tap.list()[0].status).toBe('connected')
    const result = tap.read('rt-1')
    expect(result.chunks.map((chunk) => [chunk.direction, chunk.text])).toEqual([
      ['in', 'ls\n'],
      ['out', 'file.txt\n']
    ])
    expect(result.nextSeq).toBe(3)
  })

  it('grants input only after watching and marks who typed it', () => {
    const tap = new SessionTap()
    tap.register('rt-1', makeSession())
    expect(() => tap.setWritable('rt-1', true)).toThrow(/AI 观察/)

    tap.setWatched('rt-1', true)
    tap.setWritable('rt-1', true)
    tap.observeEvent({ type: 'ssh:status', runtimeId: 'rt-1', status: 'connected' })
    expect(tap.list()[0].writable).toBe(true)
    expect(tap.requireInput('rt-1').name).toBe('ai-target')

    tap.recordInput('rt-1', 'id\r', 'ai')
    tap.recordInput('rt-1', 'echo hi\r', 'user')
    const inputs = tap.read('rt-1').chunks.filter((chunk) => chunk.direction === 'in')
    expect(inputs.map((chunk) => chunk.source)).toEqual(['ai', 'user'])
  })

  it('revokes input when watching stops', () => {
    const tap = watchedTap()
    tap.observeEvent({ type: 'ssh:status', runtimeId: 'rt-1', status: 'connected' })
    tap.setWritable('rt-1', true)
    tap.setWatched('rt-1', false)
    expect(() => tap.requireInput('rt-1')).toThrow(/AI 观察/)

    tap.setWatched('rt-1', true)
    expect(tap.list()[0].writable).toBe(false)
    expect(() => tap.requireInput('rt-1')).toThrow(/AI 输入/)
  })

  it('grants auto input only on top of a writable grant, and drops it with it', () => {
    const tap = watchedTap()
    tap.observeEvent({ type: 'ssh:status', runtimeId: 'rt-1', status: 'connected' })
    expect(() => tap.setAutoInput('rt-1', true)).toThrow(/允许 AI 输入/)

    tap.setWritable('rt-1', true)
    tap.setAutoInput('rt-1', true)
    expect(tap.list()[0].autoInput).toBe(true)
    expect(tap.requireInput('rt-1').autoInput).toBe(true)

    tap.setWritable('rt-1', false)
    expect(tap.list()[0].autoInput).toBe(false)

    tap.setWritable('rt-1', true)
    tap.setAutoInput('rt-1', true)
    tap.setWatched('rt-1', false)
    tap.setWatched('rt-1', true)
    expect(tap.list()[0].autoInput).toBe(false)
    expect(tap.list()[0].writable).toBe(false)
  })

  it('refuses input while the session is not connected', () => {
    const tap = watchedTap()
    tap.setWritable('rt-1', true)
    expect(() => tap.requireInput('rt-1')).toThrow(/未连接/)

    tap.observeEvent({ type: 'ssh:status', runtimeId: 'rt-1', status: 'connected' })
    expect(() => tap.requireInput('rt-1')).not.toThrow()

    tap.observeEvent({ type: 'ssh:status', runtimeId: 'rt-1', status: 'closed' })
    expect(() => tap.requireInput('rt-1')).toThrow(/未连接/)
  })

  it('returns the newest tail when no sequence is given', () => {
    const tap = watchedTap()
    tap.recordOutput('rt-1', Buffer.from('aaa'))
    tap.recordOutput('rt-1', Buffer.from('bbb'))
    tap.recordOutput('rt-1', Buffer.from('ccc'))
    const tail = tap.read('rt-1')
    expect(tail.chunks.map((chunk) => chunk.seq)).toEqual([1, 2, 3])
    // A limit smaller than the buffer keeps only the most recent chunk.
    const limited = tap.read('rt-1', undefined, 4)
    expect(limited.chunks.map((chunk) => chunk.text)).toEqual(['ccc'])
    expect(limited.nextSeq).toBe(4)
  })

  it('pages from sinceSeq and reports when more chunks remain', () => {
    const tap = watchedTap()
    for (const text of ['a', 'b', 'c']) tap.recordOutput('rt-1', Buffer.from(text))
    const first = tap.read('rt-1', 1, 2)
    expect(first.chunks.map((chunk) => chunk.text)).toEqual(['a', 'b'])
    expect(first.nextSeq).toBe(3)
    expect(first.hasMore).toBe(true)
    expect(first.truncated).toBe(false)

    const second = tap.read('rt-1', first.nextSeq, 2)
    expect(second.chunks.map((chunk) => chunk.text)).toEqual(['c'])
    expect(second.hasMore).toBe(false)
  })

  it('reports truncation once the ring buffer dropped older chunks', () => {
    const tap = watchedTap()
    for (let index = 0; index < 4100; index += 1) {
      tap.recordOutput('rt-1', Buffer.from('x'))
    }
    const [summary] = tap.list()
    expect(summary.firstSeq).toBeGreaterThan(1)
    const result = tap.read('rt-1', 1)
    expect(result.truncated).toBe(true)
    expect(result.chunks[0].seq).toBe(summary.firstSeq)
  })

  it('drops a session and its buffer when it is unregistered', () => {
    const tap = watchedTap()
    tap.recordOutput('rt-1', Buffer.from('bye'))
    tap.unregister('rt-1')
    expect(tap.has('rt-1')).toBe(false)
    expect(tap.list()).toEqual([])
    expect(() => tap.read('rt-1')).toThrow(/不存在/)
  })
})

describe('SessionTap.waitForOutput', () => {
  it('resolves when new output matches a pattern', async () => {
    const tap = watchedTap()
    const waiting = tap.waitForOutput('rt-1', {
      pattern: 'ready',
      quietMs: 100,
      timeoutMs: 2000
    })
    setTimeout(() => tap.recordOutput('rt-1', Buffer.from('\x1b[32mServer ready\x1b[0m')), 20)
    const result = await waiting
    expect(result.matched).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(textOf(result)).toContain('Server ready')
  })

  it('settles after new output goes quiet', async () => {
    const tap = watchedTap()
    const waiting = tap.waitForOutput('rt-1', { quietMs: 50, timeoutMs: 2000 })
    tap.recordOutput('rt-1', Buffer.from('tick'))
    const result = await waiting
    expect(result.matched).toBe(false)
    expect(result.timedOut).toBe(false)
    expect(textOf(result)).toBe('tick')
  })

  it('starts from now, so buffered history does not resolve a wait', async () => {
    const tap = watchedTap()
    tap.recordOutput('rt-1', Buffer.from('old output'))
    const result = await tap.waitForOutput('rt-1', { quietMs: 50, timeoutMs: 150 })
    expect(result.timedOut).toBe(true)
    expect(result.chunks).toEqual([])
  })

  it('rejects invalid patterns and unwatched sessions', async () => {
    const tap = new SessionTap()
    tap.register('rt-1', makeSession())
    await expect(tap.waitForOutput('rt-1')).rejects.toThrow(/AI 观察/)
    tap.setWatched('rt-1', true)
    await expect(tap.waitForOutput('rt-1', { pattern: '[' })).rejects.toThrow(/正则/)
  })
})
