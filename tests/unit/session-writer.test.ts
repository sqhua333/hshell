import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiInputRequest, AppEvent, Session } from '@shared/types'
import { createSessionWriter, withEnter } from '../../src/main/ai/session-writer'
import { SessionTap } from '../../src/main/ai/session-tap'

function makeSession(): Session {
  return {
    id: 's-writer',
    name: 'serial-target',
    folderId: null,
    host: 'COM9',
    port: 115200,
    username: '',
    auth: { method: 'password' },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    connectionType: 'serial',
    createdAt: 0,
    updatedAt: 0
  }
}

interface Harness {
  tap: SessionTap
  writer: ReturnType<typeof createSessionWriter>
  events: AppEvent[]
  writes: Array<{ runtimeId: string; data: string }>
  userData: string
  requests(): AiInputRequest[]
  results(): Array<Extract<AppEvent, { type: 'ai:input-result' }>>
}

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function harness(options: { approvalMs?: number; window?: boolean; write?: boolean } = {}): Harness {
  const userData = mkdtempSync(join(tmpdir(), 'hshell-writer-'))
  cleanups.push(() => rmSync(userData, { recursive: true, force: true }))
  const tap = new SessionTap()
  tap.register('rt-1', makeSession())
  tap.setWatched('rt-1', true)
  tap.setWritable('rt-1', true)
  tap.observeEvent({ type: 'ssh:status', runtimeId: 'rt-1', status: 'connected' })
  const events: AppEvent[] = []
  const writes: Array<{ runtimeId: string; data: string }> = []
  const writer = createSessionWriter({
    tap,
    userData,
    emit: (event) => events.push(event),
    write: (runtimeId, data) => {
      writes.push({ runtimeId, data })
      return options.write ?? true
    },
    windowAvailable: () => options.window ?? true,
    approvalMs: options.approvalMs ?? 1000
  })
  return {
    tap,
    writer,
    events,
    writes,
    userData,
    requests: () =>
      events
        .filter(
          (event): event is Extract<AppEvent, { type: 'ai:input-request' }> =>
            event.type === 'ai:input-request'
        )
        .map((event) => event.request),
    results: () =>
      events.filter(
        (event): event is Extract<AppEvent, { type: 'ai:input-result' }> =>
          event.type === 'ai:input-result'
      )
  }
}

