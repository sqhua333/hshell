import type { Session } from '@shared/types'

export interface CredentialLookup {
  get(id: string): string | null | undefined
}

export function sessionCredentialId(sessionId: string): string {
  return `session:${sessionId}`
}

export function jumpCredentialId(sessionId: string, jumpId: string): string {
  return `jump:${sessionId}:${jumpId}`
}

/**
 * Fill in passwords that were saved encrypted on disk. Explicit values from
 * the renderer always win; saved jump credentials are restored per hop.
 */
export function attachStoredCredentials(session: Session, lookup: CredentialLookup): Session {
  let next = session
  if (next.auth.method === 'password' && !next.auth.password) {
    const saved = lookup.get(sessionCredentialId(next.id))
    if (saved) next = { ...next, auth: { ...next.auth, password: saved } }
  }
  if (next.jumpHosts?.length) {
    const jumpHosts = next.jumpHosts.map((jump) => {
      const auth = jump.auth
      if (auth?.method !== 'password' || auth.password) return jump
      const saved = lookup.get(jumpCredentialId(next.id, jump.id))
      return saved ? { ...jump, auth: { ...auth, password: saved } } : jump
    })
    next = { ...next, jumpHosts }
  }
  return next
}
