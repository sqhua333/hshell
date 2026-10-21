import type { ReactElement } from 'react'
import { tr } from '../lib/i18n'
import { pastePreview } from '../lib/terminal-clipboard'
import { useApp } from '../store'
import { Modal } from './Modal'

/**
 * Confirmation for multi-line pastes. A shell executes every pasted newline,
 * so pasting without review can run a whole block of commands; VS Code guards
 * this the same way. Cancel has the initial focus to make Enter safe.
 */
export function PasteConfirmDialog(): ReactElement | null {
  const pending = useApp((state) => state.pasteConfirm)
  const confirmPaste = useApp((state) => state.confirmPaste)
  const cancelPaste = useApp((state) => state.cancelPaste)
  if (!pending) return null

  const preview = pastePreview(pending.text)
  return (
    <Modal
      title={tr('粘贴多行文本？', 'Paste multiple lines?')}
      subtitle={tr(
        `${preview.lines} 行 · ${preview.characters} 个字符`,
        `${preview.lines} lines · ${preview.characters} characters`
      )}
      width={560}
      onClose={cancelPaste}
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={cancelPaste} autoFocus>
            {tr('取消', 'Cancel')}
          </button>
          <button className="btn btn-primary" onClick={confirmPaste}>
            {tr('粘贴', 'Paste')}
          </button>
        </div>
      }
    >
      <div className="callout warn">
        {tr(
          '剪贴板内容包含换行。粘贴到终端后，其中的命令会立即执行，请先确认内容。',
          'The clipboard contains line breaks. Pasted commands run immediately, so review the text first.'
        )}
      </div>
      <pre className="paste-preview">{preview.text}</pre>
      {preview.truncated ? (
        <div className="form-hint">
          {tr(
            '预览已截断，粘贴的仍是完整内容。',
            'The preview is truncated; the complete text will be pasted.'
          )}
        </div>
      ) : null}
    </Modal>
  )
}
