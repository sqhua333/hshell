import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  KnownHosts,
  fingerprintOf,
  parseKeyAlgorithm
} from '../../src/main/ssh/known-hosts'

function makeBlob(algorithm: string, key: Buffer): Buffer {
  const name = Buffer.from(algorithm, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(name.length, 0)
  return Buffer.concat([length, name, key])
}

describe('host key helpers', () => {
  it('parses the algorithm name from an SSH key blob', () => {
    expect(parseKeyAlgorithm(makeBlob('ssh-ed25519', Buffer.from('xyz')))).toBe('ssh-ed25519')
  })

  it('produces an unpadded SHA256 fingerprint', () => {
    const fingerprint = fingerprintOf(makeBlob('ssh-rsa', Buffer.from('abc')))
    expect(fingerprint.startsWith('SHA256:')).toBe(true)
    expect(fingerprint).not.toContain('=')
  })
})

describe('KnownHosts TOFU store', () => {
  it('records, matches and detects changed keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hshell-kh-'))
    try {
      const store = new KnownHosts(dir)
      const original = makeBlob('ssh-ed25519', Buffer.from('original-key'))
      const changed = makeBlob('ssh-ed25519', Buffer.from('different-key'))

      expect(store.lookup('hshell-test.invalid', 22, original).state).toBe('unknown')

      store.save('hshell-test.invalid', 22, original)
      expect(store.lookup('hshell-test.invalid', 22, original).state).toBe('known')

      const result = store.lookup('hshell-test.invalid', 22, changed)
      expect(result.state).toBe('changed')
      expect(result.oldFingerprint).toBe(fingerprintOf(original))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
