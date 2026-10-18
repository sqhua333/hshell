import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readEnvelope, writeEnvelope } from './json-file'

/** Subset of Electron's `safeStorage` used by the vault (injected for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export type VaultMode = 'safeStorage' | 'password'

export interface VaultStatus {
  /** How secrets are protected at rest. */
  mode: VaultMode
  /** Whether a system keyring (non-`basic_text`) is available. */
  available: boolean
  /** Whether a master password has been configured (password mode). */
  initialized: boolean
  /** Whether secrets can be read/written right now. */
  unlocked: boolean
}

interface EncryptedItem {
  iv: string
  tag: string
  data: string
}

interface VaultFile {
  mode: VaultMode
  kdf?: { salt: string; N: number; r: number; p: number }
  check?: EncryptedItem
  items: Record<string, EncryptedItem>
}

const VAULT_SCHEMA_VERSION = 1
const SCRYPT_N = 1 << 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAXMEM = 64 * 1024 * 1024
const CHECK_VALUE = 'hshell-vault-v1'
export const MIN_MASTER_PASSWORD = 8

function scryptOptions(): { N: number; r: number; p: number; maxmem: number } {
  return { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, scryptOptions())
}

function encryptAes(plain: Buffer, key: Buffer): EncryptedItem {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

function decryptAes(item: EncryptedItem, key: Buffer): Buffer {
  const iv = Buffer.from(item.iv, 'base64')
  const tag = Buffer.from(item.tag, 'base64')
  if (iv.length !== 12 || tag.length !== 16) throw new Error('保险库数据已损坏')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(Buffer.from(item.data, 'base64')), decipher.final()])
}

function usableSafeStorage(storage: SafeStorageLike | undefined): storage is SafeStorageLike {
  if (!storage) return false
  try {
    if (!storage.isEncryptionAvailable()) return false
    // Linux without a real keyring falls back to `basic_text`, which is not
    // encryption. Refuse it and use the master-password mode instead.
    if (storage.getSelectedStorageBackend?.() === 'basic_text') return false
    return true
  } catch {
    return false
  }
}

/**
 * Encrypted secret store. Uses the OS keyring when one is actually available,
 * otherwise a master password (scrypt + AES-256-GCM).
 *
 * Secrets never leave the main process.
 */
export class Vault {
  private file: string
  private mode: VaultMode
  private available: boolean
  private initialized = false
  private unlocked = false
  private key: Buffer | null = null
  private data: VaultFile
  private readonly safeStorage?: SafeStorageLike

  constructor(dir: string, safeStorage?: SafeStorageLike) {
    this.file = join(dir, 'vault.json')
    this.safeStorage = usableSafeStorage(safeStorage) ? safeStorage : undefined

    const read = readEnvelope(this.file)
    const stored = !read.missing && read.data && typeof read.data === 'object'
      ? (read.data as VaultFile)
      : undefined

    if (stored && (stored.mode === 'safeStorage' || stored.mode === 'password')) {
      this.mode = stored.mode
      this.data = {
        mode: stored.mode,
        kdf: stored.kdf,
        check: stored.check,
        items: stored.items && typeof stored.items === 'object' ? { ...stored.items } : {}
      }
      this.available = Boolean(this.safeStorage)
      this.initialized = stored.mode === 'safeStorage' ? true : Boolean(stored.kdf && stored.check)
      this.unlocked = stored.mode === 'safeStorage' && Boolean(this.safeStorage)
    } else {
      this.mode = this.safeStorage ? 'safeStorage' : 'password'
      this.available = Boolean(this.safeStorage)
      this.unlocked = this.mode === 'safeStorage'
      this.data = { mode: this.mode, items: {} }
    }
  }

  status(): VaultStatus {
    return {
      mode: this.mode,
      available: this.available,
      initialized: this.initialized,
      unlocked: this.unlocked
    }
  }

  /**
   * Create the vault with a master password, or unlock an existing one.
   * Returns false when the password is wrong.
   */
  unlock(password: string): boolean {
    if (this.mode === 'safeStorage') {
      if (!this.safeStorage) {
        throw new Error('系统密钥环不可用，无法解锁保险库')
      }
      this.unlocked = true
      this.available = true
      return true
    }

    if (password.length < MIN_MASTER_PASSWORD) {
      if (!this.initialized) {
        throw new Error(`主密码至少需要 ${MIN_MASTER_PASSWORD} 位`)
      }
    }

    if (this.initialized && this.data.kdf && this.data.check) {
      const salt = Buffer.from(this.data.kdf.salt, 'base64')
      const key = deriveKey(password, salt)
      try {
        const check = decryptAes(this.data.check, key).toString('utf8')
        if (check !== CHECK_VALUE) return false
      } catch {
        return false
      }
      this.key = key
      this.unlocked = true
      return true
    }

    // First use: create the master password.
    const salt = randomBytes(16)
    const key = deriveKey(password, salt)
    this.data.kdf = {
      salt: salt.toString('base64'),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P
    }
    this.data.check = encryptAes(Buffer.from(CHECK_VALUE, 'utf8'), key)
    this.data.mode = 'password'
    this.mode = 'password'
    this.key = key
    this.initialized = true
    this.unlocked = true
    this.persist()
    return true
  }

  lock(): void {
    if (this.mode === 'safeStorage') return
    this.key = null
    this.unlocked = false
  }

  has(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.items, id)
  }

  list(): string[] {
    return Object.keys(this.data.items)
  }

  put(id: string, secret: Buffer): void {
    this.assertUnlocked()
    if (this.mode === 'safeStorage') {
      const encrypted = this.safeStorage!.encryptString(secret.toString('base64'))
      this.data.items[id] = { iv: '', tag: '', data: encrypted.toString('base64') }
    } else {
      this.data.items[id] = encryptAes(secret, this.key!)
    }
    this.persist()
  }

  get(id: string): Buffer | null {
    this.assertUnlocked()
    const item = this.data.items[id]
    if (!item) return null
    if (this.mode === 'safeStorage') {
      const encrypted = Buffer.from(item.data, 'base64')
      return Buffer.from(this.safeStorage!.decryptString(encrypted), 'base64')
    }
    try {
      return decryptAes(item, this.key!)
    } catch {
      throw new Error('保险库数据已损坏或主密码不匹配')
    }
  }

  remove(id: string): void {
    this.assertUnlocked()
    if (!this.has(id)) return
    delete this.data.items[id]
    this.persist()
  }

  private assertUnlocked(): void {
    if (this.unlocked) return
    throw new Error(
      this.mode === 'password'
        ? '保险库已锁定，请先在「密钥管理」中解锁'
        : '保险库不可用'
    )
  }

  private persist(): void {
    this.data.mode = this.mode
    writeEnvelope(this.file, this.data, VAULT_SCHEMA_VERSION)
  }
}
