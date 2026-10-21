export type ShortcutAction =
  | 'session:new'
  | 'session:open'
  | 'tab:new'
  | 'tab:close'
  | 'tab:next'
  | 'tab:prev'
  | 'tab:select'
  | 'edit:copy'
  | 'edit:paste'
  | 'edit:find'
  | 'edit:clear'
  | 'view:sidebar'
  | 'view:sftp'
  | 'view:theme'
  | 'ssh:reconnect'
  | 'ssh:disconnect'
  | 'pane:split-h'
  | 'pane:split-v'
  | 'font:inc'
  | 'font:dec'
  | 'font:reset'
  | 'window:fullscreen'
  | 'help:shortcuts'
  | 'help:about'
  | 'dialog:close'
  | 'tools:tunnels'
  | 'tools:keys'
  | 'tools:compose'
  | 'tools:record'

export interface ShortcutMatch {
  action: ShortcutAction
  digit?: number
}

export interface ShortcutDef {
  combo: string
  action: ShortcutAction
  label: string
  labelEn: string
  display: string
  /** Displayed instead of `display` on macOS. */
  displayMac?: string
  /**
   * Contextual shortcuts (handled by the terminal, not the global key map).
   * They are listed in the help dialog but never registered globally.
   */
  infoOnly?: boolean
}

export interface ShortcutGroup {
  title: string
  titleEn: string
  items: ShortcutDef[]
}

