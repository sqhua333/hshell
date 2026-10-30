import { useState, type ReactElement } from 'react'
import { sessionTarget } from '@shared/session'
import { tr } from '../lib/i18n'
import { setTabDragData } from '../lib/session-drag'
import { useApp } from '../store'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
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
  const duplicateTab = useApp((state) => state.duplicateTab)
  const openLocalShell = useApp((state) => state.openLocalShell)
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)

  if (tabs.length === 0) return null

  const menuItems = (tabId: string): ContextMenuItem[] => [
    {
      label: tr('复制标签页', 'Duplicate tab'),
      icon: 'copy',
      onClick: () => duplicateTab(tabId)
    },
    { label: '', separator: true },
    {
      label: tr('关闭标签页', 'Close tab'),
      icon: 'x',
      hint: 'Ctrl+W',
      onClick: () => closeTab(tabId)
    }
  ]

  return (
    <div className="tabbar">
      <div className="tabs-scroll">
        {tabs.map((tab) => {
          const status = statuses[tab.panes[0]?.runtimeId ?? '']?.status ?? 'idle'
          return (
            <div
              key={tab.id}
              className={`tab ${activeTabId === tab.id ? 'active' : ''}`}
              // Dragging a tab onto the terminal merges it into that tab as a
              // split, so two already-open sessions can be shown side by side.
              draggable
              data-tab-id={tab.id}
              title={tr(
                `${sessionTarget(tab.session)}（拖到终端分屏）`,
                `${sessionTarget(tab.session)} (drag onto a terminal to split)`
              )}
              onDragStart={(event) => setTabDragData(event.dataTransfer, tab.id)}
              onClick={() => activateTab(tab.id)}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ x: event.clientX, y: event.clientY, tabId: tab.id })
              }}
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
                draggable={false}
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
        // The tab bar's plus is deliberately not "new session": it opens the
        // current system's shell, like a terminal emulator's new-tab button.
        title={tr('打开本地终端', 'Open local terminal')}
        onClick={() => openLocalShell()}
      >
        <Icon name="plus" size={14} />
      </button>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.tabId)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}
