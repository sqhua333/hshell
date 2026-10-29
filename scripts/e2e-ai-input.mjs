#!/usr/bin/env node
/**
 * E2E for AI input approval (headless Electron + CDP + real MCP client).
 *
 *  1. Open a local shell, enable AI watch, then allow input.
 *  2. An MCP `send_input` call blocks while the approval card is shown;
 *     clicking Execute writes the command and the shell runs it.
 *  3. Clicking Deny writes nothing and reports `denied`.
 *  4. Revoking the per-session grant makes the next call `blocked`.
 *
 * Requires a prior `npm run build` (it launches out/main/index.js).
 * Usage: npm run e2e:ai-input
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = resolve(root, 'node_modules/electron/dist/electron')
const main = resolve(root, 'out/main/index.js')
const profile = mkdtempSync(join(tmpdir(), 'hshell-ai-input-'))
const debugPort = 9900 + (process.pid % 80)

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
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* ignore */
  }
}

function fail(message, extra) {
  console.error(`AI INPUT CHECK FAILED: ${message}`)
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
    if (message.method === 'Runtime.exceptionThrown') {
      consoleLog.push(
        `exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`
      )
    } else if (message.method === 'Runtime.consoleAPICalled') {
      consoleLog.push(
        `${message.params.type}: ${message.params.args
          .map((arg) => arg.value ?? arg.description ?? '')
          .join(' ')}`
      )
    }
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
    throw new Error(
      result.exceptionDetails.exception?.description ?? 'evaluation failed'
    )
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
  const terminalText = () =>
    [...document.querySelectorAll('.tab-view.active .xterm-rows > div')]
      .map((row) => row.textContent ?? '')
      .join('\\n')
  ${body}
})()`

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))
  ])
}

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

  // Open a local shell from the welcome screen.
  await evaluate(
    ui(`
      await waitFor(() => document.querySelector('.welcome'), 'welcome screen')
      const findButton = () =>
        [...document.querySelectorAll('.welcome-actions .btn')]
          .find((item) => /本地终端|Local terminal/.test(item.textContent ?? ''))
      for (let attempt = 0; attempt < 20; attempt++) {
        if (document.querySelector('.tab-view.active .xterm-helper-textarea')) break
        findButton()?.click()
        await sleep(250)
      }
      await waitFor(() => document.querySelector('.tab-view.active .xterm-helper-textarea'), 'terminal')
      await sleep(400)
      return true
    `)
  )

  // Enable watching from the status bar, then allow input and read the endpoint.
  const setup = await evaluate(
    ui(`
      const watch = await waitFor(() => document.querySelector('.status-ai'), 'AI watch button')
      if (!watch.classList.contains('active')) watch.click()
      let sessions = []
      for (let attempt = 0; attempt < 50; attempt++) {
        sessions = await window.hshell.ai.sessions()
        if (sessions.length) break
        await sleep(100)
      }
      if (!sessions.length) throw new Error('watched session missing')
      const runtimeId = sessions[0].runtimeId
      await window.hshell.ai.setWritable(runtimeId, true)
      const info = await window.hshell.ai.info()
      return { runtimeId, url: info.url, token: info.token, sessions }
    `)
  )
  if (!setup?.url || !setup?.token) fail('MCP endpoint missing', setup)

  const transport = new StreamableHTTPClientTransport(new URL(setup.url), {
    requestInit: { headers: { Authorization: `Bearer ${setup.token}` } }
  })
  const client = new Client({ name: 'hshell-e2e', version: '0.0.0' })
  await client.connect(transport)

  // 1. Execute: the tool call blocks until the card is confirmed. The command
  // is long enough to wrap so the whole echoed block must be decorated.
  const cmd = `echo "${'a'.repeat(120)}"; printf 'AI_E2E_%s\\n' OK`
  const approved = client.callTool({
    name: 'send_input',
    arguments: {
      runtimeId: setup.runtimeId,
      text: cmd,
      reason: 'e2e approval check'
    }
  })
  const card = await evaluate(
    ui(`
      const modal = await waitFor(() => document.querySelector('.ai-input-modal'), 'approval card')
      const text = modal.textContent ?? ''
      const button = [...modal.querySelectorAll('.modal-footer .btn')]
        .find((item) => item.classList.contains('btn-primary'))
      if (!button) throw new Error('execute button missing')
      button.click()
      return { text, clicked: true }
    `)
  )
  const approvedResult = await withTimeout(approved, 15_000, 'approved send_input')
  const approvedPayload = JSON.parse(approvedResult.content[0].text)
  if (approvedPayload.status !== 'sent') fail('execute did not send', approvedPayload)
  if (!card.text.includes(cmd) || !card.text.includes('e2e approval check')) {
    fail('approval card did not show the text and reason', card.text)
  }
  const ran = await evaluate(
    ui(`
      await waitFor(() => terminalText().includes('AI_E2E_OK'), 'command output')
      return terminalText()
    `)
  )
  if (!ran.includes('AI_E2E_OK')) fail('approved command did not run', ran)
  const decoration = await evaluate(
    ui(`
      const decorations = () =>
        [...document.querySelectorAll('.xterm-decoration-container .xterm-decoration')]
      await waitFor(() => decorations().length > 0, 'AI echo decoration')
      await sleep(300)
      const tops = decorations().map((node) => node.style.top)
      return { decorations: decorations().length, tops }
    `)
  )
  if (decoration.decorations < 2) {
    fail('wrapped AI echo was only partly decorated', decoration)
  }
  if (new Set(decoration.tops).size !== decoration.decorations) {
    fail('AI echo decorations share a row', decoration)
  }
  if (process.env.E2E_AI_SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(process.env.E2E_AI_SHOT, Buffer.from(shot.data, 'base64'))
  }
  console.log('AI_INPUT_EXECUTE_OK')

  // 2. Deny: nothing is written.
  const denied = client.callTool({
    name: 'send_input',
    arguments: { runtimeId: setup.runtimeId, text: "printf 'AI_DENY_%s\\n' BAD" }
  })
  await evaluate(
    ui(`
      const modal = await waitFor(() => document.querySelector('.ai-input-modal'), 'deny card')
      const button = [...modal.querySelectorAll('.modal-footer .btn')]
        .find((item) => !item.classList.contains('btn-primary'))
      if (!button) throw new Error('deny button missing')
      button.click()
      await waitFor(() => !document.querySelector('.ai-input-modal'), 'card closed')
      return true
    `)
  )
  const deniedPayload = JSON.parse(
    (await withTimeout(denied, 15_000, 'denied send_input')).content[0].text
  )
  if (deniedPayload.status !== 'denied') fail('deny did not report denied', deniedPayload)
  const afterDeny = await evaluate(
    ui(`await sleep(600); return terminalText()`)
  )
  if (afterDeny.includes('AI_DENY_BAD')) fail('denied command ran anyway', afterDeny)
  console.log('AI_INPUT_DENY_OK')

  // 3. Revoked grant: blocked before any prompt.
  await evaluate(
    ui(`await window.hshell.ai.setWritable(${JSON.stringify(setup.runtimeId)}, false); return true`)
  )
  const blocked = await client.callTool({
    name: 'send_input',
    arguments: { runtimeId: setup.runtimeId, text: 'echo blocked' }
  })
  const blockedPayload = JSON.parse(blocked.content[0].text)
  if (blockedPayload.status !== 'blocked') fail('revoked grant was not blocked', blockedPayload)
  const modalAfterBlock = await evaluate(
    ui(`await sleep(500); return !!document.querySelector('.ai-input-modal')`)
  )
  if (modalAfterBlock) fail('blocked request still showed a prompt')
  console.log('AI_INPUT_BLOCKED_OK')

  // 4. Revoking watch while a prompt is open cancels it and blocks the write.
  await evaluate(
    ui(`
      await window.hshell.ai.setWritable(${JSON.stringify(setup.runtimeId)}, true)
      return true
    `)
  )
  const pendingOnRevoke = client.callTool({
    name: 'send_input',
    arguments: { runtimeId: setup.runtimeId, text: 'echo should-not-run' }
  })
  await evaluate(
    ui(`
      await waitFor(() => document.querySelector('.ai-input-modal'), 'revoke card')
      document.querySelector('.status-ai').click()
      await waitFor(() => !document.querySelector('.ai-input-modal'), 'card closed after revoke')
      return true
    `)
  )
  const revokePayload = JSON.parse(
    (await withTimeout(pendingOnRevoke, 15_000, 'revoked send_input')).content[0].text
  )
  if (revokePayload.status !== 'blocked') {
    fail('revoking watch did not cancel the request', revokePayload)
  }
  console.log('AI_INPUT_REVOKE_CANCELS_OK')

  await client.close()
  cleanup()
  console.log('AI_INPUT_E2E_OK')
} catch (error) {
  fail(error.stack ?? error.message)
}
