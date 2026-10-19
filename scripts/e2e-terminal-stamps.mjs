#!/usr/bin/env node
/**
 * E2E for the terminal timestamp gutter (headless Electron + CDP).
 *
 *  1. Open a session with `terminal.showTimestamps` enabled.
 *  2. Its pane reserves a gutter left of xterm and shows `HH:mm:ss` stamps for
 *     output lines; the stamps are outside the terminal buffer.
 *  3. Typing a command adds a stamp for the newly output line.
 *  4. A session without the option gets no gutter.
 *
 * Requires a prior `npm run build` (it launches out/main/index.js).
 * Usage: npm run e2e:timestamps
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = resolve(root, 'node_modules/electron/dist/electron')
const main = resolve(root, 'out/main/index.js')
const mockServer = resolve(root, 'scripts/mock-sshd.mjs')
const profile = mkdtempSync(join(tmpdir(), 'hshell-stamps-'))
const debugPort = 9700 + (process.pid % 100)
const mockPort = 2700 + (process.pid % 100)

const mock = spawn(process.execPath, [mockServer], {
  env: { ...process.env, MOCK_SSHD_PORT: String(mockPort) },
  stdio: ['ignore', 'pipe', 'pipe']
})
let mockLog = ''
mock.stdout.on('data', (chunk) => (mockLog += chunk))
mock.stderr.on('data', (chunk) => (mockLog += chunk))

const now = Date.now()
const session = (id, name, showTimestamps) => ({
  id,
  name,
  folderId: null,
  host: '127.0.0.1',
  port: mockPort,
  username: 'demo',
  auth: { method: 'password', password: 'x' },
  terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14, showTimestamps },
  createdAt: now,
  updatedAt: now
})
writeFileSync(
  join(profile, 'sessions.json'),
  JSON.stringify({
    schemaVersion: 2,
    data: [session('stamped', '带时间戳', true), session('plain', '无时间戳', false)]
  })
)
writeFileSync(join(profile, 'folders.json'), JSON.stringify({ schemaVersion: 2, data: [] }))

let child = null
let log = ''
function startApp() {
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(
    electron,
    [
      main,
      '--headless',
      '--ozone-platform=headless',
      `--remote-debugging-port=${debugPort}`,
      '--no-sandbox',
      `--user-data-dir=${profile}`
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env }
  )
  child.stdout.on('data', (chunk) => (log += chunk))
  child.stderr.on('data', (chunk) => (log += chunk))
}

function cleanup() {
  try {
    child?.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  try {
    mock.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* ignore */
  }
}

function fail(message, extra) {
  console.error(`TERMINAL STAMPS CHECK FAILED: ${message}`)
  if (extra) console.error(JSON.stringify(extra, null, 2))
  console.error(mockLog.trim())
  if (log.trim()) console.error(log.trim().split('\n').slice(-25).join('\n'))
  cleanup()
  process.exit(1)
}

async function waitForTarget(port) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (page) return page
    } catch {
      /* not listening yet */
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  return null
}

let socket
let messageId = 1
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolvePromise, reject) => {
    const id = messageId++
    pending.set(id, { resolvePromise, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

function attach(ws) {
  socket = ws
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolvePromise(message.result)
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? 'evaluation failed'
    throw new Error(description)
  }
  return result.result?.value
}

async function typeLine(text) {
  await evaluate(
    "document.querySelector('.tab-view.active .xterm-helper-textarea')?.focus(); true"
  )
  for (const char of text) {
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      unmodifiedText: char,
      key: char
    })
  }
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    text: '\r',
    unmodifiedText: '\r'
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
}

