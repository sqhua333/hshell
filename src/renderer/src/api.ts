import type { HshellApi } from '@shared/types'
import { createMockApi } from './mock'

declare global {
  interface Window {
    hshell?: HshellApi
  }
}

export const isElectron = typeof window !== 'undefined' && Boolean(window.hshell)

export const api: HshellApi = window.hshell ?? createMockApi()
