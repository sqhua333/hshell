import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { utils } from 'ssh2'
import type {
  GenerateKeyInput,
  ImportKeyInput,
  KeyAlgorithm,
  KeyMetadata
} from '@shared/types'
import { keyMetadataSchema } from '@shared/schemas'
import { fingerprintOf } from './known-hosts'
import { readEnvelope, writeEnvelope } from '../storage/json-file'
import type { Vault } from '../storage/vault'

const KEYS_SCHEMA_VERSION = 1
const VAULT_PREFIX = 'key:'

export interface PrivateKeyRecord {
  privateKey: string
  passphrase?: string
}

export interface ParsedPublicKey {
  algorithm: KeyAlgorithm
  bits: number
  blob: Buffer
  publicKey: string
  comment?: string
}

function keyAlgorithm(type: string): KeyAlgorithm {
  if (type.includes('ed25519')) return 'ed25519'
  if (type.includes('ecdsa')) return 'ecdsa'
  return 'rsa'
}

function keyBits(type: string): number {
  if (type.includes('ed25519')) return 256
  const ecdsa = /nistp(256|384|521)/.exec(type)
  if (ecdsa) return Number(ecdsa[1])
  return 0
}

/** Parse a public or private key string and compute its SHA256 fingerprint. */
export function describePublicKey(input: string, passphrase?: string): ParsedPublicKey {
  const parsed = utils.parseKey(input, passphrase)
  if (parsed instanceof Error) throw new Error('公钥格式无效')
  const blob = parsed.getPublicSSH()
  const algorithm = keyAlgorithm(parsed.type)
  return {
    algorithm,
    bits: keyBits(parsed.type),
    blob,
    publicKey: `${parsed.type} ${blob.toString('base64')}${parsed.comment ? ` ${parsed.comment}` : ''}`,
    ...(parsed.comment ? { comment: parsed.comment } : {})
  }
}

function passphraseOptions(passphrase?: string): Record<string, unknown> {
  return passphrase ? { passphrase, cipher: 'aes256-ctr', rounds: 16 } : {}
}

/**
 * Build the remote shell command that appends a public key to
 * `authorized_keys` without adding duplicates. Keys and paths are shell-quoted.
 */
export function buildAuthorizedKeysCommand(
  publicKey: string,
  authorizedKeysPath = '~/.ssh/authorized_keys'
): string {
  const line = publicKey.trim()
  if (!line || /[\r\n\0]/.test(line)) throw new Error('公钥格式无效')
  if (/[\r\n\0]/.test(authorizedKeysPath)) throw new Error('目标路径无效')
  if (authorizedKeysPath.split('/').includes('..')) throw new Error('目标路径无效')

  let pathExpr: string
  if (authorizedKeysPath === '~') {
    pathExpr = '"$HOME"'
  } else if (authorizedKeysPath.startsWith('~/')) {
    const rest = authorizedKeysPath.slice(2)
    if (!/^[A-Za-z0-9._/-]+$/.test(rest)) throw new Error('目标路径无效')
    pathExpr = `"$HOME/${rest}"`
  } else if (authorizedKeysPath.startsWith('/')) {
    if (!/^[A-Za-z0-9._/-]+$/.test(authorizedKeysPath)) throw new Error('目标路径无效')
    pathExpr = `'${authorizedKeysPath.replace(/'/g, `'\\''`)}'`
  } else {
    throw new Error('目标路径必须是绝对路径或以 ~/ 开头')
  }

  const quotedKey = `'${line.replace(/'/g, `'\\''`)}'`
  return (
    `umask 077; mkdir -p "$(dirname ${pathExpr})" && touch ${pathExpr} && ` +
    `grep -qxF ${quotedKey} ${pathExpr} || printf '%s\\n' ${quotedKey} >> ${pathExpr}`
  )
}

/**
 * Generates/imports SSH keys and keeps private material in the vault.
 * Only public metadata is ever persisted in `keys.json`.
 */
export class KeyService {
  private file: string
  private keys: KeyMetadata[] = []

  constructor(
    dir: string,
    private readonly vault: Vault
  ) {
    this.file = join(dir, 'keys.json')
    this.load()
  }

  private load(): void {
    const read = readEnvelope(this.file)
    if (read.missing) return
    if (!Array.isArray(read.data)) return
    this.keys = read.data.flatMap((item) => {
      const parsed = keyMetadataSchema.safeParse(item)
      return parsed.success ? [parsed.data] : []
    })
  }

