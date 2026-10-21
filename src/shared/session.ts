import type { SerialOptions, Session } from './types'

const PARITY_LETTER: Record<SerialOptions['parity'], string> = {
  none: 'N',
  even: 'E',
  odd: 'O',
  mark: 'M',
  space: 'S'
}

export function isSerialSession(
  session: Pick<Session, 'connectionType'> | null | undefined
): boolean {
  return session?.connectionType === 'serial'
}

/** An embedded shell running on this machine (no remote connection). */
export function isLocalSession(
  session: Pick<Session, 'connectionType'> | null | undefined
): boolean {
  return session?.connectionType === 'local'
}

/** SFTP, port forwarding and public-key installation require an SSH session. */
export function isNonSshSession(
  session: Pick<Session, 'connectionType'> | null | undefined
): boolean {
  return isSerialSession(session) || isLocalSession(session)
}

/** `8N1` style framing description. */
export function serialFrame(options: SerialOptions): string {
  return `${options.dataBits}${PARITY_LETTER[options.parity]}${options.stopBits}`
}

/** One-line serial target for the tab bar, sidebar and status bar. */
export function serialTarget(options: SerialOptions): string {
  return `${options.path} · ${options.baudRate} ${serialFrame(options)}`
}

/** Human-readable destination for either connection type. */
export function sessionTarget(session: Session): string {
  if (isSerialSession(session) && session.serial) return serialTarget(session.serial)
  // A local shell has no destination; its tab name (e.g. "本地终端 2") is the
  // only meaningful label.
  if (isLocalSession(session)) return session.name
  return `${session.username}@${session.host}:${session.port}`
}
