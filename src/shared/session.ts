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

export function isTelnetSession(
  session: Pick<Session, 'connectionType'> | null | undefined
): boolean {
  return session?.connectionType === 'telnet'
}

/** A file-transfer-only session; it has no terminal. */
export function isFtpSession(
  session: Pick<Session, 'connectionType'> | null | undefined
): boolean {
  return session?.connectionType === 'ftp'
}

/** SFTP, port forwarding, remote monitoring and key installation need SSH. */
export function isNonSshSession(
  session: Pick<Session, 'connectionType'> | null | undefined
): boolean {
  return (
    isSerialSession(session) ||
    isLocalSession(session) ||
    isTelnetSession(session) ||
    isFtpSession(session)
  )
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
  // Telnet logs in inside the terminal, so a username is optional there.
  if (isTelnetSession(session)) return `${session.host}:${session.port}`
  if (isFtpSession(session)) {
    return session.username
      ? `${session.username}@${session.host}:${session.port}`
      : `${session.host}:${session.port}`
  }
  return `${session.username}@${session.host}:${session.port}`
}
