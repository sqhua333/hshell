import { useEffect, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

export interface ContextMenuItem {
  label: string
  icon?: string
  /** Shortcut hint shown on the right, e.g. `Ctrl+C`. */
  hint?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onClick?: () => void
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): ReactElement {
  useEffect(() => {
    const close = (): void => onClose()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', close)
      window.addEventListener('resize', close)
      window.addEventListener('keydown', key, true)
    }, 0)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])

  const left = Math.min(x, window.innerWidth - 210)
  const top = Math.min(y, window.innerHeight - items.length * 32 - 12)

  return createPortal(
    <div
      className="context-menu"
      style={{ left, top }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div className="context-sep" key={`sep-${index}`} />
        ) : (
          <button
            key={`${item.label}-${index}`}
            className={`context-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onClick?.()
            }}
          >
            {item.icon ? <Icon name={item.icon} size={15} /> : <span className="context-icon" />}
            <span>{item.label}</span>
            {item.hint ? <span className="context-hint">{item.hint}</span> : null}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
