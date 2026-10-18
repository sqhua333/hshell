#!/usr/bin/env node
/**
 * Headless smoke test for a packaged build.
 *
 * Usage: node scripts/smoke-packaged.mjs [path-to-binary]
 * Default binary: dist/linux-unpacked/hshell
 *
 * Launches the app with remote debugging enabled, connects over CDP and checks
 * that the renderer booted and the preload bridge is available. Exits non-zero
 * on failure. The temporary profile is removed afterwards.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const binary = resolve(process.argv[2] ?? 'dist/linux-unpacked/hshell')
const port = Number(process.env.SMOKE_PORT ?? 9333)
const profile = mkdtempSync(join(tmpdir(), 'hshell-smoke-'))

const child = spawn(
  binary,
  [
    '--headless',
    '--ozone-platform=headless',
    `--remote-debugging-port=${port}`,
    '--no-sandbox',
    `--user-data-dir=${profile}`
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)

let log = ''
child.stdout.on('data', (chunk) => (log += chunk))
child.stderr.on('data', (chunk) => (log += chunk))

const endpoint = `http://127.0.0.1:${port}`
let socket

function fail(message) {
  console.error(`smoke failed: ${message}`)
  if (log.trim()) console.error(log.trim().split('\n').slice(-15).join('\n'))
  child.kill('SIGTERM')
  rmSync(profile, { recursive: true, force: true })
  process.exit(1)
}

async function waitForTarget() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`${endpoint}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (page) return page
    } catch {
      /* not listening yet */
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  return null
}

function evaluate(expression) {
  return new Promise((resolvePromise, reject) => {
    const id = 1
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', onMessage)
      if (message.error) reject(new Error(message.error.message))
      else if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text ?? 'evaluation failed'))
      } else {
        resolvePromise(message.result?.result?.value)
      }
    }
    socket.addEventListener('message', onMessage)
    socket.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      })
    )
  })
}

const page = await waitForTarget()
if (!page) fail('no page target after 30s')

try {
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true })
  })

  const result = await evaluate(`(async () => {
    await new Promise((done) => setTimeout(done, 500))
    return {
      title: document.title,
      bridge: typeof window.hshell,
      toolbarButtons: document.querySelectorAll('.tool-btn').length,
      demoBadge: Boolean(document.querySelector('.demo-badge')),
      userData: (await window.hshell.app.info()).userData
    }
  })()`)

  if (result.bridge !== 'object') fail('preload bridge missing')
  if (!result.title) fail('renderer did not boot')
  if (result.toolbarButtons < 5) fail(`unexpected toolbar (${result.toolbarButtons} buttons)`)
  if (result.demoBadge) fail('renderer fell back to the browser mock')

  console.log(JSON.stringify({ binary, port, ...result }, null, 2))
  socket.close()
  child.kill('SIGTERM')
  rmSync(profile, { recursive: true, force: true })
} catch (error) {
  fail(error.message)
}
