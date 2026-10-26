import type { ReactElement } from 'react'
import { api } from '../api'
import { tr } from '../lib/i18n'
import { SHORTCUT_GROUPS } from '../lib/shortcuts'
import { useApp } from '../store'
import { Modal } from './Modal'

export function ShortcutsDialog(): ReactElement | null {
  const open = useApp((state) => state.shortcutsHelp)
  const setOpen = useApp((state) => state.setShortcutsHelp)
  const locale = useApp((state) => state.locale)
  if (!open) return null
  const isMac = api.app.platform === 'darwin'
  const copyKey = isMac ? 'Cmd+C' : 'Ctrl+C'
  const shiftCopyKey = isMac ? 'Cmd+Shift+C' : 'Ctrl+Shift+C'

  return (
    <Modal
      title={tr('键盘快捷键', 'Keyboard shortcuts')}
      subtitle={tr('默认快捷键', 'Default shortcuts')}
      width={700}
      onClose={() => setOpen(false)}
      footer={
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={() => setOpen(false)}>
            {tr('关闭', 'Close')}
          </button>
        </div>
      }
    >
      <div className="shortcut-groups">
        {SHORTCUT_GROUPS.map((group) => (
          <section className="shortcut-group" key={group.title}>
            <h4>{locale === 'en' ? group.titleEn : group.title}</h4>
            {group.items.map((item) => (
              <div className="shortcut-row" key={`${item.action}-${item.combo}`}>
                <span>{locale === 'en' ? item.labelEn : item.label}</span>
                <kbd>{isMac && item.displayMac ? item.displayMac : item.display}</kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="form-hint">
        {tr(
          `提示：终端中选中文本后 ${copyKey} 复制，未选中时 Ctrl+C 发送中断；${shiftCopyKey} 始终复制。右键粘贴，Shift+右键打开菜单。多行粘贴会先确认。`,
          `Tip: ${copyKey} copies selected text in the terminal and Ctrl+C sends SIGINT when nothing is selected; ${shiftCopyKey} always copies. Right-click pastes; Shift+right-click opens the menu. Multi-line pastes ask for confirmation.`
        )}
      </div>
    </Modal>
  )
}
