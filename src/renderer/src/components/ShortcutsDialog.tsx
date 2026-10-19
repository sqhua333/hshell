import type { ReactElement } from 'react'
import { tr } from '../lib/i18n'
import { SHORTCUT_GROUPS } from '../lib/shortcuts'
import { useApp } from '../store'
import { Modal } from './Modal'

export function ShortcutsDialog(): ReactElement | null {
  const open = useApp((state) => state.shortcutsHelp)
  const setOpen = useApp((state) => state.setShortcutsHelp)
  const locale = useApp((state) => state.locale)
  if (!open) return null

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
                <kbd>{item.display}</kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="form-hint">
        {tr(
          '提示：终端中 Ctrl+C 仍然发送中断信号；复制请使用 Ctrl+Shift+C 或 Ctrl+Insert。',
          'Tip: Ctrl+C still sends SIGINT in the terminal; use Ctrl+Shift+C or Ctrl+Insert to copy.'
        )}
      </div>
    </Modal>
  )
}
