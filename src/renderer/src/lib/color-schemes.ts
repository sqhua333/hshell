import type { ITheme } from '@xterm/xterm'
import type { TerminalTheme } from '@shared/types'

export interface ColorScheme {
  id: string
  name: string
  nameEn: string
  dark: boolean
  theme: ITheme
}

/** Built-in terminal palettes. Keep ids stable: they are stored in sessions. */
export const COLOR_SCHEMES: ColorScheme[] = [
  {
    id: 'hshell-dark',
    name: 'HShell 深色',
    nameEn: 'HShell Dark',
    dark: true,
    theme: {
      background: '#0f1115',
      foreground: '#e6edf3',
      cursor: '#7cc4ff',
      cursorAccent: '#0f1115',
      selectionBackground: '#2d4f74',
      black: '#1b1f27',
      red: '#ff6b6b',
      green: '#7ee787',
      yellow: '#f2cc60',
      blue: '#6cb6ff',
      magenta: '#d2a8ff',
      cyan: '#76e3ea',
      white: '#e6edf3',
      brightBlack: '#6e7681',
      brightRed: '#ff8f8f',
      brightGreen: '#a5f3b0',
      brightYellow: '#ffe08a',
      brightBlue: '#9ccaff',
      brightMagenta: '#e2c4ff',
      brightCyan: '#a5f0f4',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'hshell-light',
    name: 'HShell 浅色',
    nameEn: 'HShell Light',
    dark: false,
    theme: {
      background: '#ffffff',
      foreground: '#1f2937',
      cursor: '#1a73e8',
      cursorAccent: '#ffffff',
      selectionBackground: '#cfe3ff',
      black: '#1f2937',
      red: '#c62828',
      green: '#2e7d32',
      yellow: '#a16207',
      blue: '#1a73e8',
      magenta: '#8e24aa',
      cyan: '#00796b',
      white: '#f5f5f5',
      brightBlack: '#6b7280',
      brightRed: '#e53935',
      brightGreen: '#43a047',
      brightYellow: '#ca8a04',
      brightBlue: '#4285f4',
      brightMagenta: '#ab47bc',
      brightCyan: '#00acc1',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'solarized-dark',
    name: 'Solarized 深色',
    nameEn: 'Solarized Dark',
    dark: true,
    theme: {
      background: '#002b36',
      foreground: '#93a1a1',
      cursor: '#b58900',
      cursorAccent: '#002b36',
      selectionBackground: '#0f4a5c',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#93a1a1',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'solarized-light',
    name: 'Solarized 浅色',
    nameEn: 'Solarized Light',
    dark: false,
    theme: {
      background: '#fdf6e3',
      foreground: '#586e75',
      cursor: '#b58900',
      cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#93a1a1',
      brightRed: '#cb4b16',
      brightGreen: '#2aa198',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    nameEn: 'Dracula',
    dark: true,
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    nameEn: 'Nord',
    dark: true,
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#d06f79',
      brightGreen: '#b1d196',
      brightYellow: '#f0d399',
      brightBlue: '#8fafd1',
      brightMagenta: '#c895bd',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    }
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox 深色',
    nameEn: 'Gruvbox Dark',
    dark: true,
    theme: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: '#504945',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2'
    }
  },
  {
    id: 'monokai',
    name: 'Monokai',
    nameEn: 'Monokai',
    dark: true,
    theme: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      cursorAccent: '#272822',
      selectionBackground: '#49483e',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#f4bf75',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#f4bf75',
      brightBlue: '#66d9ef',
      brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4',
      brightWhite: '#f9f8f5'
    }
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    nameEn: 'One Dark',
    dark: true,
    theme: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      cursorAccent: '#282c34',
      selectionBackground: '#3e4451',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'classic-green',
    name: '经典绿字',
    nameEn: 'Classic Green',
    dark: true,
    theme: {
      background: '#000000',
      foreground: '#33ff33',
      cursor: '#33ff33',
      cursorAccent: '#000000',
      selectionBackground: '#145214',
      black: '#000000',
      red: '#ff5555',
      green: '#33ff33',
      yellow: '#ffff55',
      blue: '#5555ff',
      magenta: '#ff55ff',
      cyan: '#55ffff',
      white: '#bbbbbb',
      brightBlack: '#555555',
      brightRed: '#ff5555',
      brightGreen: '#55ff55',
      brightYellow: '#ffff55',
      brightBlue: '#5555ff',
      brightMagenta: '#ff55ff',
      brightCyan: '#55ffff',
      brightWhite: '#ffffff'
    }
  }
]

const BY_ID = new Map(COLOR_SCHEMES.map((scheme) => [scheme.id, scheme]))

const LEGACY: Record<TerminalTheme, string> = {
  dark: 'hshell-dark',
  light: 'hshell-light',
  solarized: 'solarized-dark'
}

export function findColorScheme(id: string | undefined | null): ColorScheme | undefined {
  return id ? BY_ID.get(id) : undefined
}

export function resolveColorScheme(
  colorScheme?: string,
  legacyTheme?: TerminalTheme
): ColorScheme {
  return (
    findColorScheme(colorScheme) ??
    findColorScheme(legacyTheme ? LEGACY[legacyTheme] : undefined) ??
    COLOR_SCHEMES[0]
  )
}

/** Legacy `theme` value persisted alongside the scheme for older builds. */
export function legacyThemeForScheme(id: string): TerminalTheme {
  const scheme = findColorScheme(id)
  if (!scheme) return 'dark'
  if (scheme.id === 'solarized-dark' || scheme.id === 'solarized-light') return 'solarized'
  return scheme.dark ? 'dark' : 'light'
}
