import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { readEnvelope, writeEnvelope } from './json-file'

/** Subset of Electron's `safeStorage` used by the store (injected for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

type Scheme = 'safeStorage' | 'machine'

interface StoredCredential {
  scheme: Scheme
  iv?: string
  tag?: string
  /** Base64 ciphertext (safeStorage mode: base64 of the encrypted buffer). */
  data: string
}

interface CredentialFile {
  items: Record<string, StoredCredential>
}

export interface CredentialStoreOptions {
  /** Override the machine identity (tests). */
  machineId?: string
}

const SCHEMA_VERSION = 1
const KEY_FILE = 'credentials.key'
const STORE_FILE = 'credentials.json'

function usableSafeStorage(storage: SafeStorageLike | undefined): storage is SafeStorageLike {
  if (!storage) return false
  try {
    if (!storage.isEncryptionAvailable()) return false
    // `basic_text` is not real encryption; use the machine-bound key instead.
    if (storage.getSelectedStorageBackend?.() === 'basic_text') return false
    return true
  } catch {
    return false
  }
}

function readMachineId(): string {
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = readFileSync(file, 'utf8').trim()
      if (value) return value
    } catch {
      /* try the next source */
    }
  }
  return hostname()
}

function encryptAes(plain: Buffer, key: Buffer): StoredCredential {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  return {
    scheme: 'machine',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

function decryptAes(item: StoredCredential, key: Buffer): Buffer {
  const iv = Buffer.from(item.iv ?? '', 'base64')
  const tag = Buffer.from(item.tag ?? '', 'base64')
  if (iv.length !== 12 || tag.length !== 16) throw new Error('credential data is corrupt')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([
    decipher.update(Buffer.from(item.data, 'base64')),
    decipher.final()
  ])
}

/**
 * Stores session passwords at rest.
 *
 * - Uses the OS keyring when `safeStorage` provides real encryption.
 * - Otherwise encrypts with AES-256-GCM using a per-install key (0600) mixed
 *   with the machine id. This keeps working across restarts without a master
 *   password, but is weaker than a system keyring: another process running as
 *   the same user can derive the key and decrypt the file.
 *
 * Secrets never leave the main process.
 */
export class CredentialStore {
  private readonly dir: string
  private readonly file: string
  private readonly keyFile: string
  private readonly safeStorage?: SafeStorageLike
  private readonly machineId: string
  private items: Record<string, StoredCredential> = {}
  private key: Buffer | null = null

  constructor(dir: string, safeStorage?: SafeStorageLike, options: CredentialStoreOptions = {}) {
    this.dir = dir
    this.file = join(dir, STORE_FILE)
    this.keyFile = join(dir, KEY_FILE)
    this.safeStorage = usableSafeStorage(safeStorage) ? safeStorage : undefined
    this.machineId = options.machineId ?? readMachineId()

    const read = readEnvelope(this.file)
    const data = read.data as CredentialFile | undefined
    if (data && typeof data === 'object' && data.items && typeof data.items === 'object') {
      this.items = { ...data.items }
    }
  }

  has(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.items, id)
  }

  get(id: string): string | null {
    const item = this.items[id]
    if (!item) return null
    try {
      if (item.scheme === 'safeStorage') {
        if (!this.safeStorage) return null
        const encrypted = Buffer.from(item.data, 'base64')
        return this.safeStorage.decryptString(encrypted)
      }
      return decryptAes(item, this.deriveKey()).toString('utf8')
    } catch {
      // Corrupt data or a changed machine identity: fall back to asking again.
      return null
    }
  }

  put(id: string, secret: string): void {
    if (!secret) return
    if (this.safeStorage) {
      const encrypted = this.safeStorage.encryptString(secret)
      this.items[id] = { scheme: 'safeStorage', data: encrypted.toString('base64') }
    } else {
      this.items[id] = encryptAes(Buffer.from(secret, 'utf8'), this.deriveKey())
    }
    this.persist()
  }

  remove(id: string): void {
    if (!this.has(id)) return
    delete this.items[id]
    this.persist()
  }

  private deriveKey(): Buffer {
    if (this.key) return this.key
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    let secret: Buffer
    try {
      secret = readFileSync(this.keyFile)
      if (secret.length < 32) throw new Error('short key')
    } catch {
      secret = randomBytes(32)
      writeFileSync(this.keyFile, secret, { mode: 0o600 })
      try {
        chmodSync(this.keyFile, 0o600)
      } catch {
        /* best-effort on filesystems without POSIX modes */
      }
    }
    this.key = createHash('sha256')
      .update('hshell-credential-store-v1')
      .update(secret)
      .update(this.machineId)
      .digest()
    return this.key
  }

  private persist(): void {
    writeEnvelope(this.file, { items: this.items }, SCHEMA_VERSION)
  }
}
