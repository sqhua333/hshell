import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { KeyAlgorithm, KeyMetadata, VaultStatus } from '@shared/types'
import { isNonSshSession } from '@shared/session'
import { api } from '../api'
import { tr } from '../lib/i18n'
import { sessionForRuntime, useApp } from '../store'
import { Icon } from './Icon'
import { Modal } from './Modal'

const ALGORITHM_LABEL: Record<KeyAlgorithm, string> = {
  rsa: 'RSA',
  ecdsa: 'ECDSA',
  ed25519: 'Ed25519'
}

export function KeysDialog(): ReactElement | null {
  const open = useApp((state) => state.keysOpen)
  if (!open) return null
  return <KeysDialogInner />
}

function KeysDialogInner(): ReactElement {
  const setOpen = useApp((state) => state.setKeysOpen)
  const addToast = useApp((state) => state.addToast)
  const activeRuntimeId = useApp((state) => state.activeRuntimeId)
  const activeStatus = useApp((state) =>
    state.activeRuntimeId ? state.statuses[state.activeRuntimeId]?.status : undefined
  )
  const nonSshActive = useApp((state) =>
    isNonSshSession(sessionForRuntime(state.activeRuntimeId, state))
  )

  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [keys, setKeys] = useState<KeyMetadata[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const [label, setLabel] = useState('')
  const [algorithm, setAlgorithm] = useState<KeyAlgorithm>('ed25519')
  const [bits, setBits] = useState('3072')
  const [passphrase, setPassphrase] = useState('')

  const [importLabel, setImportLabel] = useState('')
  const [importKey, setImportKey] = useState('')
  const [importPassphrase, setImportPassphrase] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const [vaultStatus, list] = await Promise.all([api.vault.status(), api.keys.list()])
    setStatus(vaultStatus)
    setKeys(list)
  }, [])

  useEffect(() => {
    void refresh().catch((err) => setError((err as Error).message))
  }, [refresh])

  const run = async (task: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const unlock = (): Promise<void> =>
    run(async () => {
      if (!password) {
        setError(tr('请输入主密码', 'Please enter the master password'))
        return
      }
      if (!status?.initialized && password.length < 8) {
        setError(tr('主密码至少需要 8 位', 'The master password must be at least 8 characters'))
        return
      }
      if (!status?.initialized && password !== confirm) {
        setError(tr('两次输入的主密码不一致', 'The master passwords do not match'))
        return
      }
      await api.vault.unlock(password)
      setPassword('')
      setConfirm('')
      await refresh()
      addToast(
        'info',
        status?.initialized ? tr('保险库已解锁', 'Vault unlocked') : tr('主密码已设置', 'Master password set')
      )
    })

  const lock = (): Promise<void> =>
    run(async () => {
      await api.vault.lock()
      setKeys([])
      await refresh()
    })

  const generate = (): Promise<void> =>
    run(async () => {
      const key = await api.keys.generate({
        label: label.trim() || `hshell-${algorithm}`,
        algorithm,
        ...(algorithm === 'ed25519' ? {} : { bits: Number(bits) }),
        ...(passphrase ? { passphrase } : {})
      })
      setLabel('')
      setPassphrase('')
      await refresh()
      addToast('info', tr(`已生成密钥「${key.label}」`, `Generated key "${key.label}"`))
    })

  const importKeyFile = (): Promise<void> =>
    run(async () => {
      if (!importKey.trim()) {
        setError(tr('请粘贴私钥内容', 'Please paste the private key'))
        return
      }
      const key = await api.keys.import({
        label: importLabel.trim() || `imported-${Date.now()}`,
        privateKey: importKey,
        ...(importPassphrase ? { passphrase: importPassphrase } : {})
      })
      setImportLabel('')
      setImportKey('')
      setImportPassphrase('')
      await refresh()
      addToast('info', tr(`已导入密钥「${key.label}」`, `Imported key "${key.label}"`))
    })

  const copyPublicKey = (key: KeyMetadata): Promise<void> =>
    run(async () => {
      await api.clipboard.writeText(key.publicKey)
      addToast('info', tr('公钥已复制', 'Public key copied'))
    })

  const install = (key: KeyMetadata): Promise<void> =>
    run(async () => {
      if (!activeRuntimeId) return
      await api.keys.install(activeRuntimeId, key.id)
      addToast(
        'info',
        tr(`公钥已安装到当前服务器（${key.label}）`, `Public key installed on the current server (${key.label})`)
      )
    })

  const remove = (key: KeyMetadata): Promise<void> =>
    run(async () => {
      if (
        !window.confirm(
          tr(
            `确定删除密钥「${key.label}」吗？远程服务器上的公钥不会自动移除。`,
            `Delete key "${key.label}"? The public key on remote servers is not removed automatically.`
          )
        )
      ) {
        return
      }
      await api.keys.remove(key.id)
      await refresh()
      addToast('info', tr('密钥已删除', 'Key deleted'))
    })

  const locked = status?.mode === 'password' && !status.unlocked
  const initializing = locked && !status.initialized
  const connected = activeStatus === 'connected' && !nonSshActive
  const bitsOptions = algorithm === 'rsa' ? ['3072', '4096'] : ['256', '384', '521']

  return (
    <Modal
      title={tr('密钥管理', 'Key manager')}
      subtitle={
        status?.mode === 'safeStorage'
          ? tr('使用系统密钥环加密私钥', 'Private keys are encrypted with the system keychain')
          : tr(
              '主密码 + scrypt / AES-256-GCM 加密私钥',
              'Private keys are encrypted with a master password (scrypt / AES-256-GCM)'
            )
      }
      width={780}
      onClose={() => setOpen(false)}
    >
      {error ? <div className="form-error key-error">{error}</div> : null}

      {locked ? (
        <div className="vault-unlock">
          <div className="section-title">{initializing ? tr('设置主密码', 'Set master password') : tr('解锁保险库', 'Unlock vault')}</div>
          <p className="form-hint">
            {initializing
              ? tr(
                  '首次使用需要设置一个至少 8 位的主密码，用于加密保存在本地的私钥。密码无法找回。',
                  'On first use, set a master password of at least 8 characters to encrypt locally stored private keys. It cannot be recovered.'
                )
              : tr(
                  '输入的密码仅用于本地解密，不会离开这台电脑。',
                  'The password is only used for local decryption and never leaves this computer.'
                )}
          </p>
          <label className="field">
            <span>{tr('主密码', 'Master password')}</span>
            <input
              className="input"
              type="password"
              value={password}
              autoFocus
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void unlock()
              }}
            />
          </label>
          {initializing ? (
            <label className="field">
              <span>{tr('确认主密码', 'Confirm master password')}</span>
              <input
                className="input"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
          ) : null}
          <button className="btn btn-primary" disabled={busy} onClick={() => void unlock()}>
            {initializing ? tr('设置并解锁', 'Set and unlock') : tr('解锁', 'Unlock')}
          </button>
        </div>
      ) : (
        <>
          <div className="keys-toolbar">
            <div className="keys-toolbar-title">
              <span className="section-title">{tr('已保存的密钥', 'Saved keys')}</span>
              <span className="tag">{keys.length}</span>
            </div>
            {status?.mode === 'password' ? (
              <button className="btn btn-ghost" onClick={() => void lock()} disabled={busy}>
                <Icon name="lock" size={14} />
                {tr('锁定', 'Lock')}
              </button>
            ) : null}
          </div>

          {keys.length === 0 ? (
            <div className="tree-empty">{tr('还没有密钥。生成或导入一个私钥后即可用于连接。', 'No keys yet. Generate or import a private key to use for connections.')}</div>
          ) : (
            <div className="key-list">
              {keys.map((key) => (
                <div className="key-row" key={key.id}>
                  <div className="key-main">
                    <div className="key-title">
                      <Icon name="key" size={15} />
                      <strong>{key.label}</strong>
                      <span className="tag">
                        {ALGORITHM_LABEL[key.algorithm]}
                        {key.bits ? ` ${key.bits}` : ''}
                      </span>
                      {key.hasPassphrase ? <span className="tag">{tr('有口令', 'Passphrase')}</span> : null}
                    </div>
                    <div className="key-fingerprint" title={tr('SHA256 指纹', 'SHA256 fingerprint')}>
                      {key.fingerprint}
                    </div>
                  </div>
                  <div className="key-actions">
                    <button
                      className="btn btn-ghost"
                      title={tr('复制公钥', 'Copy public key')}
                      onClick={() => void copyPublicKey(key)}
                    >
                      <Icon name="copy" size={14} />
                    </button>
                    <button
                      className="btn btn-ghost"
                      title={
                        connected
                          ? tr('安装到当前连接的服务器', 'Install on the connected server')
                          : nonSshActive
                            ? tr('安装公钥需要 SSH 会话', 'Installing public keys requires an SSH session')
                            : tr('需要先连接一个会话才能安装公钥', 'Connect a session before installing a public key')
                      }
                      disabled={!connected || busy}
                      onClick={() => void install(key)}
                    >
                      <Icon name="upload" size={14} />
                    </button>
                    <button
                      className="btn btn-ghost danger"
                      title={tr('删除密钥', 'Delete key')}
                      disabled={busy}
                      onClick={() => void remove(key)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="keys-columns">
            <section className="keys-panel">
              <div className="section-title">{tr('生成新密钥', 'Generate a new key')}</div>
              <label className="field">
                <span>{tr('名称', 'Name')}</span>
                <input
                  className="input"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={`hshell-${algorithm}`}
                />
              </label>
              <div className="form-grid">
                <label className="field">
                  <span>{tr('算法', 'Algorithm')}</span>
                  <select
                    className="input"
                    value={algorithm}
                    onChange={(event) => {
                      const next = event.target.value as KeyAlgorithm
                      setAlgorithm(next)
                      setBits(next === 'rsa' ? '3072' : '256')
                    }}
                  >
                    <option value="ed25519">{tr('Ed25519（推荐）', 'Ed25519 (recommended)')}</option>
                    <option value="ecdsa">ECDSA</option>
                    <option value="rsa">RSA</option>
                  </select>
                </label>
                {algorithm !== 'ed25519' ? (
                  <label className="field">
                    <span>{tr('长度', 'Size')}</span>
                    <select
                      className="input"
                      value={bits}
                      onChange={(event) => setBits(event.target.value)}
                    >
                      {bitsOptions.map((value) => (
                        <option key={value} value={value}>
                          {value} bit
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              <label className="field">
                <span>{tr('私钥口令（可选）', 'Key passphrase (optional)')}</span>
                <input
                  className="input"
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </label>
              <button className="btn btn-primary" disabled={busy} onClick={() => void generate()}>
                {tr('生成密钥', 'Generate key')}
              </button>
            </section>

            <section className="keys-panel">
              <div className="section-title">{tr('导入现有私钥', 'Import an existing private key')}</div>
              <label className="field">
                <span>{tr('名称', 'Name')}</span>
                <input
                  className="input"
                  value={importLabel}
                  onChange={(event) => setImportLabel(event.target.value)}
                  placeholder={tr('例如：work-laptop', 'e.g. work-laptop')}
                />
              </label>
              <label className="field">
                <span>{tr('私钥内容', 'Private key')}</span>
                <textarea
                  className="input key-textarea"
                  value={importKey}
                  onChange={(event) => setImportKey(event.target.value)}
                  placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>{tr('私钥口令（可选）', 'Key passphrase (optional)')}</span>
                <input
                  className="input"
                  type="password"
                  value={importPassphrase}
                  onChange={(event) => setImportPassphrase(event.target.value)}
                />
              </label>
              <button className="btn btn-primary" disabled={busy} onClick={() => void importKeyFile()}>
                {tr('导入密钥', 'Import key')}
              </button>
            </section>
          </div>
        </>
      )}
    </Modal>
  )
}
