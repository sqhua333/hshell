import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AiInputOutcome,
  AiInputRequest,
  AiSessionSummary,
  AppEvent
} from '@shared/types'
import type { SessionTap } from './session-tap'

/** A single write is a command, not a paste; keep it small. */
export const MAX_INPUT_CHARS = 4096
/** How long the user has to approve a request before it is denied. */
export const DEFAULT_APPROVAL_MS = 45_000
const MIN_INTERVAL_MS = 400
/** Reject C0 controls except tab/LF/CR, plus DEL and C1 (includes ESC). */
// eslint-disable-next-line no-control-regex
const DISALLOWED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const AUDIT_FILE = 'ai-input.log'

export interface AiInputAttempt {
  runtimeId: string
  text: string
  /** Append Enter after the text (default true). */
  submit?: boolean
  reason?: string
}

export type SendInputHandler = (input: AiInputAttempt) => Promise<AiInputOutcome>

export interface SessionWriterDeps {
  tap: SessionTap
  userData: string
  emit: (event: AppEvent) => void
  /** Dispatch bytes to the owning backend; false when the runtime vanished. */
  write: (runtimeId: string, data: string) => boolean
  /** Approval needs a window to render the prompt. */
  windowAvailable: () => boolean
  now?: () => number
  /** How long approval stays open (tests shorten this). */
  approvalMs?: number
}

export interface SessionWriter {
  /** Validate, ask the user, and only then write. Never throws on refusal. */
  request(input: AiInputAttempt): Promise<AiInputOutcome>
  decide(id: string, allow: boolean): void
  /** Close a pending prompt after its session disconnected or lost its grant. */
  cancel(runtimeId: string, message?: string): void
  dispose(): void
}

interface Pending {
  request: AiInputRequest
  resolve: (outcome: AiInputOutcome) => void
  timer: NodeJS.Timeout
  text: string
  submit: boolean
}

function refuse(message: string): AiInputOutcome {
  return { status: 'blocked', message }
}

function validate(text: string): string {
  if (text.trim().length === 0) return '输入为空'
  if (text.length > MAX_INPUT_CHARS) return `输入过长（最多 ${MAX_INPUT_CHARS} 字符）`
  if (DISALLOWED.test(text)) return '输入包含不允许的控制字符'
  return ''
}

/** Enter on a PTY is CR; keep an explicit trailing newline untouched. */
export function withEnter(text: string, submit: boolean): string {
  if (!submit) return text
  return /[\r\n]$/.test(text) ? text : `${text}\r`
}

/**
 * Approval broker for AI input. The MCP handler calls `request`, which checks
 * the per-session grant, validates the text, then blocks on a card rendered by
 * the HShell window. Nothing is written until `decide(id, true)` arrives from
 * the renderer, and every outcome is appended to `ai-input.log` (0600).
 */
export function createSessionWriter(deps: SessionWriterDeps): SessionWriter {
  const now = deps.now ?? Date.now
  const approvalMs = deps.approvalMs ?? DEFAULT_APPROVAL_MS
  let pending: Pending | null = null
  let lastSentAt = 0
  let lastRequestedAt = 0

  const audit = (entry: Record<string, unknown>): void => {
    try {
      mkdirSync(deps.userData, { recursive: true })
      appendFileSync(join(deps.userData, AUDIT_FILE), `${JSON.stringify(entry)}\n`, {
        mode: 0o600
      })
    } catch {
      // Auditing must never break input.
    }
  }

  const emitResult = (
    request: AiInputRequest,
    outcome: AiInputOutcome
  ): void => {
    deps.emit({
      type: 'ai:input-result',
      id: request.id,
      runtimeId: request.runtimeId,
      name: request.name,
      status: outcome.status,
      message: outcome.message
    })
  }

  const settle = (entry: Pending, outcome: AiInputOutcome): void => {
    clearTimeout(entry.timer)
    audit({
      at: new Date(now()).toISOString(),
      id: entry.request.id,
      runtimeId: entry.request.runtimeId,
      name: entry.request.name,
      text: entry.text,
      submit: entry.submit,
      reason: entry.request.reason,
      status: outcome.status,
      message: outcome.message
    })
    emitResult(entry.request, outcome)
    entry.resolve(outcome)
  }

  const request = async (input: AiInputAttempt): Promise<AiInputOutcome> => {
    const runtimeId = typeof input.runtimeId === 'string' ? input.runtimeId : ''
    let summary: AiSessionSummary
    try {
      summary = deps.tap.requireInput(runtimeId)
    } catch (error) {
      return refuse((error as Error).message)
    }
    const text = typeof input.text === 'string' ? input.text : ''
    const problem = validate(text)
    if (problem) {
      audit({
        at: new Date(now()).toISOString(),
        runtimeId,
        name: summary.name,
        text,
        status: 'blocked',
        message: problem
      })
      return refuse(problem)
    }
    const submit = input.submit !== false
    const reason =
      typeof input.reason === 'string' && input.reason.trim()
        ? input.reason.trim().slice(0, 512)
        : undefined
    if (pending) return refuse('已有待审批的 AI 输入请求')
    if (!deps.windowAvailable()) return refuse('HShell 窗口不可用，无法确认输入')
    if (now() - lastRequestedAt < MIN_INTERVAL_MS) {
      return refuse('请求过于频繁，请稍后再试')
    }
    if (now() - lastSentAt < MIN_INTERVAL_MS) return refuse('发送过于频繁，请稍后再试')

    lastRequestedAt = now()
    const req: AiInputRequest = {
      id: randomUUID(),
      runtimeId,
      name: summary.name,
      target: summary.target,
      text,
      submit,
      reason,
      expiresAt: now() + approvalMs
    }
    return new Promise<AiInputOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (!pending || pending.request.id !== req.id) return
        const entry = pending
        pending = null
        settle(entry, { status: 'timeout', message: '审批超时，已自动拒绝' })
      }, approvalMs)
      timer.unref?.()
      pending = { request: req, resolve, timer, text, submit }
      deps.emit({ type: 'ai:input-request', request: req })
    })
  }

  const decide = (id: string, allow: boolean): void => {
    if (!pending || pending.request.id !== id) return
    const entry = pending
    pending = null
    const { request: req } = entry
    if (!allow) {
      settle(entry, { status: 'denied' })
      return
    }
    // The grant can be revoked or the session can drop between prompt and
    // approval; re-check rather than trusting the state captured earlier.
    try {
      deps.tap.requireInput(req.runtimeId)
    } catch (error) {
      settle(entry, refuse((error as Error).message))
      return
    }
    const data = withEnter(entry.text, entry.submit)
    if (!deps.write(req.runtimeId, data)) {
      settle(entry, refuse('会话已断开'))
      return
    }
    deps.tap.recordInput(req.runtimeId, data, 'ai')
    lastSentAt = now()
    settle(entry, { status: 'sent' })
  }

  const cancel = (runtimeId: string, message = '会话已断开'): void => {
    if (!pending || pending.request.runtimeId !== runtimeId) return
    const entry = pending
    pending = null
    settle(entry, refuse(message))
  }

  const dispose = (): void => {
    if (!pending) return
    const entry = pending
    pending = null
    settle(entry, refuse('HShell 正在退出，已取消输入'))
  }

  return { request, decide, cancel, dispose }
}
