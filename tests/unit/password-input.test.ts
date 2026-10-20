import { describe, expect, it } from 'vitest'
import { handlePasswordKeys } from '../../src/renderer/src/lib/password-input'

describe('handlePasswordKeys', () => {
  it('masks printable characters', () => {
    const result = handlePasswordKeys('', 'abc')
    expect(result).toEqual({ echo: '***', input: 'abc' })
  })

  it('keeps existing input and erases on backspace', () => {
    const typed = handlePasswordKeys('abc', 'd')
    expect(typed).toEqual({ echo: '*', input: 'abcd' })
    const erased = handlePasswordKeys(typed.input, '\x7f')
    expect(erased).toEqual({ echo: '\b \b', input: 'abc' })
    expect(handlePasswordKeys('', '\x7f')).toEqual({ echo: '', input: '' })
  })

  it('submits on Enter and cancels on Ctrl+C', () => {
    expect(handlePasswordKeys('secret', '\r')).toEqual({
      echo: '',
      input: 'secret',
      action: 'submit'
    })
    expect(handlePasswordKeys('sec', '\x03')).toEqual({
      echo: '',
      input: 'sec',
      action: 'cancel'
    })
  })

  it('uses the first line of pasted multi-line text', () => {
    expect(handlePasswordKeys('', 'pass\nignored')).toEqual({
      echo: '****',
      input: 'pass',
      action: 'submit'
    })
  })

  it('ignores escape sequences and other control characters', () => {
    expect(handlePasswordKeys('abc', '\x1b[A')).toEqual({ echo: '', input: 'abc' })
    expect(handlePasswordKeys('abc', '\x01\x02')).toEqual({ echo: '', input: 'abc' })
  })

  it('accepts non-ASCII passwords', () => {
    const result = handlePasswordKeys('', '密码🔑')
    expect(result).toEqual({ echo: '***', input: '密码🔑' })
  })
})
