import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { Language } from '@shared/types'

function send(action: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('hshell:event', { type: 'menu:action', action })
}

export function createMenu(locale: Language = 'zh'): void {
  const en = locale === 'en'
  const template: MenuItemConstructorOptions[] = [
    {
      label: en ? 'File' : '文件',
      submenu: [
        {
          label: en ? 'New Session…' : '新建会话…',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('session:new')
        },
        {
          label: en ? 'New Tab' : '新建标签页',
          accelerator: 'CmdOrCtrl+T',
          click: () => send('tab:new')
        },
        {
          label: en ? 'Close Split Pane / Tab' : '关闭分屏 / 标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => send('tab:close')
        },
        { type: 'separator' },
        {
          label: en ? 'Reconnect' : '重新连接',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => send('ssh:reconnect')
        },
        { label: en ? 'Disconnect' : '断开连接', click: () => send('ssh:disconnect') },
        { type: 'separator' },
        { label: en ? 'Quit' : '退出', role: 'quit' }
      ]
    },
    {
      label: en ? 'Edit' : '编辑',
      submenu: [
        {
          label: en ? 'Copy' : '复制',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => send('edit:copy')
        },
        {
          label: en ? 'Paste' : '粘贴',
          accelerator: 'CmdOrCtrl+Shift+V',
          click: () => send('edit:paste')
        },
        {
          label: en ? 'Clear' : '清屏',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => send('edit:clear')
        },
        { type: 'separator' },
        {
          label: en ? 'Find…' : '查找…',
          accelerator: 'CmdOrCtrl+F',
          click: () => send('edit:find')
        }
      ]
    },
    {
      label: en ? 'View' : '查看',
      submenu: [
        {
          label: en ? 'Session Manager' : '会话管理器',
          accelerator: 'CmdOrCtrl+B',
          click: () => send('view:sidebar')
        },
        {
          label: en ? 'SFTP Panel' : 'SFTP 面板',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => send('view:sftp')
        },
        { type: 'separator' },
        {
          label: en ? 'Split Horizontally' : '水平分屏',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => send('pane:split-h')
        },
        { label: en ? 'Split Vertically' : '垂直分屏', click: () => send('pane:split-v') },
        { type: 'separator' },
        {
          label: en ? 'Increase Font Size' : '放大字体',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => send('font:inc')
        },
        {
          label: en ? 'Decrease Font Size' : '缩小字体',
          accelerator: 'CmdOrCtrl+-',
          click: () => send('font:dec')
        },
        {
          label: en ? 'Reset Font Size' : '重置字体',
          accelerator: 'CmdOrCtrl+0',
          click: () => send('font:reset')
        },
        { type: 'separator' },
        { label: en ? 'Toggle Light/Dark UI' : '切换深/浅界面', click: () => send('view:theme') },
        { label: en ? 'Reload Interface' : '重新加载界面', role: 'reload' }
      ]
    },
    {
      label: en ? 'Tools' : '工具',
      submenu: [
        { label: en ? 'Port Forwarding…' : '端口转发…', click: () => send('tools:tunnels') },
        { label: en ? 'Key Manager…' : '密钥管理…', click: () => send('tools:keys') },
        { type: 'separator' },
        {
          label: en ? 'Compose Pane' : '撰写窗格',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => send('tools:compose')
        },
        {
          label: en ? 'Record / Stop Recording' : '录制 / 停止录制',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => send('tools:record')
        }
      ]
    },
    {
      label: en ? 'Help' : '帮助',
      submenu: [
        {
          label: en ? 'Keyboard Shortcuts' : '键盘快捷键',
          accelerator: 'F1',
          click: () => send('help:shortcuts')
        },
        { type: 'separator' },
        {
          label: en ? 'About HShell' : '关于 HShell',
          click: () => send('help:about')
        }
      ]
    }
  ]

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
