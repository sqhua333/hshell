import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { utils } from 'ssh2'
import { Vault, type SafeStorageLike } from '../../src/main/storage/vault'
import {
  KeyService,
  buildAuthorizedKeysCommand,
  describePublicKey
} from '../../src/main/ssh/key-service'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hshell-vault-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeSafeStorage(backend = 'kwallet5'): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => Buffer.from(`sealed:${text}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^sealed:/, '')
  }
}

describe('Vault (master password)', () => {
  it('creates a vault, stores encrypted secrets, and reopens it', () => {
    const dir = tempDir()
    const vault = new Vault(dir)
    expect(vault.status()).toEqual({
      mode: 'password',
      available: false,
      initialized: false,
      unlocked: false
    })

    expect(vault.unlock('correct horse')).toBe(true)
    expect(vault.status().initialized).toBe(true)
    vault.put('item-1', Buffer.from('super-secret-value', 'utf8'))

    const disk = readFileSync(join(dir, 'vault.json'), 'utf8')
    expect(disk).not.toContain('super-secret-value')
    expect(disk).toContain('"mode": "password"')

    // A fresh instance starts locked and requires the same password.
    const reopened = new Vault(dir)
    expect(reopened.status()).toMatchObject({ mode: 'password', initialized: true, unlocked: false })
    expect(() => reopened.get('item-1')).toThrow('保险库已锁定')
    expect(reopened.unlock('wrong password')).toBe(false)
    expect(reopened.unlock('correct horse')).toBe(true)
    expect(reopened.get('item-1')?.toString('utf8')).toBe('super-secret-value')

    reopened.lock()
    expect(() => reopened.put('item-2', Buffer.from('x'))).toThrow('保险库已锁定')
  })

  it('rejects a short master password on first use', () => {
    const vault = new Vault(tempDir())
    expect(() => vault.unlock('short')).toThrow('至少需要 8 位')
    expect(vault.status().initialized).toBe(false)
  })

  it('uses safeStorage when a real keyring backend is available', () => {
    const dir = tempDir()
    const vault = new Vault(dir, fakeSafeStorage('gnome_libsecret'))
    expect(vault.status()).toMatchObject({ mode: 'safeStorage', available: true, unlocked: true })
    vault.put('item', Buffer.from('keyring-secret', 'utf8'))
    expect(vault.get('item')?.toString('utf8')).toBe('keyring-secret')
    expect(readFileSync(join(dir, 'vault.json'), 'utf8')).not.toContain('keyring-secret')

    const reopened = new Vault(dir, fakeSafeStorage('kwallet5'))
    expect(reopened.status().unlocked).toBe(true)
    expect(reopened.get('item')?.toString('utf8')).toBe('keyring-secret')
  })

  it('falls back to master password when the Linux backend is basic_text', () => {
    const vault = new Vault(tempDir(), fakeSafeStorage('basic_text'))
    expect(vault.status()).toMatchObject({
      mode: 'password',
      available: false,
      initialized: false
    })
    expect(vault.unlock('master-password')).toBe(true)
  })
})

describe('KeyService', () => {
  function setup(): { dir: string; vault: Vault; keys: KeyService } {
    const dir = tempDir()
    const vault = new Vault(dir)
    vault.unlock('master-password')
    return { dir, vault, keys: new KeyService(dir, vault) }
  }

  it('generates an ed25519 key and keeps private material in the vault only', () => {
    const { dir, vault, keys } = setup()
    const key = keys.generate({ label: 'test-ed25519', algorithm: 'ed25519' })

    expect(key.algorithm).toBe('ed25519')
    expect(key.bits).toBe(256)
    expect(key.fingerprint).toMatch(/^SHA256:/)
    expect(key.publicKey).toMatch(/^ssh-ed25519 /)
    expect(keys.list().map((item) => item.id)).toEqual([key.id])

    const record = keys.getPrivateKey(key.id)
    const parsed = utils.parseKey(record.privateKey)
    expect(parsed).not.toBeInstanceOf(Error)
    const described = describePublicKey(record.privateKey)
    expect(described.publicKey.split(' ')[1]).toBe(key.publicKey.split(' ')[1])

    const disk = readFileSync(join(dir, 'keys.json'), 'utf8')
    expect(disk).not.toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(disk).toContain(key.fingerprint)
    expect(vault.has(`key:${key.id}`)).toBe(true)
  })

  it('generates RSA and ECDSA keys with the requested size', () => {
    const { keys } = setup()
    const rsa = keys.generate({ label: 'rsa', algorithm: 'rsa', bits: 2048 })
    expect(rsa.algorithm).toBe('rsa')
    expect(rsa.bits).toBe(2048)
    expect(rsa.publicKey).toMatch(/^ssh-rsa /)

    const ecdsa = keys.generate({ label: 'ecdsa', algorithm: 'ecdsa', bits: 384 })
    expect(ecdsa.algorithm).toBe('ecdsa')
    expect(ecdsa.bits).toBe(384)
  })

  it('supports passphrase-protected keys end to end', () => {
    const { keys } = setup()
    const key = keys.generate({
      label: 'protected',
      algorithm: 'ed25519',
      passphrase: 'secret-pass'
    })
    expect(key.hasPassphrase).toBe(true)

    const record = keys.getPrivateKey(key.id)
    expect(record.passphrase).toBe('secret-pass')
    expect(utils.parseKey(record.privateKey, 'wrong-pass')).toBeInstanceOf(Error)
    expect(utils.parseKey(record.privateKey, 'secret-pass')).not.toBeInstanceOf(Error)
  })

  it('rejects invalid imported keys and dedupes by fingerprint', () => {
    const { keys } = setup()
    expect(() =>
      keys.importPrivateKey({ label: 'bad', privateKey: 'not a private key' })
    ).toThrow('私钥格式无效')

    const generated = keys.generate({ label: 'original', algorithm: 'ed25519' })
    const record = keys.getPrivateKey(generated.id)
    const imported = keys.importPrivateKey({ label: 'duplicate', privateKey: record.privateKey })
    expect(imported.id).toBe(generated.id)
    expect(keys.list()).toHaveLength(1)
  })

  it('removes key metadata and vault material together', () => {
    const { vault, keys } = setup()
    const key = keys.generate({ label: 'temporary', algorithm: 'ed25519' })
    keys.remove(key.id)
    expect(keys.list()).toHaveLength(0)
    expect(vault.has(`key:${key.id}`)).toBe(false)
    expect(() => keys.getPrivateKey(key.id)).toThrow('密钥不存在')
  })
})

describe('buildAuthorizedKeysCommand', () => {
  it('installs into the default authorized_keys path without duplicates', () => {
    const command = buildAuthorizedKeysCommand('ssh-ed25519 AAAA test')
    expect(command).toContain('"$HOME/.ssh/authorized_keys"')
    expect(command).toContain('umask 077')
    expect(command).toContain("grep -qxF 'ssh-ed25519 AAAA test'")
  })

  it('honors an explicit temporary absolute path', () => {
    const command = buildAuthorizedKeysCommand(
      'ssh-ed25519 AAAA test',
      '/tmp/hshell-test/authorized_keys'
    )
    expect(command).toContain("'/tmp/hshell-test/authorized_keys'")
    expect(command).not.toContain('$HOME/.ssh')
  })

  it('shell-quotes single quotes and supports home-relative paths', () => {
    const command = buildAuthorizedKeysCommand("ssh-ed25519 AAAA it's", '~/keys/authorized_keys')
    expect(command).toContain('"$HOME/keys/authorized_keys"')
    expect(command).toContain(`'ssh-ed25519 AAAA it'\\''s'`)
  })

  it('rejects unsafe keys and paths', () => {
    expect(() => buildAuthorizedKeysCommand('key\nrm -rf /')).toThrow('公钥格式无效')
    expect(() => buildAuthorizedKeysCommand('ssh-ed25519 AAAA', 'relative/path')).toThrow(
      '绝对路径'
    )
    expect(() => buildAuthorizedKeysCommand('ssh-ed25519 AAAA', '/tmp/../etc/passwd')).toThrow(
      '目标路径无效'
    )
    expect(() => buildAuthorizedKeysCommand('ssh-ed25519 AAAA', '/tmp/a b')).toThrow('目标路径无效')
  })
})