describe('AI session writer', () => {
  it('writes only after approval, appends Enter, and marks the input as AI', async () => {
    const h = harness()
    const pending = h.writer.request({
      runtimeId: 'rt-1',
      text: 'uname -a',
      reason: 'check the kernel'
    })
    await Promise.resolve()

    expect(h.requests()).toHaveLength(1)
    expect(h.requests()[0].reason).toBe('check the kernel')
    expect(h.writes).toHaveLength(0)

    h.writer.decide(h.requests()[0].id, true)
    await expect(pending).resolves.toEqual({ status: 'sent' })

    expect(h.writes).toEqual([{ runtimeId: 'rt-1', data: 'uname -a\r' }])
    const input = h.tap.read('rt-1').chunks.find((chunk) => chunk.direction === 'in')
    expect(input?.source).toBe('ai')
    expect(input?.text).toContain('uname -a')
    expect(h.results()[0]?.status).toBe('sent')
  })

  it('announces the written text so the pane can tint the echo', async () => {
    const h = harness()
    const pending = h.writer.request({ runtimeId: 'rt-1', text: 'ls -la' })
    await Promise.resolve()
    h.writer.decide(h.requests()[0].id, true)
    await pending
    expect(h.events).toContainEqual({
      type: 'ai:input-sent',
      runtimeId: 'rt-1',
      text: 'ls -la\r'
    })
  })

  it('denies without writing when the user rejects', async () => {
    const h = harness()
    const pending = h.writer.request({ runtimeId: 'rt-1', text: 'reboot' })
    await Promise.resolve()
    h.writer.decide(h.requests()[0].id, false)
    await expect(pending).resolves.toEqual({ status: 'denied' })
    expect(h.writes).toHaveLength(0)
    expect(h.results()[0]?.status).toBe('denied')
  })

  it('times out and writes nothing', async () => {
    const h = harness({ approvalMs: 20 })
    const outcome = await h.writer.request({ runtimeId: 'rt-1', text: 'rm -rf /tmp/x' })
    expect(outcome.status).toBe('timeout')
    expect(h.writes).toHaveLength(0)
    expect(h.results()[0]?.status).toBe('timeout')
  })

  it('rejects control characters and empty input before prompting', async () => {
    const h = harness()
    const esc = await h.writer.request({ runtimeId: 'rt-1', text: 'ls\u001b[31m' })
    expect(esc.status).toBe('blocked')
    const empty = await h.writer.request({ runtimeId: 'rt-1', text: '   ' })
    expect(empty.status).toBe('blocked')
    expect(h.requests()).toHaveLength(0)
  })

  it('refuses sessions the user has not allowed input for', async () => {
    const h = harness()
    h.tap.setWritable('rt-1', false)
    const outcome = await h.writer.request({ runtimeId: 'rt-1', text: 'ls' })
    expect(outcome).toEqual({ status: 'blocked', message: '该会话未允许 AI 输入' })
    expect(h.requests()).toHaveLength(0)
  })

  it('allows only one pending approval at a time', async () => {
    const h = harness()
    const first = h.writer.request({ runtimeId: 'rt-1', text: 'ls' })
    await Promise.resolve()
    const second = await h.writer.request({ runtimeId: 'rt-1', text: 'pwd' })
    expect(second.status).toBe('blocked')
    h.writer.decide(h.requests()[0].id, false)
    await first
  })

  it('re-checks the grant at approval time', async () => {
    const h = harness()
    const pending = h.writer.request({ runtimeId: 'rt-1', text: 'ls' })
    await Promise.resolve()
    h.tap.setWritable('rt-1', false)
    h.writer.decide(h.requests()[0].id, true)
    await expect(pending).resolves.toEqual({
      status: 'blocked',
      message: '该会话未允许 AI 输入'
    })
    expect(h.writes).toHaveLength(0)
  })

  it('re-checks the connection at approval time', async () => {
    const h = harness()
    const pending = h.writer.request({ runtimeId: 'rt-1', text: 'ls' })
    await Promise.resolve()
    h.tap.observeEvent({ type: 'ssh:status', runtimeId: 'rt-1', status: 'closed' })
    h.writer.decide(h.requests()[0].id, true)
    await expect(pending).resolves.toEqual({
      status: 'blocked',
      message: '会话未连接'
    })
    expect(h.writes).toHaveLength(0)
  })

  it('sends text without Enter when submit is false', async () => {
    const h = harness()
    const pending = h.writer.request({ runtimeId: 'rt-1', text: 'echo hi', submit: false })
    await Promise.resolve()
    h.writer.decide(h.requests()[0].id, true)
    await pending
    expect(h.writes[0].data).toBe('echo hi')
  })

  it('cancels the prompt when the session disconnects', async () => {
    const h = harness()
    const pending = h.writer.request({ runtimeId: 'rt-1', text: 'ls' })
    await Promise.resolve()
    h.writer.cancel('rt-1')
    await expect(pending).resolves.toEqual({ status: 'blocked', message: '会话已断开' })
  })

  it('appends every attempt to the audit log', async () => {
    const h = harness()
    const pending = h.writer.request({ runtimeId: 'rt-1', text: 'id', reason: 'whoami' })
    await Promise.resolve()
    h.writer.decide(h.requests()[0].id, true)
    await pending
    const log = readFileSync(join(h.userData, 'ai-input.log'), 'utf8')
    expect(log).toContain('"status":"sent"')
    expect(log).toContain('"text":"id"')
    expect(log).toContain('"reason":"whoami"')
  })
})

describe('withEnter', () => {
  it('only appends Enter when submit is set and none is present', () => {
    expect(withEnter('ls', true)).toBe('ls\r')
    expect(withEnter('ls\n', true)).toBe('ls\n')
    expect(withEnter('ls', false)).toBe('ls')
  })
})
