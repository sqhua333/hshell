#!/usr/bin/env node
/**
 * Local demo SSH server used for development and UI verification.
 * - Listens on 127.0.0.1:2222
 * - Accepts any authentication (none/password/publickey/keyboard-interactive)
 * - Spawns an interactive bash inside a PTY via `script(1)`
 *
 * Usage: node scripts/mock-sshd.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2

const PORT = Number(process.env.MOCK_SSHD_PORT || 2222)
const SHELL = process.env.SHELL || '/usr/bin/bash'
const KEY_PATH = fileURLToPath(new URL('./.mock-host-key.pem', import.meta.url))

let hostKey
if (existsSync(KEY_PATH)) {
  hostKey = readFileSync(KEY_PATH)
} else {
  hostKey = Buffer.from(utils.generateKeyPairSync('ed25519').private)
  writeFileSync(KEY_PATH, hostKey, { mode: 0o600 })
}

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => ctx.accept())
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('window-change', (acceptChange) => acceptChange?.())
      // This demo server does not implement the SFTP subsystem.
      session.on('sftp', (_acceptSftp, rejectSftp) => rejectSftp?.())
      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        const child = spawn('script', ['-qfc', `${SHELL} -i`, '/dev/null'], {
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            LANG: process.env.LANG || 'C.UTF-8',
            PS1: '\\[\\e[1;32m\\]demo@hshell-demo\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]$ '
          },
          stdio: ['pipe', 'pipe', 'pipe']
        })
        child.stdout.pipe(stream)
        child.stderr.pipe(stream)
        stream.pipe(child.stdin)
        stream.on('close', () => child.kill('SIGHUP'))
        child.on('exit', (code) => {
          try {
            stream.exit(code ?? 0)
            stream.end()
          } catch {
            /* stream may be closed */
          }
        })
      })
    })
  })
  client.on('error', () => undefined)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MOCK_SSHD_READY 127.0.0.1:${PORT}`)
})
