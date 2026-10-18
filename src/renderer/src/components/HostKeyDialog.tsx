import type { ReactElement } from 'react'
import { api } from '../api'
import { tr } from '../lib/i18n'
import { useApp } from '../store'
import { Icon } from './Icon'
import { Modal } from './Modal'

export function HostKeyDialog(): ReactElement | null {
  const hostKey = useApp((state) => state.hostKey)
  const setHostKey = useApp((state) => state.setHostKey)

  if (!hostKey) return null

  const decide = (accept: boolean): void => {
    void api.ssh.hostKeyDecision(hostKey.requestId, accept)
    setHostKey(null)
  }

  return (
    <Modal
      title={hostKey.changed ? tr('主机密钥已更改', 'Host key changed') : tr('未知主机密钥', 'Unknown host key')}
      width={580}
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={() => decide(false)}>
            {tr('拒绝', 'Reject')}
          </button>
          <button className="btn btn-primary" onClick={() => decide(true)}>
            {tr('接受并保存', 'Accept and save')}
          </button>
        </div>
      }
    >
      <div className={`callout ${hostKey.changed ? 'danger' : 'warn'}`}>
        <Icon name="alert-triangle" size={18} />
        <div>
          {hostKey.changed
            ? tr(
                '该主机的密钥与本地记录不一致。这可能是服务器重装，也可能是中间人攻击。除非你确认主机已更换密钥，否则请拒绝连接。',
                'The host key differs from the saved record. This may be a reinstalled server or a man-in-the-middle attack. Reject unless you are sure the host key changed.'
              )
            : tr(
                '这是第一次连接该主机。请核对下面的指纹是否与服务器管理员提供的一致。',
                'This is the first connection to this host. Verify the fingerprint below with your server administrator.'
              )}
        </div>
      </div>

      <div className="kv-list">
        <div className="kv">
          <span>{tr('主机', 'Host')}</span>
          <code>
            {hostKey.host}:{hostKey.port}
          </code>
        </div>
        <div className="kv">
          <span>{tr('算法', 'Algorithm')}</span>
          <code>{hostKey.algorithm}</code>
        </div>
        <div className="kv">
          <span>{tr('指纹', 'Fingerprint')}</span>
          <code className="fingerprint">{hostKey.fingerprint}</code>
        </div>
        {hostKey.changed && hostKey.oldFingerprint ? (
          <div className="kv">
            <span>{tr('原指纹', 'Previous fingerprint')}</span>
            <code className="fingerprint muted">{hostKey.oldFingerprint}</code>
          </div>
        ) : null}
      </div>

      <div className="form-hint">
        {tr(
          '接受后会把该密钥写入应用的 known_hosts 记录；下次连接将自动校验。',
          'Accepting stores this key in the application known_hosts record; future connections are verified automatically.'
        )}
      </div>
    </Modal>
  )
}
