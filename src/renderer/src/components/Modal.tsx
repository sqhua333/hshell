import { useEffect, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { tr } from '../lib/i18n'
import { Icon } from './Icon'

interface ModalProps {
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose?: () => void
  width?: number
  className?: string
}

export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  width = 520,
  className
}: ModalProps): ReactElement {
  useEffect(() => {
    if (!onClose) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

  return createPortal(
    <div className="modal-backdrop">
      <div
        className={`modal ${className ?? ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <div className="modal-title">{title}</div>
            {subtitle ? <div className="modal-subtitle">{subtitle}</div> : null}
          </div>
          {onClose ? (
            <button className="icon-btn" onClick={onClose} title={tr('关闭', 'Close')}>
              <Icon name="x" />
            </button>
          ) : null}
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  )
}
