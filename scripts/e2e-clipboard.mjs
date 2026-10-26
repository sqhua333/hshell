#!/usr/bin/env node
/**
 * E2E for terminal copy/paste (headless Electron + CDP).
 *
 *  1. Shift+right-click opens the menu; Copy is disabled without a selection.
 *  2. Plain right-click pastes the clipboard into the shell without a menu.
 *  3. Ctrl+C with a selection copies without sending 0x03 to the shell;
 *     Ctrl+C without a selection sends SIGINT.
 *  4. Ctrl+V on multi-line text asks for confirmation and sends nothing until
 *     the user confirms; Ctrl+Shift+V pastes single-line text directly.
 *
 * Requires a prior `npm run build` (it launches out/main/index.js).
 * Usage: npm run e2e:clipboard
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = resolve(root, 'node_modules/electron/dist/electron')
const main = resolve(root, 'out/main/index.js')
const profile = mkdtempSync(join(tmpdir(), 'hshell-clipboard-'))
const debugPort = 9700 + (process.pid % 100)
const sshPort = 2700 + (process.pid % 100)
const PASSWORD = 'clipboard-test'
const TARGET = 'COPY-TARGET-42'

// ------------------------------------------------------------------ SSH server
const { private: hostKey } = utils.generateKeyPairSync('rsa', { bits: 2048 })
let received = ''
const server = new Server({ hostKeys: [hostKey] }, (connection) => {
  // This test is about clipboard behavior, so accept whatever method the
  // client offers (the storage layer strips plaintext passwords on load).
  connection.on('authentication', (ctx) => ctx.accept())
  connection.on('session', (accept) => {
    const session = accept()
    session.on('pty', (acceptPty) => acceptPty?.())
    session.on('shell', (acceptShell) => {
      const stream = acceptShell()
      stream?.on('data', (chunk) => {
        received += chunk.toString('utf8')
      })
      stream?.write(`${TARGET}\r\n$ `)
    })
  })
})
await new Promise((done, reject) => {
  server.once('error', reject)
  server.listen(sshPort, '127.0.0.1', done)
})
console.log('CLIPBOARD_SSHD_READY')

// ------------------------------------------------------------------- session
const now = Date.now()
const session = {
  id: 'clip-session',
  name: '剪贴板测试',
  folderId: null,
  host: '127.0.0.1',
  port: sshPort,
  username: 'tester',
  auth: { method: 'password', password: PASSWORD },
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
  console.error(`CLIPBOARD CHECK FAILED: ${message}`)
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2))
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

async function pressKey(key, code, virtualKeyCode, modifiers = 0) {
  const base = {
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function waitForReceived(fragment, label, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (received.includes(fragment)) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`timeout waiting for the shell to receive ${label}`)
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
  const terminalText = () =>
    [...document.querySelectorAll('.tab-view.active .xterm-rows > div')]
      .map((row) => row.textContent ?? '')
      .join('\\n')
  const focusTerminal = () =>
    document.querySelector('.tab-view.active .xterm-helper-textarea')?.focus()
  const contextMenu = (x = 40, y = 40, shiftKey = false) => {
    const pane = document.querySelector('.tab-view.active .terminal-pane')
    pane.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      shiftKey
    }))
  }
  const menuItem = (label) =>
    [...document.querySelectorAll('.context-menu .context-item')]
      .find((item) => item.textContent?.includes(label))
  const hasCopyToast = () =>
    [...document.querySelectorAll('.toast')].some((toast) => /已复制|Copied/.test(toast.textContent ?? ''))
  const hasSelection = () =>
    document.querySelectorAll('.tab-view.active .xterm-selection div').length > 0
  const acceptHostKey = async () => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const button = [...document.querySelectorAll('.modal .btn-primary')]
        .find((item) => /接受|Accept/.test(item.textContent))
      if (button) {
        button.click()
        await sleep(200)
        return true
      }
      await sleep(100)
    }
    return false
  }
  const selectAll = async () => {
    contextMenu(40, 40, true)
    await waitFor(() => document.querySelector('.context-menu'), 'context menu')
    const item = menuItem('全选') ?? menuItem('Select all')
    if (!item) throw new Error('select-all menu item missing')
    item.click()
    await waitFor(() => hasSelection(), 'terminal selection')
  }
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

  // Open the session and wait for the shell.
  const opened = await evaluate(
    ui(`
      const row = await waitFor(
        () => document.querySelector('.session-row[data-session-id="clip-session"]'),
        'session row'
      )
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const hostKey = await acceptHostKey()
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && !terminalText().includes('${TARGET}')) {
        await sleep(200)
      }
      return {
        hostKey,
        text: terminalText(),
        error: document.querySelector('.tab-view.active .terminal-error')?.textContent ?? '',
        toasts: [...document.querySelectorAll('.toast')].map((item) => item.textContent),
        modal: document.querySelector('.modal-title')?.textContent ?? ''
      }
    `)
  )
  if (!opened.text.includes(TARGET)) fail('shell output missing', opened)

  // 1. No selection: Shift+right-click opens the menu with Copy disabled.
  const menuState = await evaluate(
    ui(`
      contextMenu(40, 40, true)
      const menu = await waitFor(() => document.querySelector('.context-menu'), 'context menu')
      const copy = menuItem('复制') ?? menuItem('Copy')
      const state = {
        open: Boolean(menu),
        copyDisabled: Boolean(copy?.disabled),
        items: [...menu.querySelectorAll('.context-item')].map((item) => item.textContent)
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await waitFor(() => !document.querySelector('.context-menu'), 'menu closed')
      return state
    `)
  )
  if (!menuState.open) fail('Shift+right-click did not open the menu', menuState)
  if (!menuState.copyDisabled) fail('Copy is enabled without a selection', menuState)
  console.log('MENU_WITHOUT_SELECTION_OK')

  // 2. Plain right-click pastes the clipboard; no menu appears.
  const rightClickPaste = await evaluate(
    ui(`
      await window.hshell.clipboard.writeText('right-click-paste-42')
      contextMenu(60, 60)
      await sleep(400)
      return { menuOpen: Boolean(document.querySelector('.context-menu')) }
    `)
  )
  if (rightClickPaste.menuOpen) fail('plain right-click opened the menu', rightClickPaste)
  await waitForReceived('right-click-paste-42', 'right-click paste')
  console.log('RIGHT_CLICK_PASTE_OK')

  // 3a. Ctrl+C with a selection copies but does not send 0x03.
  const keyboardCopy = await evaluate(
    ui(`
      await window.hshell.clipboard.writeText('clipboard-sentinel-keyboard')
      await selectAll()
      focusTerminal()
      return hasSelection()
    `)
  )
  if (!keyboardCopy) fail('could not create a selection for Ctrl+C')
  const beforeCopy = received.length
  await pressKey('c', 'KeyC', 67, 2)
  const copied = await evaluate(
    ui(`
      await waitFor(() => hasCopyToast(), 'Ctrl+C copy toast')
      await waitFor(() => !hasSelection(), 'selection cleared after Ctrl+C')
      return await window.hshell.clipboard.readText()
    `)
  )
  if (!copied.includes(TARGET) || copied.includes('clipboard-sentinel-keyboard')) {
    fail('Ctrl+C did not copy the selection', copied)
  }
  await new Promise((done) => setTimeout(done, 400))
  if (received.slice(beforeCopy).includes('\x03')) {
    fail('Ctrl+C copied but also sent SIGINT')
  }
  console.log('CTRL_C_COPY_OK')

  // 3b. Ctrl+C without a selection sends SIGINT.
  await evaluate(ui(`focusTerminal(); return true`))
  const beforeInterrupt = received.length
  await pressKey('c', 'KeyC', 67, 2)
  await waitForReceived('\x03', 'SIGINT')
  const afterInterrupt = received.indexOf('\x03', beforeInterrupt)
  if (afterInterrupt < 0) fail('Ctrl+C without a selection did not send 0x03', { received })
  console.log('CTRL_C_SIGINT_OK')

  // 4. Multi-line paste asks first and sends nothing until confirmed.
  await evaluate(
    ui(`
      await window.hshell.clipboard.writeText('echo one\\necho two')
      focusTerminal()
      return true
    `)
  )
  await pressKey('v', 'KeyV', 86, 2)
  const dialog = await evaluate(
    ui(`
      const title = await waitFor(
        () => {
          const node = document.querySelector('.modal .modal-title')
          return node && /粘贴多行文本|Paste multiple lines/.test(node.textContent ?? '')
            ? node.textContent
            : null
        },
        'multi-line paste dialog'
      )
      return {
        title,
        preview: document.querySelector('.paste-preview')?.textContent ?? '',
        primary: [...document.querySelectorAll('.modal .btn-primary')]
          .map((button) => button.textContent)
      }
    `)
  )
  if (!dialog.preview.includes('echo one') || !dialog.preview.includes('echo two')) {
    fail('paste dialog preview is incomplete', dialog)
  }
  await send('Page.enable')
  const dialogShot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('/tmp/hshell-paste-confirm.png', Buffer.from(dialogShot.data, 'base64'))
  await new Promise((done) => setTimeout(done, 400))
  if (received.includes('echo one')) fail('multi-line paste was sent before confirmation')
  console.log('MULTILINE_PASTE_HELD')

  await evaluate(
    ui(`
      const button = [...document.querySelectorAll('.modal .btn-primary')]
        .find((item) => /粘贴|Paste/.test(item.textContent ?? ''))
      button.click()
      return true
    `)
  )
  await waitForReceived('echo one', 'first pasted line')
  await waitForReceived('echo two', 'second pasted line')
  const dialogClosed = await evaluate(ui(`return !document.querySelector('.paste-preview')`))
  if (!dialogClosed) fail('paste dialog did not close after confirming')
  console.log('MULTILINE_PASTE_CONFIRMED')

  // 5. Single-line paste through Ctrl+Shift+V needs no confirmation.
  await evaluate(
    ui(`
      await window.hshell.clipboard.writeText('echo single-line')
      focusTerminal()
      return true
    `)
  )
  await pressKey('v', 'KeyV', 86, 10) // Ctrl (2) + Shift (8)
  await waitForReceived('echo single-line', 'single-line paste')
  const noDialog = await evaluate(ui(`return !document.querySelector('.paste-preview')`))
  if (!noDialog) fail('single-line paste unexpectedly asked for confirmation')
  console.log('SINGLE_LINE_PASTE_OK')

  await send('Page.enable')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('/tmp/hshell-clipboard.png', Buffer.from(shot.data, 'base64'))

  console.log('CLIPBOARD CHECK PASSED')
  cleanup()
  process.exit(0)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
