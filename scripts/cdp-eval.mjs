#!/usr/bin/env node
/**
 * Evaluate JavaScript in the running Electron page for UI verification.
 * Usage: node scripts/cdp-eval.mjs "<expression>"
 */
const endpoint = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222'
const expression = process.argv.slice(2).join(' ')

if (!expression) {
  console.error('usage: node scripts/cdp-eval.mjs "<expression>"')
  process.exit(1)
}

const targets = await (await fetch(`${endpoint}/json/list`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('no page target found')
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id || !pending.has(message.id)) return
  const { resolve, reject } = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) reject(new Error(message.error.message))
  else resolve(message.result)
})

socket.addEventListener('open', async () => {
  try {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (result.exceptionDetails) {
      console.error(JSON.stringify(result.exceptionDetails, null, 2))
      process.exitCode = 1
    } else {
      console.log(JSON.stringify(result.result?.value ?? null, null, 2))
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    socket.close()
  }
})
