/**
 * Console login for serial sessions.
 *
 * The board shows `login:` then `Password:` after boot; feed the captured
 * output here and write the returned text back to the port. The engine is
 * deliberately small: one username and one password per cycle, a bounded
 * number of retries, and no knowledge of any other console input.
 *
 * Matching is line based rather than "end of buffer": a board often keeps
 * printing service messages after the login prompt, and the prompt can be
 * followed by those bytes. Anchoring to the end of a line still avoids
 * matching banners such as `Last login: Mon ...` on the same line.
 *
 * After a successful login the engine stays idle instead of switching off:
 * when the console shows the login prompt again (the device was rebooted or
 * the user typed `exit`) it logs in again. Only a successful cycle re-arms,
 * so a rejected password is never retried forever, and the prompt must end
 * the output, so text printed by `cat` or `dmesg` cannot make the engine type
 * the password at a shell prompt.
 */

export interface SerialLoginConfig {
  username: string
  password?: string
  /** Prompt markers; matched case-insensitively at the end of a line. */
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
/**
 * If the console is completely silent after connecting, an Enter usually
 * makes an already displayed `login:` prompt reappear. Without it, opening
 * HShell after the board has booted would never see a prompt at all.
 */
export const WAKE_DELAY_MS = 1_500
const PROBE_CHARS = 4096
const MAX_STEPS = 8

const LOGIN_WORDS = '(?:login|username)'
const PASSWORD_WORDS = 'password'
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

interface PromptMatcher {
  /** Anywhere at the end of a line; used while a login is in progress. */
  line: RegExp
  /** Only at the very end of the captured output; used to re-arm. */
  end: RegExp
}

function promptMatcher(prompt: string | undefined, words: string): PromptMatcher {
  const trimmed = prompt?.trim()
  const base = trimmed ? escapeRegExp(trimmed) : words
  // The defaults require the colon so bare words in boot logs do not match.
  const colon = trimmed ? '[:：]?' : '[:：]'
  return {
    line: new RegExp(`${base}\\s*${colon}\\s*(?:\\n|$)`, 'i'),
    end: new RegExp(`${base}\\s*${colon}\\s*$`, 'i')
  }
}

export class SerialAutoLogin {
  private stage: 'login' | 'password' | 'verify' | 'done' = 'login'
  /** Cleaned, not-yet-consumed console output. */
  private buffer = ''
  private retries = 0
  private deadline: number
  private verifyUntil = 0
  private received = false
  /** The last cycle ended with the console accepting the password. */
  private succeeded = false
  private readonly matchLogin: PromptMatcher
  private readonly matchPassword: PromptMatcher

  constructor(
    private readonly config: SerialLoginConfig,
    private readonly now: () => number = Date.now
  ) {
    this.deadline = now() + LOGIN_TIMEOUT_MS
    this.matchLogin = promptMatcher(config.loginPrompt, LOGIN_WORDS)
    this.matchPassword = promptMatcher(config.passwordPrompt, PASSWORD_WORDS)
  }

  get finished(): boolean {
    return this.stage === 'done'
  }

  get attempts(): number {
    return this.retries
  }

  /** True once any console output arrived; used to decide whether to wake. */
  get sawData(): boolean {
    return this.received
  }

  /** Feed captured console output and get everything that should happen. */
  feed(text: string): SerialLoginEvent[] {
    if (!text) return []
    this.received = true
    const now = this.now()

    if (this.stage === 'done') return this.rearm(text)
    if (this.stage === 'verify' && now > this.verifyUntil) {
      // The password was accepted and the console has been quiet since; the
      // text starts a new line and may already be a fresh login prompt.
      this.stage = 'done'
      this.succeeded = true
      const events = this.rearm(text)
      return events.length ? events : [{ done: true }]
    }
    if (this.stage !== 'verify' && now > this.deadline) {
      this.stage = 'done'
      this.buffer = ''
      return [{ done: true }]
    }

    this.buffer = cleanConsoleText(this.buffer + text).slice(-PROBE_CHARS)
    return this.process(now)
  }