  private persist(): void {
    writeEnvelope(this.file, this.keys, KEYS_SCHEMA_VERSION)
  }

  list(): KeyMetadata[] {
    return [...this.keys].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): KeyMetadata | undefined {
    return this.keys.find((key) => key.id === id)
  }

  publicKey(id: string): string {
    const key = this.get(id)
    if (!key) throw new Error('密钥不存在')
    return key.publicKey
  }

  generate(input: GenerateKeyInput): KeyMetadata {
    const algorithm = input.algorithm
    let pair: { private: string; public: string }
    let bits: number

    if (algorithm === 'rsa') {
      bits = input.bits && input.bits >= 2048 ? Math.min(input.bits, 8192) : 3072
      pair = utils.generateKeyPairSync('rsa', {
        bits,
        ...passphraseOptions(input.passphrase)
      })
    } else if (algorithm === 'ecdsa') {
      const ecdsaBits: 256 | 384 | 521 =
        input.bits === 384 || input.bits === 521 ? input.bits : 256
      bits = ecdsaBits
      pair = utils.generateKeyPairSync('ecdsa', {
        bits: ecdsaBits,
        ...passphraseOptions(input.passphrase)
      })
    } else {
      bits = 256
      pair = utils.generateKeyPairSync('ed25519', passphraseOptions(input.passphrase))
    }

    // Ensure the generated private key really is parseable.
    const parsedPrivate = utils.parseKey(pair.private, input.passphrase)
    if (parsedPrivate instanceof Error) {
      throw new Error(`密钥生成失败：${parsedPrivate.message}`)
    }
    const described = describePublicKey(pair.public)
    return this.store({
      id: `key-${randomUUID().slice(0, 8)}`,
      label: input.label,
      algorithm,
      bits,
      fingerprint: fingerprintOf(described.blob),
      publicKey: described.publicKey,
      hasPassphrase: Boolean(input.passphrase),
      createdAt: Date.now(),
      ...(described.comment ? { comment: described.comment } : {})
    }, { privateKey: pair.private, ...(input.passphrase ? { passphrase: input.passphrase } : {}) })
  }

  importPrivateKey(input: ImportKeyInput): KeyMetadata {
    const parsed = utils.parseKey(input.privateKey, input.passphrase)
    if (parsed instanceof Error) {
      throw new Error('私钥格式无效，或私钥口令不正确')
    }
    const described = describePublicKey(input.privateKey, input.passphrase)
    const fingerprint = fingerprintOf(described.blob)

    const existing = this.keys.find((key) => key.fingerprint === fingerprint)
    if (existing) return existing

    return this.store({
      id: `key-${randomUUID().slice(0, 8)}`,
      label: input.label,
      algorithm: described.algorithm,
      bits: described.bits,
      fingerprint,
      publicKey: described.publicKey,
      hasPassphrase: Boolean(input.passphrase),
      createdAt: Date.now(),
      ...(described.comment ? { comment: described.comment } : {})
    }, {
      privateKey: input.privateKey,
      ...(input.passphrase ? { passphrase: input.passphrase } : {})
    })
  }

  private store(metadata: KeyMetadata, record: PrivateKeyRecord): KeyMetadata {
    const id = `${VAULT_PREFIX}${metadata.id}`
    this.vault.put(id, Buffer.from(JSON.stringify(record), 'utf8'))
    this.keys.push(metadata)
    try {
      this.persist()
    } catch (error) {
      this.keys = this.keys.filter((key) => key.id !== metadata.id)
      try {
        this.vault.remove(id)
      } catch {
        /* ignore */
      }
      throw error
    }
    return metadata
  }

  getPrivateKey(id: string): PrivateKeyRecord {
    const raw = this.vault.get(`${VAULT_PREFIX}${id}`)
    if (!raw) throw new Error('密钥不存在或保险库中缺少私钥')
    try {
      const record = JSON.parse(raw.toString('utf8')) as PrivateKeyRecord
      if (!record || typeof record.privateKey !== 'string') throw new Error('invalid')
      return record
    } catch {
      throw new Error('密钥数据已损坏')
    }
  }

  remove(id: string): void {
    if (!this.get(id)) return
    this.vault.remove(`${VAULT_PREFIX}${id}`)
    this.keys = this.keys.filter((key) => key.id !== id)
    this.persist()
  }
}
