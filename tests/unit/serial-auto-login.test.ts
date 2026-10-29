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
    expect(login.feed('Password: ')).toEqual([{ done: true }])

    const second = engine({})
    second.login.feed('board login: ')
    second.login.feed('Password: ')
    const events = second.login.feed('Login incorrect\r\nboard login: ')
    expect(JSON.stringify(events)).not.toContain('s3cret')
  })
})

describe('cleanConsoleText', () => {
  it('removes ANSI sequences and carriage returns', () => {
    expect(cleanConsoleText('\x1b[1;31mLogin\x1b[0m:\r\n')).toBe('Login:\n')
  })
})