  /** Start a new cycle when a finished console shows the login prompt again. */
  private rearm(text: string): SerialLoginEvent[] {
    if (!this.succeeded) return []
    this.buffer = cleanConsoleText(this.buffer + text).slice(-PROBE_CHARS)
    if (!this.matchLogin.end.test(this.buffer)) return []
    this.stage = 'login'
    this.retries = 0
    this.succeeded = false
    this.deadline = this.now() + LOGIN_TIMEOUT_MS
    return this.process(this.now())
  }

  private process(now: number): SerialLoginEvent[] {
    const events: SerialLoginEvent[] = []

    // A prompt and the next prompt can share a chunk (or arrive while the
    // previous prompt was split across chunks), so keep consuming.
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (this.stage === 'login') {
        const rest = this.consume(this.matchLogin.line)
        if (rest === null) break
        this.buffer = rest
        this.stage = 'password'
        // The board may have taken a while to boot; give each step its own
        // window instead of spending the whole budget before the prompt.
        this.deadline = now + LOGIN_TIMEOUT_MS
        if (this.config.username) events.push({ send: this.config.username })
        continue
      }

      if (this.stage === 'password') {
        const rest = this.consume(this.matchPassword.line)
        if (rest !== null) {
          this.buffer = rest
          if (!this.config.password) {
            this.stage = 'done'
            this.buffer = ''
            events.push({
              notice: {
                level: 'warn',
                message: '串口自动登录：没有可用的密码，已停止自动登录'
              },
              done: true
            })
            return events
          }
          this.stage = 'verify'
          this.verifyUntil = now + VERIFY_TIMEOUT_MS
          events.push({ send: this.config.password })
          continue
        }
        // The board asked for the login name again: the first write arrived
        // before the console was reading, which is common right after boot.
        const again = this.consume(this.matchLogin.line)
        if (again !== null) {
          this.buffer = again
          this.retries += 1
          if (this.retries > MAX_LOGIN_RETRIES) {
            this.stage = 'done'
            this.buffer = ''
            events.push({
              notice: {
                level: 'warn',
                message: '串口自动登录失败：登录提示反复出现，已停止自动登录'
              },
              done: true
            })
            return events
          }
          this.deadline = now + LOGIN_TIMEOUT_MS
          events.push({
            notice: {
              level: 'warn',
              message: `串口自动登录未生效，重新发送用户名（${this.retries}/${MAX_LOGIN_RETRIES}）`
            }
          })
          if (this.config.username) events.push({ send: this.config.username })
          continue
        }
        break
      }

      if (this.stage === 'verify') {
        const failed = LOGIN_FAILED.test(this.buffer)
        const again = this.consume(this.matchLogin.line)
        if (again === null) break
        // A login prompt after the password means it was not accepted,
        // whether or not the console printed an explicit error.
        this.buffer = again
        this.retries += 1
        if (this.retries > MAX_LOGIN_RETRIES) {
          this.stage = 'done'
          this.buffer = ''
          events.push({
            notice: {
              level: 'warn',
              message: '串口自动登录失败：密码多次错误，已停止自动登录'
            },
            done: true
          })
          return events
        }
        this.stage = 'password'
        this.deadline = now + LOGIN_TIMEOUT_MS
        events.push({
          notice: {
            level: 'warn',
            message: failed
              ? `串口自动登录失败，等待重新登录（${this.retries}/${MAX_LOGIN_RETRIES}）`
              : `串口自动登录未完成，重新发送用户名（${this.retries}/${MAX_LOGIN_RETRIES}）`
          }
        })
        if (this.config.username) events.push({ send: this.config.username })
        continue
      }

      break
    }

    return events
  }

  /** Drop everything through the matched prompt and return the remainder. */
  private consume(pattern: RegExp): string | null {
    const match = pattern.exec(this.buffer)
    if (!match) return null
    return this.buffer.slice(match.index + match[0].length)
  }
}
