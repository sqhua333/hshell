import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import {
  generateReplayScript,
  Recorder,
  replayFileName
} from '../../src/renderer/src/lib/recorder'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'prod web',
    folderId: null,
    host: 'example.com',
    port: 22,
    username: 'alice',
    auth: { method: 'agent' },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('Recorder', () => {
  it('captures input and output with relative timestamps', () => {
    const recorder = new Recorder()
    recorder.start('rt-1', makeSession(), 1_000)
    recorder.recordInput('rt-1', 'ls\r', 1_100)
    recorder.recordOutput('rt-1', 'file.txt\r\n', 1_200)
    recorder.recordInput('other', 'ignored', 1_300)
    const recording = recorder.stop(1_400)

    expect(recording).not.toBeNull()
    expect(recording!.events).toEqual([
      { at: 100, direction: 'in', data: 'ls\r' },
      { at: 200, direction: 'out', data: 'file.txt\r\n' }
    ])
    expect(recording!.stoppedAt).toBe(1_400)
    expect(recorder.active).toBe(false)
  })

  it('ignores events from other runtimes and after stop', () => {
    const recorder = new Recorder()
    expect(recorder.recordInput('rt-1', 'x')).toBeUndefined()
    recorder.start('rt-1', makeSession())
    recorder.recordInput('rt-2', 'nope')
    recorder.stop()
    recorder.recordOutput('rt-1', 'late')
    expect(recorder.runtimeId).toBeNull()
  })

  it('does not retain a stale recording after restart', () => {
    const recorder = new Recorder()
    recorder.start('rt-1', makeSession())
    recorder.recordInput('rt-1', 'one')
    recorder.start('rt-1', makeSession())
    recorder.recordInput('rt-1', 'two')
    expect(recorder.stop()!.events.map((event) => event.data)).toEqual(['two'])
  })
})

describe('generateReplayScript', () => {
  function recordingFor(session: Session, events = [
    { at: 200, direction: 'out' as const, data: '\u001b[32mready\u001b[0m\r\n$ ' },
    { at: 400, direction: 'in' as const, data: 'ls\r' },
    { at: 900, direction: 'out' as const, data: 'a.txt b.txt\r\n' },
    { at: 1_200, direction: 'in' as const, data: 'exit\r' }
  ]) {
    return {
      runtimeId: 'rt-1',
      session,
      startedAt: 1_000,
      stoppedAt: 2_000,
      events,
      truncated: false
    }
  }

  it('produces a valid-looking SSH replay script without credentials', () => {
    const script = generateReplayScript(recordingFor(makeSession()))
    expect(script).toContain('import { Client } from "ssh2"')
    expect(script).toContain('host: process.env.HSHELL_HOST || "example.com"')
    expect(script).toContain('username: process.env.HSHELL_USERNAME || "alice"')
    expect(script).toContain('const steps = [')
    expect(script).toContain('// output: ready')
    expect(script).toContain('{ wait: 400, data: "ls\\r" },')
    expect(script).toContain('{ wait: 800, data: "exit\\r" },')
    expect(script).toContain('HSHELL_KEY')
    expect(script).not.toMatch(/password:\s*["']/)
    expect(script).not.toContain('auth.method')
  })

  it('emits a serialport replay for serial sessions', () => {
    const session = makeSession({
      connectionType: 'serial',
      serial: {
        path: '/dev/ttyUSB0',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none'
      }
    })
    const script = generateReplayScript(
      recordingFor(session, [{ at: 100, direction: 'in', data: 'help\r' }])
    )
    expect(script).toContain('import { SerialPort } from "serialport"')
    expect(script).toContain('path: "/dev/ttyUSB0"')
    expect(script).toContain('baudRate: 115200')
    expect(script).toContain('autoOpen: false')
    expect(script).not.toContain('ssh2')
  })

  it('emits a local PTY replay for local shells', () => {
    const script = generateReplayScript(
      recordingFor(
        makeSession({ name: '本地终端', connectionType: 'local' }),
        [{ at: 100, direction: 'in', data: 'pwd\r' }]
      )
    )
    expect(script).toContain('import * as pty from "node-pty"')
    expect(script).toContain('term.write(step.data)')
    expect(script).toContain('Session: 本地终端 (本地终端)')
    expect(script).not.toContain('ssh2')
    expect(script).not.toContain('SerialPort')
  })

  it('generates syntactically valid ES modules', () => {
    const ssh = generateReplayScript(recordingFor(makeSession()))
    const serial = generateReplayScript(
      recordingFor(
        makeSession({
          connectionType: 'serial',
          serial: {
            path: '/dev/ttyUSB0',
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            flowControl: 'none'
          }
        })
      )
    )
    const local = generateReplayScript(
      recordingFor(makeSession({ name: '本地终端', connectionType: 'local' }))
    )
    const dir = mkdtempSync(join(tmpdir(), 'hshell-script-'))
    try {
      for (const [index, script] of [ssh, serial, local].entries()) {
        const file = join(dir, `replay-${index}.mjs`)
        writeFileSync(file, script)
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('notes truncation and caps long waits', () => {
    const script = generateReplayScript({
      runtimeId: 'rt-1',
      session: makeSession(),
      startedAt: 0,
      stoppedAt: 1,
      events: [
        { at: 1_000, direction: 'in', data: 'a\r' },
        { at: 100_000, direction: 'in', data: 'b\r' }
      ],
      truncated: true
    })
    expect(script).toContain('hit its size limit')
    expect(script).toContain('{ wait: 1000, data: "a\\r" },')
    expect(script).toContain('{ wait: 5000, data: "b\\r" },')
  })
})

describe('replayFileName', () => {
  it('sanitizes session names and keeps an mjs extension', () => {
    const name = replayFileName(makeSession({ name: 'prod/web: 主机 * 1' }))
    expect(name).toMatch(/^hshell-prod-web-主机-1-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.mjs$/)
  })

  it('falls back when the name has no usable characters', () => {
    expect(replayFileName(makeSession({ name: '///' }))).toMatch(/^hshell-session-/)
  })
})
