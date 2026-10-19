#!/usr/bin/env node
/**
 * E2E for drag-and-drop split panes (headless Electron + CDP).
 *
 *  1. Open one session in a fresh tab.
 *  2. Drag a second session onto the right half of the pane: the half-pane
 *     preview appears on the right and dropping creates a 50/50 horizontal
 *     split with the new pane on the right.
 *  3. Drag a third session onto the bottom half of the right pane: the outer
 *     split keeps its sizes and the right pane nests a 50/50 vertical split.
 *  4. All panes connect, both dividers exist, and the nested tree is written
 *     to layouts.json.
 *
 * Requires a prior `npm run build` (it launches out/main/index.js).
 * Usage: npm run e2e:drag-split
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = resolve(root, 'node_modules/electron/dist/electron')
const main = resolve(root, 'out/main/index.js')
const mockServer = resolve(root, 'scripts/mock-sshd.mjs')
const profile = mkdtempSync(join(tmpdir(), 'hshell-drag-split-'))
const debugPort = 9500 + (process.pid % 100)
const mockPort = 2500 + (process.pid % 100)

const mock = spawn(process.execPath, [mockServer], {
  env: { ...process.env, MOCK_SSHD_PORT: String(mockPort) },
  stdio: ['ignore', 'pipe', 'pipe']
})
let mockLog = ''
mock.stdout.on('data', (chunk) => (mockLog += chunk))
mock.stderr.on('data', (chunk) => (mockLog += chunk))

const now = Date.now()
const session = (id, name) => ({
  id,
  name,
  folderId: null,
  host: '127.0.0.1',
  port: mockPort,
  username: 'demo',
  auth: { method: 'password', password: 'x' },
  terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
  createdAt: now,
  updatedAt: now
})
writeFileSync(
  join(profile, 'sessions.json'),
  JSON.stringify({
    schemaVersion: 2,
    data: [session('alpha', '甲主机'), session('beta', '乙主机'), session('gamma', '丙主机')]
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
  console.error(`DRAG SPLIT CHECK FAILED: ${message}`)
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
  // The first connection asks to trust the host key (TOFU); later connections
  // to the same host reuse the stored key and show no dialog.
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
  const panes = () => [...document.querySelectorAll('.tab-view.active .pane-cell')]
  const paneInfo = () => panes().map((cell) => ({
    sessionId: cell.getAttribute('data-session-id'),
    left: cell.style.left,
    top: cell.style.top,
    width: cell.style.width,
    height: cell.style.height
  }))
  const dragSession = (sessionId, element, x, y) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('application/x-hshell-session', sessionId)
    dataTransfer.setData('text/plain', sessionId)
    const init = { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y }
    element.dispatchEvent(new DragEvent('dragover', init))
    return { init }
  }
  const dropSession = (element, drag) => {
    element.dispatchEvent(new DragEvent('drop', drag.init))
  }
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

  const result = await evaluate(
    ui(`
      // 1. Open the first session in a fresh tab.
      const alphaRow = await waitFor(
        () => document.querySelector('.session-row[data-session-id="alpha"]'),
        'alpha session row'
      )
      alphaRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await acceptHostKey()
      await waitFor(() => panes().length === 1, 'first pane')
      await waitFor(
        () => document.querySelector('.statusbar')?.textContent?.includes('已连接'),
        'first connection'
      )

      // 2. Drag beta onto the right half of the pane. While hovering, the
      //    half-pane preview must be visible on the right.
      const canvas = await waitFor(
        () => document.querySelector('.tab-view.active .pane-canvas'),
        'pane canvas'
      )
      const canvasRect = canvas.getBoundingClientRect()
      const rightHalf = dragSession(
        'beta',
        canvas,
        canvasRect.left + canvasRect.width * 0.75,
        canvasRect.top + canvasRect.height * 0.5
      )
      const preview = await waitFor(() => {
        const zone = document.querySelector('.pane-drop-zone')
        return zone ? { left: zone.style.left, width: zone.style.width, top: zone.style.top, height: zone.style.height } : null
      }, 'drop preview')
      dropSession(canvas, rightHalf)
      await acceptHostKey()

      await waitFor(() => panes().length === 2, 'two panes')
      const afterHorizontal = paneInfo()
      await waitFor(
        () => document.querySelector('.statusbar')?.textContent?.includes('已连接'),
        'second connection'
      )

      // 3. Drag gamma onto the bottom half of the right (beta) pane; the
      //    outer split must keep its sizes and beta/gamma split vertically.
      const betaCell = panes().find((cell) => cell.getAttribute('data-session-id') === 'beta')
      const betaRect = betaCell.getBoundingClientRect()
      const bottomHalf = dragSession(
        'gamma',
        canvas,
        betaRect.left + betaRect.width * 0.5,
        betaRect.top + betaRect.height * 0.9
      )
      await waitFor(() => document.querySelector('.pane-drop-zone.vertical'), 'vertical preview')
      dropSession(canvas, bottomHalf)
      await acceptHostKey()

      await waitFor(() => panes().length === 3, 'three panes')
      await waitFor(
        () => document.querySelector('.statusbar')?.textContent?.includes('已连接'),
        'third connection'
      )

      return {
        preview,
        afterHorizontal,
        afterVertical: paneInfo(),
        dividers: [...document.querySelectorAll('.pane-handle')].map((handle) => ({
          className: handle.className,
          orientation: handle.getAttribute('aria-orientation'),
          left: handle.style.left,
          top: handle.style.top
        })),
        status: document.querySelector('.statusbar')?.textContent || ''
      }
    `)
  )

  if (!result) fail('no result from UI evaluation')

  // Horizontal drop: beta must be the right-hand pane, each half 50%.
  const [alpha, beta] = result.afterHorizontal
  if (alpha.sessionId !== 'alpha' || beta.sessionId !== 'beta') {
    fail('unexpected pane order after horizontal drop', result)
  }
  if (alpha.left !== '0%' || alpha.width !== '50%' || beta.left !== '50%' || beta.width !== '50%') {
    fail('horizontal drop did not produce a 50/50 left/right split', result)
  }
  if (result.preview.left !== '50%' || result.preview.width !== '50%') {
    fail('hover preview was not drawn on the right half', result)
  }

  // Nested drop: alpha keeps the full height, beta/gamma share the right column.
  const byId = Object.fromEntries(result.afterVertical.map((pane) => [pane.sessionId, pane]))
  if (!byId.alpha || !byId.beta || !byId.gamma) fail('missing pane after vertical drop', result)
  if (
    byId.alpha.left !== '0%' ||
    byId.alpha.top !== '0%' ||
    byId.alpha.width !== '50%' ||
    byId.alpha.height !== '100%'
  ) {
    fail('outer pane changed size after the nested split', result)
  }
  if (
    byId.beta.left !== '50%' ||
    byId.beta.top !== '0%' ||
    byId.beta.width !== '50%' ||
    byId.beta.height !== '50%'
  ) {
    fail('beta pane is not the top half after the nested split', result)
  }
  if (
    byId.gamma.left !== '50%' ||
    byId.gamma.top !== '50%' ||
    byId.gamma.width !== '50%' ||
    byId.gamma.height !== '50%'
  ) {
    fail('gamma pane is not the bottom half after the nested split', result)
  }

  // One horizontal divider (full canvas height) and one vertical divider in
  // the right column.
  if (result.dividers.length !== 2) fail('expected two dividers', result)
  if (!result.dividers.some((divider) => divider.className.includes('horizontal'))) {
    fail('missing horizontal divider', result)
  }
  if (!result.dividers.some((divider) => divider.className.includes('vertical'))) {
    fail('missing vertical divider', result)
  }

  // 4. The nested tree must be persisted (layout saves are debounced ~200ms).
  const layoutFile = join(profile, 'layouts.json')
  const deadline = Date.now() + 5000
  let stored = null
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(readFileSync(layoutFile, 'utf8'))
      const layout = raw?.data?.tabs?.[0]?.layout ?? raw?.tabs?.[0]?.layout
      if (layout) {
        stored = layout
        break
      }
    } catch {
      /* not written yet */
    }
    await new Promise((done) => setTimeout(done, 200))
  }
  if (!stored) fail('layout was not persisted', result)

  const rootLayout = stored
  if (
    rootLayout.type !== 'split' ||
    rootLayout.direction !== 'horizontal' ||
    rootLayout.children?.length !== 2 ||
    rootLayout.children[0]?.sessionId !== 'alpha'
  ) {
    fail('persisted root is not the expected horizontal split', { stored, result })
  }
  const nested = rootLayout.children[1]
  if (
    nested?.type !== 'split' ||
    nested.direction !== 'vertical' ||
    nested.children?.[0]?.sessionId !== 'beta' ||
    nested.children?.[1]?.sessionId !== 'gamma'
  ) {
    fail('persisted nested vertical split is wrong', { stored, result })
  }

  console.log('DRAG SPLIT CHECK OK')
  console.log(JSON.stringify({ ...result, stored }, null, 2))
  cleanup()
  process.exit(0)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
