#!/usr/bin/env node
/**
 * E2E for the inline password prompt (headless Electron + CDP).
 *
 *  1. A session with a wrong password connects to an SSH server that rejects
 *     password auth. Instead of the failure card, the terminal asks for the
 *     password.
 *  2. Typed characters are masked with `*`; Enter retries authentication and
 *     the accepted password logs in.
 *  3. The accepted password is saved encrypted: sessions.json only gains
 *     `savePassword: true`, credentials.json holds ciphertext, and neither file
 *     contains the plaintext password.
 *
 * Requires a prior `npm run build` (it launches out/main/index.js).
 * Usage: npm run e2e:password
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = resolve(root, 'node_modules/electron/dist/electron')
const main = resolve(root, 'out/main/index.js')
const profile = mkdtempSync(join(tmpdir(), 'hshell-password-'))
const debugPort = 9800 + (process.pid % 100)
const sshPort = 2800 + (process.pid % 100)
const CORRECT = 'correct-horse-battery'
const WRONG = 'definitely-wrong'

// ------------------------------------------------------------------ SSH server
const { private: hostKey } = utils.generateKeyPairSync('rsa', { bits: 2048 })
const server = new Server({ hostKeys: [hostKey] }, (connection) => {
  connection.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.password === CORRECT) ctx.accept()
    else ctx.reject(['password'])
  })
  connection.on('session', (accept) => {
    const session = accept()
    session.on('pty', (acceptPty) => acceptPty?.())
    session.on('shell', (acceptShell) => {
      const stream = acceptShell()
      stream?.write('SHELL READY\r\n')
    })
  })
})
await new Promise((done, reject) => {
  server.once('error', reject)
  server.listen(sshPort, '127.0.0.1', done)
})
console.log('PASSWORD_SSHD_READY')

// ------------------------------------------------------------------- session
const now = Date.now()
const session = {
  id: 'pw-session',
  name: '密码重试',
  folderId: null,
  host: '127.0.0.1',
  port: sshPort,
  username: 'tester',
  auth: { method: 'password', password: WRONG },
  terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
  createdAt: now,
  updatedAt: now
}
writeFileSync(
  join(profile, 'sessions.json'),
  JSON.stringify({ schemaVersion: 2, data: [session] })
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
    server.close()
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
  console.error(`PASSWORD PROMPT CHECK FAILED: ${message}`)
  if (extra) console.error(JSON.stringify(extra, null, 2))
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

async function typeText(text) {
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

function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(profile, name), 'utf8'))
  } catch {
    return null
  }
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
    const deadline = Date.now() + 5000
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
  const terminalText = () =>
    [...document.querySelectorAll('.tab-view.active .xterm-rows > div')]
      .map((row) => row.textContent ?? '')
      .join('\\n')
  ${body}
})()`

try {
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

  const prompted = await evaluate(
    ui(`
      const row = await waitFor(
        () => document.querySelector('.session-row[data-session-id="pw-session"]'),
        'session row'
      )
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await acceptHostKey()
      const text = await waitFor(
        () => {
          const current = terminalText()
          return /密码认证失败/.test(current) ? current : null
        },
        'inline password prompt'
      )
      const focused = document.activeElement?.classList.contains('xterm-helper-textarea')
      return {
        text,
        focused,
        failedCard: !!document.querySelector('.tab-view.active .terminal-error')
      }
    `)
  )
  if (!/密码：/.test(prompted.text)) fail('password prompt missing', prompted)
  if (prompted.failedCard) fail('failure card shown instead of the prompt', prompted)

  // The password must be masked while typing.
  await evaluate(
    "document.querySelector('.tab-view.active .xterm-helper-textarea')?.focus(); true"
  )
  for (const char of CORRECT) {
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      unmodifiedText: char,
      key: char
    })
  }
  const masked = await evaluate(
    ui(`
      const text = await waitFor(
        () => {
          const current = terminalText()
          return current.includes('${'*'.repeat(CORRECT.length)}') ? current : null
        },
        'masked input'
      )
      return { shown: /\\*{${CORRECT.length}}/.test(text), plaintext: text.includes('${CORRECT}') }
    `)
  )
  if (!masked.shown) fail('typed password was not masked', masked)
  if (masked.plaintext) fail('typed password was echoed in clear text', masked)

  // Enter submits: the server accepts it and opens a shell.
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

  const connected = await evaluate(
    ui(`
      await waitFor(
        () => terminalText().includes('SHELL READY'),
        'shell after password retry'
      )
      const text = terminalText()
      return { text, failedCard: !!document.querySelector('.tab-view.active .terminal-error') }
    `)
  )
  if (connected.failedCard) fail('failure card shown after retry', connected)

  // Persisted metadata + encrypted credential.
  let sessions = null
  let credentials = null
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    sessions = readJson('sessions.json')
    credentials = readJson('credentials.json')
    if (sessions?.data?.[0]?.auth?.savePassword === true && credentials?.data?.items) break
    await new Promise((done) => setTimeout(done, 100))
  }
  const savedAuth = sessions?.data?.[0]?.auth ?? {}
  if (savedAuth.savePassword !== true) fail('savePassword was not set', { sessions })
  if (!credentials?.data?.items?.['session:pw-session']) {
    fail('credential entry missing', { credentials })
  }
  const sessionsRaw = readFileSync(join(profile, 'sessions.json'), 'utf8')
  const credentialsRaw = readFileSync(join(profile, 'credentials.json'), 'utf8')
  if (sessionsRaw.includes(CORRECT) || credentialsRaw.includes(CORRECT)) {
    fail('plaintext password found on disk')
  }
  if (sessionsRaw.includes(WRONG)) fail('stale plaintext password found in sessions.json')

  await send('Page.enable')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('/tmp/hshell-password-prompt.png', Buffer.from(shot.data, 'base64'))

  console.log(
    JSON.stringify(
      {
        ok: true,
        prompted: prompted.text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.includes('HShell') || line.includes('密码')),
        masked: masked.shown,
        credentialScheme: credentials.data.items['session:pw-session'].scheme,
        savePassword: savedAuth.savePassword
      },
      null,
      2
    )
  )
  cleanup()
  process.exit(0)
} catch (error) {
  fail(error.message)
}
