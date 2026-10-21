#!/usr/bin/env node
/**
 * E2E for embedded local terminals (headless Electron + CDP).
 *
 *  1. The welcome screen's local-terminal button opens a real PTY tab.
 *  2. The tab bar's "+" opens another local shell instead of the session
 *     dialog, and titles are numbered.
 *  3. Commands typed into each tab run in the system shell.
 *
 * Requires a prior `npm run build` (it launches out/main/index.js).
 * Usage: npm run e2e:local
 *        node scripts/e2e-local-shell.mjs dist/linux-unpacked/hshell
 * The optional binary argument runs the same checks against a packaged build,
 * which also verifies that node-pty loads from app.asar.unpacked.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packaged = process.argv[2] ? resolve(process.argv[2]) : null
const electron = packaged ?? resolve(root, 'node_modules/electron/dist/electron')
const main = packaged ? null : resolve(root, 'out/main/index.js')
const profile = mkdtempSync(join(tmpdir(), 'hshell-local-'))
const debugPort = 9800 + (process.pid % 100)

let child = null
let log = ''
function startApp() {
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(
    electron,
    [
      ...(main ? [main] : []),
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
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* ignore */
  }
}

function fail(message, extra) {
  console.error(`LOCAL SHELL CHECK FAILED: ${message}`)
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2))
  if (consoleLog.length) console.error(`renderer console:\n${consoleLog.join('\n')}`)
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
const consoleLog = []

function recordConsole(method, params) {
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails
    consoleLog.push(
      `exception: ${details.exception?.description ?? details.text}`
    )
  } else if (method === 'Runtime.consoleAPICalled') {
    consoleLog.push(
      `${params.type}: ${params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`
    )
  }
  if (consoleLog.length > 40) consoleLog.shift()
}

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
    if (message.method) recordConsole(message.method, message.params ?? {})
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

/** Type into the focused xterm; InsertText produces one input event. */
async function typeText(text) {
  await send('Input.insertText', { text })
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

async function pressEnter() {
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
  const terminalText = () =>
    [...document.querySelectorAll('.tab-view.active .xterm-rows > div')]
      .map((row) => row.textContent ?? '')
      .join('\\n')
  const focusTerminal = () =>
    document.querySelector('.tab-view.active .xterm-helper-textarea')?.focus()
  const tabTitles = () =>
    [...document.querySelectorAll('.tab .tab-title')].map((node) => node.textContent ?? '')
  const activeStatus = () =>
    document.querySelector('.statusbar .status-section')?.textContent ?? ''
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
  await send('Page.enable')

  // 1. Welcome screen -> local terminal.
  const first = await evaluate(
    ui(`
      await waitFor(() => document.querySelector('.welcome'), 'welcome screen')
      const findButton = () =>
        [...document.querySelectorAll('.welcome-actions .btn')]
          .find((item) => /本地终端|Local terminal/.test(item.textContent ?? ''))
      if (!findButton()) {
        throw new Error('local terminal button missing: ' +
          [...document.querySelectorAll('.welcome-actions .btn')]
            .map((item) => item.textContent).join(' | '))
      }
      // The welcome screen can re-render while sessions load, so re-query the
      // button each attempt rather than holding a detached node.
      for (let attempt = 0; attempt < 20; attempt++) {
        if (document.querySelector('.tab-view.active .xterm-helper-textarea')) break
        findButton()?.click()
        await sleep(250)
      }
      try {
        await waitFor(() => document.querySelector('.tab-view.active .xterm-helper-textarea'), 'terminal')
      } catch (error) {
        throw new Error(error.message + ' | ' + JSON.stringify({
          tabs: tabTitles(),
          view: !!document.querySelector('.tab-view.active'),
          pane: !!document.querySelector('.terminal-pane'),
          error: document.querySelector('.tab-view.active .terminal-error')?.textContent ?? '',
          status: activeStatus()
        }))
      }
      await sleep(600)
      focusTerminal()
      return {
        titles: tabTitles(),
        status: activeStatus(),
        toolbarTitle: document.querySelector('.tab-add')?.title ?? ''
      }
    `)
  )
  if (first.titles.length !== 1 || !/本地终端|Local shell/.test(first.titles[0])) {
    fail('the welcome button did not open a local terminal tab', first)
  }
  if (!first.toolbarTitle.includes('本地终端')) {
    fail('the tab bar + is not labelled as a local terminal', first)
  }
  console.log('WELCOME_LOCAL_SHELL_OK')

  await typeText("printf 'LOCAL_E2E_%s\\n' OK")
  await pressEnter()
  const firstOutput = await evaluate(
    ui(`
      await waitFor(() => terminalText().includes('LOCAL_E2E_OK'), 'first local shell output')
      return { text: terminalText(), status: activeStatus() }
    `)
  )
  if (!firstOutput.text.includes('LOCAL_E2E_OK')) fail('local shell did not run the command', firstOutput)
  if (!/已连接|Connected/.test(firstOutput.status)) {
    fail('status bar does not report the local shell as connected', firstOutput)
  }
  console.log('LOCAL_SHELL_COMMAND_OK')

  // The tty echoes a delivered Esc as ^[, proving vi/vim can leave insert mode.
  await typeText('cat -v')
  await pressEnter()
  await typeText('abc')
  await pressKey('Escape', 'Escape', 27)
  await typeText('def')
  await pressEnter()
  const escaped = await evaluate(
    ui(`
      await waitFor(() => terminalText().includes('abc^[def'), 'Escape byte')
      return terminalText()
    `)
  )
  if (!escaped.includes('abc^[def')) fail('Escape did not reach the shell', { escaped })
  await pressKey('c', 'KeyC', 67, 2) // Ctrl+C leaves cat
  await evaluate(ui(`await sleep(300); return true`))
  console.log('ESCAPE_KEY_OK')

  // 2. The tab bar + opens a second local shell, not the session dialog.
  const second = await evaluate(
    ui(`
      document.querySelector('.tab-add').click()
      await waitFor(() => tabTitles().length === 2, 'second tab')
      await waitFor(() => document.querySelector('.tab.active .tab-title')?.textContent, 'active tab')
      await sleep(600)
      focusTerminal()
      return {
        titles: tabTitles(),
        modal: document.querySelector('.modal .modal-title')?.textContent ?? '',
        activeTitle: document.querySelector('.tab.active .tab-title')?.textContent ?? ''
      }
    `)
  )
  if (second.modal) fail('the tab + opened the session dialog', second)
  if (second.titles.length !== 2) fail('the tab + did not open a second tab', second)
  if (!/本地终端 2|Local shell 2/.test(second.activeTitle)) {
    fail('the second local shell was not numbered', second)
  }
  console.log('TAB_PLUS_LOCAL_SHELL_OK')

  await typeText("printf 'SECOND_TAB_%s\\n' OK")
  await pressEnter()
  const secondOutput = await evaluate(
    ui(`
      await waitFor(() => terminalText().includes('SECOND_TAB_OK'), 'second local shell output')
      return terminalText()
    `)
  )
  if (!secondOutput.includes('SECOND_TAB_OK')) {
    fail('the second local shell did not run the command', { secondOutput })
  }
  console.log('SECOND_LOCAL_SHELL_COMMAND_OK')

  // Exit cleanly so no child shells are left behind if the app is killed.
  await typeText('exit')
  await pressEnter()
  await evaluate(ui(`await sleep(300); return true`))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('/tmp/hshell-local-shell.png', Buffer.from(shot.data, 'base64'))

  console.log('LOCAL SHELL CHECK PASSED')
  cleanup()
  process.exit(0)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
