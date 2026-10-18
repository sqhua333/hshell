import type { Terminal } from '@xterm/xterm'
import type { SearchAddon } from '@xterm/addon-search'

export interface TerminalHandle {
  runtimeId: string
  terminal: Terminal
  search: SearchAddon
  focus(): void
  fit(): void
}

const registry = new Map<string, TerminalHandle>()

export function registerTerminal(handle: TerminalHandle): () => void {
  registry.set(handle.runtimeId, handle)
  return () => {
    if (registry.get(handle.runtimeId) === handle) registry.delete(handle.runtimeId)
  }
}

export function getTerminal(runtimeId: string | null | undefined): TerminalHandle | undefined {
  return runtimeId ? registry.get(runtimeId) : undefined
}
