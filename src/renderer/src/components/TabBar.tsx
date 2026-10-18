import type { ReactElement } from 'react'
import { sessionTarget } from '@shared/session'
import { tr } from '../lib/i18n'
import { useApp } from '../store'
import { Icon } from './Icon'

const STATUS_COLORS: Record<string, string> = {
  connected: '#22c55e',
  connecting: '#f59e0b',
  authenticating: '#f59e0b',
  reconnecting: '#f59e0b',
  failed: '#ef4444',
  closed: '#94a3b8',
  idle: '#94a3b8'
}

export function TabBar(): ReactElement | null {
  const tabs = useApp((state) => state.tabs)
  const activeTabId = useApp((state) => state.activeTabId)
  const statuses = useApp((state) => state.statuses)
  const activateTab = useApp((state) => state.activateTab)
  const closeTab = useApp((state) => state.closeTab)
  const openSessionDialog = useApp((state) => state.openSessionDialog)

  if (tabs.length === 0) return null

  return (
    <div className="tabbar">
      <div className="tabs-scroll">
        {tabs.map((tab) => {
          const status = statuses[tab.panes[0]?.runtimeId ?? '']?.status ?? 'idle'
          return (
            <div
              key={tab.id}
              className={`tab ${activeTabId === tab.id ? 'active' : ''}`}
              title={sessionTarget(tab.session)}
              onClick={() => activateTab(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) closeTab(tab.id)
              }}
            >
              <span
                className="tab-status"
                style={{ background: STATUS_COLORS[status] ?? STATUS_COLORS.idle }}
              />
              <span className="tab-title">{tab.session.name}</span>
              <button
                className="tab-close"
                title={tr('关闭标签页 (Ctrl+W)', 'Close tab (Ctrl+W)')}
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        className="tab-add"
        title={tr('新建会话 (Ctrl+N)', 'New session (Ctrl+N)')}
        onClick={() => openSessionDialog(null)}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  )
}
