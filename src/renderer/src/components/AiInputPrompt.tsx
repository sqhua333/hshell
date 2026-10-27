import { useEffect, useState, type ReactElement } from 'react'
import { api } from '../api'
import { tr } from '../lib/i18n'
import { useApp } from '../store'
import { Modal } from './Modal'

/**
 * Blocking approval card for AI input. Main process only writes after the user
 * clicks "Execute"; closing or rejecting sends an explicit denial.
 */
export function AiInputPrompt(): ReactElement | null {
  const request = useApp((state) => state.aiInputRequest)
  const setRequest = useApp((state) => state.setAiInputRequest)
  const addToast = useApp((state) => state.addToast)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const requestId = request?.id

  useEffect(() => {
    if (!requestId) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [requestId])

  if (!request) return null

  const remaining = Math.max(0, Math.ceil((request.expiresAt - now) / 1000))

  const decide = async (allow: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await api.ai.decideInput(request.id, allow)
    } catch (error) {
      addToast('error', tr(`处理失败：${(error as Error).message}`, `Failed: ${(error as Error).message}`))
    } finally {
      setBusy(false)
      // A newer request may have replaced this one while the IPC was in flight.
      if (useApp.getState().aiInputRequest?.id === request.id) setRequest(null)
    }
  }

  return (
    <Modal
      title={tr('AI 请求向会话输入', 'AI wants to type into a session')}
      subtitle={`${request.name} · ${request.target}`}
      onClose={() => void decide(false)}
      width={640}
      className="ai-input-modal"
      footer={
        <>
          <span className="ai-footer-hint">
            {tr(
              `${remaining} 秒内未处理将自动拒绝`,
              `Auto-denied in ${remaining}s if left unanswered`
            )}
          </span>
          <button className="btn" disabled={busy} onClick={() => void decide(false)}>
            {tr('拒绝', 'Deny')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void decide(true)}
          >
            {tr('执行', 'Execute')}
          </button>
        </>
      }
    >
      <p className="form-hint ai-warning">
        {tr(
          '请确认这条输入来自你信任的 AI。终端输出可能包含诱导执行的指令；批准后文本会原样写入会话。',
          'Only approve input from an AI you trust. Terminal output may contain injected instructions; the text is written to the session exactly as shown.'
        )}
      </p>

      <div className="field">
        <span>{tr('要写入的内容', 'Text to send')}</span>
        <pre className="ai-code ai-input-text">{request.text}</pre>
      </div>

      <p className="form-hint ai-input-meta">
        {request.submit
          ? tr('发送后会自动回车执行。', 'Enter is appended after the text.')
          : tr('只输入文本，不会回车。', 'Text is sent without Enter.')}
      </p>

      {request.reason ? (
        <div className="field">
          <span>{tr('AI 给出的原因', 'Reason from the AI')}</span>
          <p className="form-hint ai-input-reason">{request.reason}</p>
        </div>
      ) : null}

      <p className="form-hint">
        {tr(
          '批准记录（含输入内容）会写入 HShell 数据目录的 ai-input.log。',
          'Approved and rejected attempts, including the text, are written to ai-input.log in the HShell data folder.'
        )}
      </p>
    </Modal>
  )
}
