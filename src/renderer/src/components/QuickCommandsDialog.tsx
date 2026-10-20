import { useState, type ReactElement } from 'react'
import type { QuickCommand } from '@shared/types'
import { tr } from '../lib/i18n'
import { QUICK_COMMAND_MAX } from '../lib/quick-commands'
import { useApp } from '../store'
import { Icon } from './Icon'
import { Modal } from './Modal'

function draftId(): string {
  return `qc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function QuickCommandsDialog(): ReactElement | null {
  const open = useApp((state) => state.quickCommandsOpen)
  if (!open) return null
  return <QuickCommandsDialogInner />
}

function QuickCommandsDialogInner(): ReactElement {
  const setOpen = useApp((state) => state.setQuickCommandsOpen)
  const saveQuickCommands = useApp((state) => state.saveQuickCommands)
  const [items, setItems] = useState<QuickCommand[]>(() =>
    useApp.getState().quickCommands.map((item) => ({ ...item }))
  )
  const [error, setError] = useState('')

  const update = (id: string, patch: Partial<QuickCommand>): void =>
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))

  const submit = (): void => {
    const filled = items.filter((item) => item.label.trim() || item.command.trim())
    if (filled.some((item) => !item.label.trim() || !item.command.trim())) {
      setError(
        tr(
          '每条快速命令都需要同时填写名称和命令',
          'Each quick command needs both a label and a command'
        )
      )
      return
    }
    saveQuickCommands(filled)
    setOpen(false)
  }

  return (
    <Modal
      title={tr('快速命令', 'Quick commands')}
      subtitle={tr('全局配置，显示在所有会话的底部命令栏', 'Global, shown in every session bottom bar')}
      width={680}
      onClose={() => setOpen(false)}
      footer={
        <>
          {error ? <div className="form-error">{error}</div> : <div />}
          <div className="modal-actions">
            <button className="btn" onClick={() => setOpen(false)}>
              {tr('取消', 'Cancel')}
            </button>
            <button className="btn btn-primary" onClick={submit}>
              {tr('保存', 'Save')}
            </button>
          </div>
        </>
      }
    >
      <div className="form-hint">
        {tr(
          '快速命令保存在本机并应用到所有会话，点击按钮即可把命令发送到当前终端。',
          'Quick commands are stored locally and shared by every session; click a button to send it to the active terminal.'
        )}
      </div>
      <div className="rule-list">
        {items.map((item) => (
          <div className="rule-row quick-row" key={item.id}>
            <input
              className="input"
              value={item.label}
              onChange={(event) => update(item.id, { label: event.target.value })}
              placeholder={tr('按钮名称', 'Button label')}
            />
            <input
              className="input"
              value={item.command}
              onChange={(event) => update(item.id, { command: event.target.value })}
              placeholder={tr('要发送的命令', 'Command to send')}
              spellCheck={false}
            />
            <label className="mini-check">
              <input
                type="checkbox"
                checked={item.sendEnter !== false}
                onChange={(event) => update(item.id, { sendEnter: event.target.checked })}
              />
              {tr('附加回车', 'Enter')}
            </label>
            <button
              className="icon-btn mini danger"
              title={tr('删除', 'Delete')}
              onClick={() => setItems((list) => list.filter((entry) => entry.id !== item.id))}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="btn"
        disabled={items.length >= QUICK_COMMAND_MAX}
        onClick={() =>
          setItems((list) => [
            ...list,
            { id: draftId(), label: '', command: '', sendEnter: true }
          ])
        }
      >
        <Icon name="plus" size={14} />
        {tr('添加快速命令', 'Add quick command')}
      </button>
    </Modal>
  )
}