// 默认快捷键。组合键统一小写，mod = Ctrl（macOS 上为 Cmd）。
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '会话与标签', titleEn: 'Sessions & tabs',
    items: [
      { combo: 'mod+n', action: 'session:new', label: '新建会话', labelEn: 'New session', display: 'Ctrl+N' },
      { combo: 'mod+o', action: 'session:open', label: '打开会话管理器', labelEn: 'Open session manager', display: 'Ctrl+O' },
      { combo: 'mod+t', action: 'tab:new', label: '新建标签页', labelEn: 'New tab', display: 'Ctrl+T' },
      { combo: 'mod+w', action: 'tab:close', label: '关闭当前分屏 / 标签页', labelEn: 'Close split pane / tab', display: 'Ctrl+W' },
      { combo: 'mod+tab', action: 'tab:next', label: '下一个标签页', labelEn: 'Next tab', display: 'Ctrl+Tab' },
      { combo: 'mod+shift+tab', action: 'tab:prev', label: '上一个标签页', labelEn: 'Previous tab', display: 'Ctrl+Shift+Tab' },
      { combo: 'mod+shift+w', action: 'ssh:disconnect', label: '断开当前连接', labelEn: 'Disconnect', display: 'Ctrl+Shift+W' },
      { combo: 'mod+shift+r', action: 'ssh:reconnect', label: '重新连接', labelEn: 'Reconnect', display: 'Ctrl+Shift+R' }
    ]
  },
  {
    title: '终端', titleEn: 'Terminal',
    items: [
      { combo: 'mod+c', action: 'edit:copy', infoOnly: true, label: '有选中内容时复制', labelEn: 'Copy when text is selected', display: 'Ctrl+C', displayMac: 'Cmd+C' },
      { combo: 'mod+v', action: 'edit:paste', infoOnly: true, label: '粘贴', labelEn: 'Paste', display: 'Ctrl+V', displayMac: 'Cmd+V' },
      { combo: 'mod+shift+c', action: 'edit:copy', label: '复制选中内容', labelEn: 'Copy selection', display: 'Ctrl+Shift+C' },
      { combo: 'mod+insert', action: 'edit:copy', label: '复制选中内容', labelEn: 'Copy selection', display: 'Ctrl+Insert' },
      { combo: 'mod+shift+v', action: 'edit:paste', label: '粘贴', labelEn: 'Paste', display: 'Ctrl+Shift+V' },
      { combo: 'shift+insert', action: 'edit:paste', label: '粘贴', labelEn: 'Paste', display: 'Shift+Insert' },
      { combo: 'mod+shift+f', action: 'edit:find', label: '在终端中查找', labelEn: 'Find in terminal', display: 'Ctrl+Shift+F' },
      { combo: 'mod+shift+k', action: 'edit:clear', label: '清屏', labelEn: 'Clear screen', display: 'Ctrl+Shift+K' },
      { combo: 'mod+shift+s', action: 'pane:split-h', label: '水平分屏', labelEn: 'Split horizontally', display: 'Ctrl+Shift+S' },
      { combo: 'mod+shift+d', action: 'pane:split-v', label: '垂直分屏', labelEn: 'Split vertically', display: 'Ctrl+Shift+D' },
      { combo: 'mod+shift+m', action: 'tools:compose', label: '撰写窗格', labelEn: 'Compose pane', display: 'Ctrl+Shift+M' },
      { combo: 'mod+alt+r', action: 'tools:record', label: '录制 / 停止录制', labelEn: 'Record / stop recording', display: 'Ctrl+Alt+R' }
    ]
  },
  {
    title: '界面与显示', titleEn: 'Interface & display',
    items: [
      { combo: 'mod+b', action: 'view:sidebar', label: '显示/隐藏会话管理器', labelEn: 'Toggle session manager', display: 'Ctrl+B' },
      { combo: 'mod+shift+e', action: 'view:sftp', label: '显示/隐藏 SFTP 面板', labelEn: 'Toggle SFTP panel', display: 'Ctrl+Shift+E' },
      { combo: 'mod+=', action: 'font:inc', label: '放大终端字体', labelEn: 'Increase font size', display: 'Ctrl++' },
      { combo: 'mod+-', action: 'font:dec', label: '缩小终端字体', labelEn: 'Decrease font size', display: 'Ctrl+-' },
      { combo: 'mod+0', action: 'font:reset', label: '重置终端字体', labelEn: 'Reset font size', display: 'Ctrl+0' },
      { combo: 'alt+enter', action: 'window:fullscreen', label: '切换全屏', labelEn: 'Toggle full screen', display: 'Alt+Enter' },
      { combo: 'f11', action: 'window:fullscreen', label: '切换全屏', labelEn: 'Toggle full screen', display: 'F11' },
      { combo: 'f1', action: 'help:shortcuts', label: '快捷键帮助', labelEn: 'Keyboard shortcuts', display: 'F1' },
      { combo: 'escape', action: 'dialog:close', label: '关闭对话框/提示', labelEn: 'Close dialog / notice', display: 'Esc' },
      { combo: 'alt+1…9', action: 'tab:select', label: '切换到第 N 个标签页', labelEn: 'Switch to tab N', display: 'Alt+1 … Alt+9' }
    ]
  }
]

const COMBO_MAP = new Map<string, ShortcutAction>()
for (const group of SHORTCUT_GROUPS) {
  for (const item of group.items) {
    if (!item.infoOnly && !item.combo.includes('…')) {
      COMBO_MAP.set(item.combo, item.action)
    }
  }
}

function comboOf(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('mod')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  let key = event.key.toLowerCase()
  if (key === '+') key = '='
  if (key === ' ') key = 'space'
  // Ctrl+Shift+= / Ctrl+Shift+- are the shifted variants of Ctrl+= / Ctrl+-.
  if ((key === '=' || key === '-') && parts.includes('shift')) {
    parts.splice(parts.indexOf('shift'), 1)
  }
  parts.push(key)
  return parts.join('+')
}

export function matchShortcut(event: KeyboardEvent): ShortcutMatch | null {
  if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key)) {
    return { action: 'tab:select', digit: Number(event.key) }
  }
  const action = COMBO_MAP.get(comboOf(event))
  return action ? { action } : null
}

/** Text inputs keep native editing shortcuts; xterm's hidden textarea is not one of them. */
export function isEditingField(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  if (target.classList.contains('xterm-helper-textarea')) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}
