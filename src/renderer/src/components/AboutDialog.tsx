import type { ReactElement } from 'react'
import { isElectron } from '../api'
import { tr } from '../lib/i18n'
import { useApp } from '../store'
import { Icon } from './Icon'
import { Modal } from './Modal'

export function AboutDialog(): ReactElement | null {
  const open = useApp((state) => state.aboutOpen)
  const setOpen = useApp((state) => state.setAboutOpen)
  const version = useApp((state) => state.appVersion)
  if (!open) return null

  return (
    <Modal
      title={tr('关于 HShell', 'About HShell')}
      width={480}
      onClose={() => setOpen(false)}
      footer={
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={() => setOpen(false)}>
            {tr('关闭', 'Close')}
          </button>
        </div>
      }
    >
      <div className="about">
        <div className="about-logo">
          <Icon name="terminal" size={30} />
        </div>
        <div>
          <h3>HShell</h3>
          <p className="muted">
            {tr('跨平台 SSH / 串口客户端', 'Cross-platform SSH / serial client')} · {tr('版本', 'version')} {version}
          </p>
        </div>
      </div>
      <div className="kv-list">
        <div className="kv">
          <span>{tr('运行模式', 'Runtime')}</span>
          <code>{isElectron ? tr('Electron 桌面端', 'Electron desktop') : tr('浏览器演示模式', 'Browser demo')}</code>
        </div>
        <div className="kv">
          <span>{tr('技术栈', 'Stack')}</span>
          <code>Electron + React + xterm.js + ssh2</code>
        </div>
        <div className="kv">
          <span>{tr('会话存储', 'Session storage')}</span>
          <code>{tr('本地 userData（密码不落盘）', 'Local userData (passwords are never persisted)')}</code>
        </div>
      </div>
    </Modal>
  )
}
