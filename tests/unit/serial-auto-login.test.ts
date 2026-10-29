import { describe, expect, it } from 'vitest'
import {
  LOGIN_TIMEOUT_MS,
  MAX_LOGIN_RETRIES,
  SerialAutoLogin,
  VERIFY_TIMEOUT_MS,
  cleanConsoleText
} from '../../src/main/serial/auto-login'

function engine(config: Partial<{ username: string; password?: string; loginPrompt?: string; passwordPrompt?: string }>) {
  let now = 0
  const login = new SerialAutoLogin(
    { username: 'root', password: 's3cret', ...config },
    () => now
  )
  return {
    login,
    advance(ms: number) {
      now += ms
    }
  }
}

function sends(events: Array<{ send?: string }>): string[] {
  return events.flatMap((event) => (event.send === undefined ? [] : [event.send]))
}

describe('SerialAutoLogin', () => {
  it('sends the username then the password when the console prompts', () => {
    const { login } = engine({})
    expect(sends(login.feed('Booting Linux...\r\nboard login: '))).toEqual(['root'])
    expect(sends(login.feed('Password: '))).toEqual(['s3cret'])
    expect(login.finished).toBe(false)
  })

  it('matches prompts split across chunks and strips ANSI output', () => {
    const { login } = engine({})
    expect(login.feed('\x1b[0;32mStarting services\x1b[0m\r\nboard lo')).toEqual([])
    expect(sends(login.feed('gin: '))).toEqual(['root'])
    expect(sends(login.feed('\r\nPassword'))).toEqual([])
    expect(sends(login.feed(': '))).toEqual(['s3cret'])
  })

  it('accepts username prompts and custom markers', () => {
    const { login } = engine({ loginPrompt: 'account', passwordPrompt: '口令' })
    expect(sends(login.feed('Account: '))).toEqual(['root'])
    expect(sends(login.feed('口令: '))).toEqual(['s3cret'])
  })

  it('matches a prompt even when the board keeps printing after it', () => {
    const { login } = engine({})
    expect(login.feed('Last login: Mon Jan 1 12:00\r\n')).toEqual([])
    expect(sends(login.feed('board login: \r\nStarting nginx\r\n'))).toEqual(['root'])
    expect(sends(login.feed('Password: \r\n'))).toEqual(['s3cret'])
  })

  it('handles both prompts arriving in the same chunk', () => {
    const { login } = engine({})
    expect(sends(login.feed('board login: \r\nPassword: '))).toEqual(['root', 's3cret'])
  })

  it('resends the username when the console asks for it again', () => {
    const { login } = engine({})
    expect(sends(login.feed('board login: '))).toEqual(['root'])
    // The board never received the first username (console not reading yet).
    const retry = login.feed('\r\nboard login: ')
    expect(sends(retry)).toEqual(['root'])
    expect(retry[0].notice?.message).toContain('1/2')
    expect(sends(login.feed('Password: '))).toEqual(['s3cret'])
  })

  it('treats a silent re-prompt after the password as a failed attempt', () => {
    const { login } = engine({})
    login.feed('board login: ')
    login.feed('Password: ')
    const retry = login.feed('\r\nboard login: ')
    expect(sends(retry)).toEqual(['root'])
    expect(retry[0].notice?.message).toContain('1/2')
  })

  it('gives every login step its own timeout window', () => {
    const { login, advance } = engine({})
    advance(LOGIN_TIMEOUT_MS - 1000)
    expect(sends(login.feed('board login: '))).toEqual(['root'])
    // The original deadline has passed, but the password prompt has its own.
    advance(5000)
    expect(sends(login.feed('Password: '))).toEqual(['s3cret'])
  })

  it('retries after a wrong password and gives up after the limit', () => {
    const { login } = engine({})
    login.feed('board login: ')
    login.feed('Password: ')
    const first = login.feed('\r\nLogin incorrect\r\nboard login: ')
    expect(first[0].notice?.level).toBe('warn')
    expect(first[0].notice?.message).toContain('1/2')
    // The next login prompt arrived in the same chunk, so the retry resends.
    expect(sends(first)).toEqual(['root'])
    expect(sends(login.feed('Password: '))).toEqual(['s3cret'])

    const second = login.feed('\r\nLogin incorrect\r\nboard login: ')
    expect(second[0].notice?.message).toContain('2/2')
    expect(sends(login.feed('Password: '))).toEqual(['s3cret'])
    const last = login.feed('\r\nLogin incorrect\r\nboard login: ')
    expect(last.at(-1)?.done).toBe(true)
    expect(login.attempts).toBe(MAX_LOGIN_RETRIES + 1)
    expect(login.finished).toBe(true)
    expect(login.feed('board login: ')).toEqual([])
  })

  it('logs in again when the device reboots inside the same session', () => {
    const { login, advance } = engine({})
    login.feed('board login: ')
    login.feed('Password: ')
    advance(VERIFY_TIMEOUT_MS + 1)
    expect(login.feed('# ')).toEqual([{ done: true }])
    expect(login.finished).toBe(true)

    // Reboot: boot output arrives first, then getty draws its prompt again.
    expect(login.feed('Rebooting...\r\nStarting kernel\r\n')).toEqual([])
    expect(sends(login.feed('board login: '))).toEqual(['root'])
    expect(login.finished).toBe(false)
    expect(sends(login.feed('Password: '))).toEqual(['s3cret'])

    // Retries start over for the new cycle.
    const retry = login.feed('\r\nlogin incorrect\r\nboard login: ')
    expect(retry[0].notice?.message).toContain('1/2')
  })

  it('does not re-arm after the password was rejected', () => {
    const { login } = engine({})
    login.feed('board login: ')
    for (let attempt = 0; attempt < MAX_LOGIN_RETRIES + 1; attempt += 1) {
      login.feed('Password: ')
      login.feed('Login incorrect\r\nboard login: ')
    }
    expect(login.finished).toBe(true)
    expect(login.feed('board login: ')).toEqual([])
  })

  it('ignores a login prompt printed by shell output', () => {
    const { login, advance } = engine({})
    login.feed('board login: ')
    login.feed('Password: ')
    advance(VERIFY_TIMEOUT_MS + 1)
    expect(login.feed('# ')).toEqual([{ done: true }])
    // `cat /etc/issue` shows the prompt mid-line; the password must not be
    // typed at a shell prompt.
    expect(login.feed('cat /etc/issue\r\nDebian GNU/Linux\r\nlogin: \r\n# ')).toEqual([])
  })

  it('stops quietly once the password was sent and the console settles', () => {
    const { login, advance } = engine({})
    login.feed('root@board login: ')
    login.feed('Password: ')
    advance(VERIFY_TIMEOUT_MS + 1)
    expect(login.feed('Welcome\r\n# ')).toEqual([{ done: true }])
    expect(login.finished).toBe(true)
  })

  it('gives up when the board never shows a prompt', () => {
    const { login, advance } = engine({})
    advance(LOGIN_TIMEOUT_MS + 1)
    expect(login.feed('still booting... login: ')).toEqual([{ done: true }])
  })

  it('sends nothing for an empty password, and nothing leaks into notices', () => {
    const { login } = engine({ password: '' })
    login.feed('board login: ')
    const events = login.feed('Password: ')
    expect(sends(events)).toEqual([])
    expect(events.at(-1)?.notice?.level).toBe('warn')
    expect(events.at(-1)?.done).toBe(true)

    const second = engine({})
    second.login.feed('board login: ')
    second.login.feed('Password: ')
    const retry = second.login.feed('Login incorrect\r\nboard login: ')
    expect(JSON.stringify(retry)).not.toContain('s3cret')
  })
})

describe('cleanConsoleText', () => {
  it('removes ANSI sequences and carriage returns', () => {
    expect(cleanConsoleText('\x1b[1;31mLogin\x1b[0m:\r\n')).toBe('Login:\n')
  })
})
