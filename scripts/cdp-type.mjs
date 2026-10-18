#!/usr/bin/env node
/**
 * Type text into the focused xterm and press Enter in the running Electron app.
 * Usage: node scripts/cdp-type.mjs "uname -a"
 */
const endpoint = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222'
const text = process.argv.slice(2).join(' ')

const targets = await (await fetch(`${endpoint}/json/list`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) throw new Error('no page target found')

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
    await send('Runtime.evaluate', {
      expression: "document.querySelector('.xterm-helper-textarea')?.focus()"
    })
    await send('Input.insertText', { text })
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      })
    }
    console.log('typed')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    setTimeout(() => socket.close(), 300)
  }
})
