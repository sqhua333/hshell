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
  return `${session.username}@${session.host}:${session.port}`
}
