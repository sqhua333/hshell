import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type DiagnosticLogName = 'startup.log' | 'renderer-errors.log'

/**
 * Append a line to a diagnostics file under userData. Never throws: logging is
 * best-effort and must not take startup down with it.
 */
export function logDiagnostic(message: string, file: DiagnosticLogName = 'startup.log'): void {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, file), `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* diagnostics must never break startup */
  }
}
