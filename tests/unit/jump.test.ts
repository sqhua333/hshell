import { describe, expect, it } from 'vitest'
import { formatProxyJump, parseProxyJump } from '../../src/main/ssh/jump'

describe('parseProxyJump', () => {
  it('treats empty and none as no jump host', () => {
    expect(parseProxyJump(undefined)).toEqual([])
    expect(parseProxyJump(null)).toEqual([])
    expect(parseProxyJump('')).toEqual([])
    expect(parseProxyJump('   ')).toEqual([])
    expect(parseProxyJump('none')).toEqual([])
  })

  it('parses host, port and user forms', () => {
    expect(parseProxyJump('bastion')).toEqual([{ host: 'bastion', port: 22 }])
    expect(parseProxyJump('user@bastion')).toEqual([
      { username: 'user', host: 'bastion', port: 22 }
    ])
    expect(parseProxyJump('bastion:2222')).toEqual([{ host: 'bastion', port: 2222 }])
    expect(parseProxyJump('user@bastion:2222')).toEqual([
      { username: 'user', host: 'bastion', port: 2222 }
    ])
  })

  it('parses bracketed IPv6 addresses', () => {
    expect(parseProxyJump('[::1]')).toEqual([{ host: '::1', port: 22 }])
    expect(parseProxyJump('root@[2001:db8::1]:2200')).toEqual([
      { username: 'root', host: '2001:db8::1', port: 2200 }
    ])
  })

  it('parses multi-hop chains', () => {
    expect(parseProxyJump('a,b@[::1]:2200, c:2022')).toEqual([
      { host: 'a', port: 22 },
      { username: 'b', host: '::1', port: 2200 },
      { host: 'c', port: 2022 }
    ])
  })

  it('rejects malformed input', () => {
    expect(() => parseProxyJump('host:')).toThrow('端口')
    expect(() => parseProxyJump('host:0')).toThrow('端口')
    expect(() => parseProxyJump('host:70000')).toThrow('端口')
    expect(() => parseProxyJump('host:abc')).toThrow('端口')
    expect(() => parseProxyJump('2001:db8::1')).toThrow('IPv6')
    expect(() => parseProxyJump('[::1')).toThrow(']')
    expect(() => parseProxyJump('a,,b')).toThrow('空')
    expect(() => parseProxyJump('user name@host')).toThrow('用户名')
    expect(() => parseProxyJump('bad host')).toThrow('无效字符')
    expect(() => parseProxyJump('a,b,c,d,e,f,g,h,i')).toThrow('最多')
    expect(() => parseProxyJump(`a${'b'.repeat(600)}`)).toThrow()
  })
})

describe('formatProxyJump', () => {
  it('round-trips through the parser', () => {
    const input = 'user@bastion:2222,[::1]:22,proxy'
    expect(formatProxyJump(parseProxyJump(input))).toBe(
      'user@bastion:2222,[::1]:22,proxy:22'
    )
  })
})