const ui = (body) => `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  const waitFor = async (fn, label, timeout = 20000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = fn()
      if (value) return value
      await sleep(100)
    }
    throw new Error('timeout waiting for ' + label)
  }
  const acceptHostKey = async () => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const button = [...document.querySelectorAll('.modal .btn-primary')].find((item) => /接受|Accept/.test(item.textContent))
      if (button) {
        button.click()
        await sleep(200)
        return true
      }
      await sleep(100)
    }
    return false
  }
  const openSession = async (id) => {
    const row = await waitFor(
      () => document.querySelector('.session-row[data-session-id="' + id + '"]'),
      id + ' session row'
    )
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  }
  const stamps = () =>
    [...document.querySelectorAll('.tab-view.active .terminal-stamp')]
      .map((item) => item.textContent.trim())
      .filter(Boolean)
  ${body}
})()`

try {
  await new Promise((done) => setTimeout(done, 600))
  if (!mockLog.includes('MOCK_SSHD_READY')) fail('mock sshd did not start', { mockLog })

  startApp()
  const page = await waitForTarget(debugPort)
  if (!page) fail('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    ws.addEventListener('open', resolvePromise, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true })
  })
  attach(ws)
  await send('Runtime.enable')

  const beforeTyping = await evaluate(
    ui(`
      await openSession('stamped')
      await acceptHostKey()
      await waitFor(
        () => document.querySelector('.statusbar')?.textContent?.includes('已连接'),
        'stamped connection'
      )
      const initial = await waitFor(() => {
        const values = stamps()
        return values.length ? values : null
      }, 'initial timestamp')

      const pane = await waitFor(
        () => document.querySelector('.tab-view.active .pane-cell[data-session-id="stamped"]'),
        'stamped pane'
      )
      const gutter = pane.querySelector('.terminal-stamps')
      const container = pane.querySelector('.terminal-container')
      const terminal = pane.querySelector('.xterm')
      return {
        initial,
        count: initial.length,
        hasGutter: !!gutter,
        gutterWidth: gutter ? getComputedStyle(gutter).width : null,
        shifted: !!container?.classList.contains('with-stamps'),
        gutterOutsideTerminal: !!gutter && !terminal?.contains(gutter),
        allWellFormed: initial.every((value) => /^\\d{2}:\\d{2}:\\d{2}$/.test(value))
      }
    `)
  )

  if (!beforeTyping.hasGutter) fail('timestamp gutter missing', beforeTyping)
  if (!beforeTyping.shifted) fail('terminal was not shifted right', beforeTyping)
  if (!beforeTyping.gutterOutsideTerminal) fail('stamps are inside the terminal', beforeTyping)
  if (!beforeTyping.allWellFormed) fail('stamps are not HH:mm:ss', beforeTyping)

  await typeLine('echo hshell-stamps')
  const afterTyping = await evaluate(
    ui(`
      const before = ${beforeTyping.count}
      const values = await waitFor(
        () => {
          const current = stamps()
          return current.length > before ? current : null
        },
        'timestamp for the newly output line'
      )
      return { values, added: values.length - before }
    `)
  )
  if (afterTyping.added < 1) fail('typing did not add a stamp', afterTyping)

  await send('Page.enable')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('/tmp/hshell-stamps.png', Buffer.from(shot.data, 'base64'))

  const plain = await evaluate(
    ui(`
      await openSession('plain')
      await waitFor(
        () => document.querySelector('.tab-view.active .pane-cell[data-session-id="plain"]'),
        'plain pane'
      )
      await sleep(500)
      const pane = document.querySelector('.tab-view.active .pane-cell[data-session-id="plain"]')
      return {
        hasGutter: !!pane?.querySelector('.terminal-stamps'),
        shifted: !!pane?.querySelector('.terminal-container.with-stamps'),
        stampedTabs: document.querySelectorAll('.tab-view.active .terminal-stamp').length
      }
    `)
  )
  if (plain.hasGutter || plain.shifted || plain.stampedTabs) {
    fail('plain session unexpectedly has timestamps', plain)
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        initialStamps: beforeTyping.initial,
        afterTypingStamps: afterTyping.values,
        gutterWidth: beforeTyping.gutterWidth,
        plain
      },
      null,
      2
    )
  )
  cleanup()
} catch (error) {
  fail(error.message)
}
