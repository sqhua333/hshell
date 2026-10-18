import type { ReactElement } from 'react'
import { tr } from '../lib/i18n'
import { useApp } from '../store'
import { Icon } from './Icon'

export function Toasts(): ReactElement {
  const toasts = useApp((state) => state.toasts)
  const removeToast = useApp((state) => state.removeToast)

  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div
          className={`toast toast-${toast.level}`}
          key={toast.id}
          title={tr('点击或按 Esc 关闭', 'Click or press Esc to dismiss')}
          onClick={() => removeToast(toast.id)}
        >
          <Icon
            name={toast.level === 'error' ? 'alert-triangle' : toast.level === 'warn' ? 'info' : 'check'}
            size={16}
          />
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  )
}
