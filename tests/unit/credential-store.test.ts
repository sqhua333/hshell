import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CredentialStore,
  type SafeStorageLike
} from '../../src/main/storage/credential-store'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hshell-credentials-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeSafeStorage(backend = 'gnome_libsecret'): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => Buffer.from(`safe:${text}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^safe:/, '')
  }
}

describe('CredentialStore', () => {
  it('round-trips secrets with the machine-bound key', () => {
    const dir = tempDir()
    const store = new CredentialStore(dir, undefined, { machineId: 'machine-a' })
    store.put('session:one', 's3cret!')
    expect(store.get('session:one')).toBe('s3cret!')
    expect(store.has('session:one')).toBe(true)

    const reopened = new CredentialStore(dir, undefined, { machineId: 'machine-a' })
    expect(reopened.get('session:one')).toBe('s3cret!')
  })

  it('never writes plaintext and protects the key file', () => {
    const dir = tempDir()
    const store = new CredentialStore(dir, undefined, { machineId: 'machine-a' })
    store.put('session:one', 's3cret!')
    const stored = readFileSync(join(dir, 'credentials.json'), 'utf8')
    expect(stored).not.toContain('s3cret!')
    expect(JSON.parse(stored).data.items['session:one'].scheme).toBe('machine')
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'credentials.key')).mode & 0o777).toBe(0o600)
    }
  })

  it('returns null rather than throwing when the machine identity changes', () => {
    const dir = tempDir()
    const store = new CredentialStore(dir, undefined, { machineId: 'machine-a' })
    store.put('session:one', 's3cret!')
    const moved = new CredentialStore(dir, undefined, { machineId: 'machine-b' })
    expect(moved.get('session:one')).toBeNull()
  })

  it('uses safeStorage when a real keyring backend is available', () => {
    const dir = tempDir()
    const store = new CredentialStore(dir, fakeSafeStorage())
    store.put('session:one', 's3cret!')
    expect(store.get('session:one')).toBe('s3cret!')
    const stored = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'))
    expect(stored.data.items['session:one'].scheme).toBe('safeStorage')
    expect(JSON.stringify(stored)).not.toContain('s3cret!')
  })

  it('does not use safeStorage basic_text', () => {
    const dir = tempDir()
    const store = new CredentialStore(dir, fakeSafeStorage('basic_text'))
    store.put('session:one', 's3cret!')
    const stored = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'))
    expect(stored.data.items['session:one'].scheme).toBe('machine')
  })

  it('removes stored secrets', () => {
    const dir = tempDir()
    const store = new CredentialStore(dir, undefined, { machineId: 'machine-a' })
    store.put('session:one', 's3cret!')
    store.remove('session:one')
    expect(store.has('session:one')).toBe(false)
    expect(new CredentialStore(dir, undefined, { machineId: 'machine-a' }).get('session:one')).toBeNull()
  })
})
