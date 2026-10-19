import { describe, expect, it } from 'vitest'
import {
  aclFixCommand,
  launchFailureMessage
} from '../../src/main/diagnostic-messages'

describe('aclFixCommand', () => {
  it('grants both AppContainer SIDs read and execute recursively', () => {
    expect(aclFixCommand('C:\\Program Files\\HShell')).toBe(
      'icacls "C:\\Program Files\\HShell" /grant "*S-1-15-2-1:(OI)(CI)(RX)" "*S-1-15-2-2:(OI)(CI)(RX)" /T'
    )
  })
})

describe('launchFailureMessage', () => {
  const context = {
    appDir: 'D:\\Tools\\HShell',
    logDir: 'C:\\Users\\me\\AppData\\Roaming\\hshell',
    reason: 'launch-failed',
    exitCode: 57
  }

  it('explains the sandbox cause and includes the fix command', () => {
    const message = launchFailureMessage(context)
    expect(message).toContain('reason=launch-failed')
    expect(message).toContain('exitCode=57')
    expect(message).toContain('icacls "D:\\Tools\\HShell"')
    expect(message).toContain('*S-1-15-2-2:(OI)(CI)(RX)')
  })

  it('points the user at every diagnostics log', () => {
    const message = launchFailureMessage(context)
    expect(message).toContain('C:\\Users\\me\\AppData\\Roaming\\hshell')
    expect(message).toContain('startup.log')
    expect(message).toContain('renderer-errors.log')
  })
})
