/**
 * Console login for serial sessions.
 *
 * The board shows `login:` then `Password:` after boot; feed the captured
 * output here and write the returned text back to the port. The engine is
 * deliberately small: one username and one password per boot, a bounded
 * number of retries, and no knowledge of any other console input.
 */

export interface SerialLoginConfig {
  username: string
  password?: string
  /** Prompt markers; matched case-insensitively at the end of the output. */
  loginPrompt?: string
  passwordPrompt?: string
}

export interface SerialLoginNotice {
  level: 'info' | 'warn'
  message: string
}

export interface SerialLoginEvent {
  /** Exact text to write; the caller appends the Enter. */
  send?: string
  notice?: SerialLoginNotice
  /** The engine will not produce further events for this connection. */
  done?: boolean
}

/** Give a board that is still booting time to reach the login prompt. */
export const LOGIN_TIMEOUT_MS = 120_000
/** Stop watching for failures once the password has been sent. */
export const VERIFY_TIMEOUT_MS = 15_000
export const MAX_LOGIN_RETRIES = 2
const PROBE_CHARS = 4096

const DEFAULT_LOGIN_PROMPT = /(?:login|username)\s*[:：]\s*$/i
const DEFAULT_PASSWORD_PROMPT = /password\s*[:：]\s*$/i
const LOGIN_FAILED = /login\s+incorrect|login\s+failed|authentication\s+failure|incorrect\s+password/i

/** Strip ANSI escapes and carriage returns so prompts match cleanly. */
export function cleanConsoleText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function promptMatcher(prompt: string | undefined, fallback: RegExp): (text: string) => boolean {
  if (!prompt?.trim()) return (text) => fallback.test(text)
  const pattern = new RegExp(`${escapeRegExp(prompt.trim())}\\s*[:：]?\\s*$`, 'i')
  return (text) => pattern.test(text)
}

export class SerialAutoLogin {
  private stage: 'login' | 'password' | 'verify' | 'done' = 'login'
  private probe = ''
  private retries = 0
  private deadline: number
  private verifyUntil = 0
  private readonly matchLogin: (text: string) => boolean
  private readonly matchPassword: (text: string) => boolean

  constructor(
    private readonly config: SerialLoginConfig,
    private readonly now: () => number = Date.now
  ) {
    this.deadline = now() + LOGIN_TIMEOUT_MS
    this.matchLogin = promptMatcher(config.loginPrompt, DEFAULT_LOGIN_PROMPT)
    this.matchPassword = promptMatcher(config.passwordPrompt, DEFAULT_PASSWORD_PROMPT)
  }

  get finished(): boolean {
    return this.stage === 'done'
  }

  get attempts(): number {
    return this.retries
  }

  /** Feed captured console output and get everything that should happen. */
  feed(text: string): SerialLoginEvent[] {
    if (this.stage === 'done' || !text) return []
    const now = this.now()
    if (this.stage === 'verify') {
      if (now > this.verifyUntil) {
        this.stage = 'done'
        return [{ done: true }]
      }
    } else if (now > this.deadline) {
      this.stage = 'done'
      return [{ done: true }]
    }

    this.probe = cleanConsoleText(this.probe + text).slice(-PROBE_CHARS)
    const events: SerialLoginEvent[] = []

    if (this.stage === 'verify') {
      if (LOGIN_FAILED.test(this.probe)) {
        this.retries += 1
        if (this.retries > MAX_LOGIN_RETRIES) {
          this.stage = 'done'
          events.push({
            notice: {
              level: 'warn',
              message: '串口自动登录失败：密码多次错误，已停止自动登录'
            },
            done: true
          })
          return events
        }
        this.stage = 'login'
        this.deadline = now + LOGIN_TIMEOUT_MS
        events.push({
          notice: {
            level: 'warn',
            message: `串口自动登录失败，等待重新登录（${this.retries}/${MAX_LOGIN_RETRIES}）`
          }
        })
        // The console usually prints the next login prompt in the same chunk;
        // keep the tail so the retry is not delayed by another prompt.
        if (!this.matchLogin(this.probe)) return events
        this.probe = ''
        this.stage = 'password'
        if (this.config.username) events.push({ send: this.config.username })
        return events
      }
      return events
    }

    if (this.stage === 'login' && this.matchLogin(this.probe)) {
      this.probe = ''
      this.stage = 'password'
      if (this.config.username) events.push({ send: this.config.username })
      return events
    }

    if (this.stage === 'password' && this.matchPassword(this.probe)) {
      this.probe = ''
      if (!this.config.password) {
        this.stage = 'done'
        return [{ done: true }]
      }
      this.stage = 'verify'
      this.verifyUntil = now + VERIFY_TIMEOUT_MS
      events.push({ send: this.config.password })
      return events
    }

    return events
  }
}
