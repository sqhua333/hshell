import { useEffect, useState, type ReactElement } from 'react'
import { api } from '../api'
import { tr } from '../lib/i18n'
import { useApp } from '../store'
import { Modal } from './Modal'

export function KeyboardDialog(): ReactElement | null {
  const keyboard = useApp((state) => state.keyboard)
  const setKeyboard = useApp((state) => state.setKeyboard)
  const [responses, setResponses] = useState<string[]>([])

  useEffect(() => {
    setResponses(keyboard ? keyboard.prompts.map(() => '') : [])
  }, [keyboard?.requestId])

  if (!keyboard) return null

  const submit = (): void => {
    void api.ssh.keyboardInteractive(keyboard.requestId, responses)
    setKeyboard(null)
  }

  const cancel = (): void => {
    void api.ssh.keyboardInteractive(keyboard.requestId, undefined, true)
    setKeyboard(null)
  }

  return (
    <Modal
      title={keyboard.name || tr('键盘交互认证', 'Keyboard-interactive authentication')}
      width={520}
      onClose={cancel}
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={cancel}>
            {tr('取消', 'Cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {tr('提交', 'Submit')}
          </button>
        </div>
      }
    >
      {keyboard.instructions ? <div className="form-hint">{keyboard.instructions}</div> : null}
      <div className="form-grid single">
        {keyboard.prompts.map((prompt, index) => (
          <label className="field" key={`${index}-${prompt.prompt}`}>
            <span>{prompt.prompt || tr(`输入 ${index + 1}`, `Input ${index + 1}`)}</span>
            <input
              className="input"
              type={prompt.echo ? 'text' : 'password'}
              value={responses[index] ?? ''}
              onChange={(event) => {
                const next = [...responses]
                next[index] = event.target.value
                setResponses(next)
              }}
              autoFocus={index === 0}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
            />
          </label>
        ))}
      </div>
    </Modal>
  )
}
