#!/usr/bin/env node
/**
 * E2E for startup theme handling (headless Electron + CDP).
 *
 *  1. The built index.html applies `data-theme` from localStorage in an inline
 *     head script, before the React bundle, so a dark-theme user never sees a
 *     light flash while the app boots.
 *  2. The renderer mirrors the theme to `userData/ui-prefs.json` (the main
 *     process paints the window background from it).
 *  3. Toggling the theme updates the DOM, localStorage and ui-prefs.json.
 *  4. After a restart the window opens dark from the first frame.
 *
 * Requires a prior `npm run build` (it launches out/main/index.js).
 * Usage: npm run e2e:startup-theme
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = resolve(root, 'node_modules/electron/dist/electron')
const main = resolve(root, 'out/main/index.js')
const builtHtml = resolve(root, 'out/renderer/index.html')
const profile = mkdtempSync(join(tmpdir(), 'hshell-theme-'))
const debugPort = 9900 + (process.pid % 100)

const LIGHT_BG = 'rgb(238, 241, 245)'
const DARK_BG = 'rgb(23, 27, 34)'

function checkStaticBoot() {
  const html = readFileSync(builtHtml, 'utf8')
  const bootstrap = html.indexOf("getItem('hshell.uiTheme')")
  const bundle = html.indexOf('type="module"')
  if (bootstrap < 0) throw new Error('index.html has no theme bootstrap')
  if (bundle < 0) throw new Error('index.html has no module bundle')
  if (bootstrap > bundle) throw new Error('theme bootstrap runs after the bundle')
  if (!/html\[data-theme='dark'\][^{]*\{[^}]*#171b22/.test(html)) {
    throw new Error('dark boot styles are missing')
  }
}

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

async function stopApp() {
  if (!child) return
  const exited = new Promise((done) => child.once('exit', done))
  try {
    child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))])
  child = null
  log = ''
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
  console.error(`STARTUP THEME CHECK FAILED: ${message}`)
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

async function evaluateAfterReload(expression) {
  let lastError = null
  for (let i = 0; i < 100; i += 1) {
    try {
      return await evaluate(expression)
    } catch (error) {
      lastError = error
      await new Promise((done) => setTimeout(done, 100))
    }
  }
  throw lastError ?? new Error('evaluation failed after reload')
}

async function connect() {
  const page = await waitForTarget(debugPort)
  if (!page) fail('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    ws.addEventListener('open', resolvePromise, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true })
  })
  attach(ws)
  await send('Runtime.enable')
}

function readPrefs() {
  try {
    return JSON.parse(readFileSync(join(profile, 'ui-prefs.json'), 'utf8'))
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
  ${body}
})()`

try {
  checkStaticBoot()

  // ---------------------------------------------------------- first launch
  startApp()
  await connect()
  await evaluate(
    ui(`
      await waitFor(() => document.querySelector('.tool-btn[title*="切换界面主题"]'), 'toolbar')
      await waitFor(
        () => document.documentElement.dataset.theme === 'light' &&
          getComputedStyle(document.documentElement).backgroundColor === '${LIGHT_BG}',
        'light first frame'
      )
      // No saved preference yet: the bootstrap must fall through cleanly.
      if (document.documentElement.dataset.themeSource !== 'storage') {
        throw new Error('fresh profile did not use the localStorage fallback')
      }
    `)
  )

  let prefs = null
  for (let i = 0; i < 100 && prefs?.theme !== 'light'; i += 1) {
    prefs = readPrefs()
    if (prefs?.theme !== 'light') await new Promise((done) => setTimeout(done, 100))
  }
  if (prefs?.theme !== 'light') fail('ui-prefs.json was not mirrored on startup', prefs)

  await evaluate(
    ui(`
      const button = await waitFor(
        () => document.querySelector('.tool-btn[title*="切换界面主题"]'),
        'theme button'
      )
      button.click()
      await waitFor(
        () => document.documentElement.dataset.theme === 'dark' &&
          getComputedStyle(document.documentElement).backgroundColor === '${DARK_BG}',
        'dark frame'
      )
      if (localStorage.getItem('hshell.uiTheme') !== 'dark') {
        throw new Error('localStorage was not updated')
      }
    `)
  )

  prefs = null
  for (let i = 0; i < 100 && prefs?.theme !== 'dark'; i += 1) {
    prefs = readPrefs()
    if (prefs?.theme !== 'dark') await new Promise((done) => setTimeout(done, 100))
  }
  if (prefs?.theme !== 'dark') fail('ui-prefs.json was not updated after toggling', prefs)
  console.log('THEME_TOGGLED')

  // Upgrade path: an older install only has localStorage. With no
  // ui-prefs.json the bootstrap must fall back to it and then persist it.
  unlinkSync(join(profile, 'ui-prefs.json'))
  await send('Page.reload')
  await evaluateAfterReload(
    ui(`
      await waitFor(
        () => document.documentElement.dataset.theme === 'dark' &&
          document.documentElement.dataset.themeSource === 'storage' &&
          getComputedStyle(document.documentElement).backgroundColor === '${DARK_BG}',
        'dark localStorage fallback'
      )
    `)
  )
  prefs = null
  for (let i = 0; i < 100 && prefs?.theme !== 'dark'; i += 1) {
    prefs = readPrefs()
    if (prefs?.theme !== 'dark') await new Promise((done) => setTimeout(done, 100))
  }
  if (prefs?.theme !== 'dark') fail('the legacy theme was not migrated', prefs)
  console.log('THEME_MIGRATED_FROM_STORAGE')

  // "Reload Interface" must re-read the main-process preference, not the
  // theme captured when the window was created. Clearing localStorage also
  // proves the relaunch does not depend on it.
  await evaluate(`localStorage.clear()`)
  await send('Page.reload')
  await evaluateAfterReload(
    ui(`
      await waitFor(
        () => document.documentElement.dataset.theme === 'dark' &&
          document.documentElement.dataset.themeSource === 'preload' &&
          getComputedStyle(document.documentElement).backgroundColor === '${DARK_BG}',
        'dark reload'
      )
    `)
  )
  console.log('THEME_RELOADED_DARK')

  // ------------------------------------------------------------- relaunch
  await stopApp()
  startApp()
  await connect()
  await evaluate(
    ui(`
      await waitFor(
        () => document.documentElement.dataset.theme === 'dark' &&
          getComputedStyle(document.documentElement).backgroundColor === '${DARK_BG}',
        'dark relaunch'
      )
      if (document.documentElement.dataset.themeSource !== 'preload') {
        throw new Error('relaunch did not use the main-process theme')
      }
      if (localStorage.getItem('hshell.uiTheme') !== null) {
        throw new Error('the relaunch check unexpectedly relied on localStorage')
      }
    `)
  )
  console.log('THEME_RESTARTED_DARK')

  await stopApp()
  cleanup()
  console.log('STARTUP THEME CHECK PASSED')
  process.exit(0)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
