import { describe, expect, it } from 'vitest'
import {
  assertInside,
  isInside,
  joinRemotePath,
  localChildPath,
  normalizeRemotePath,
  sanitizeLocalName
} from '../../src/main/ssh/paths'

describe('sanitizeLocalName', () => {
  it('keeps ordinary names', () => {
    expect(sanitizeLocalName('report.txt')).toBe('report.txt')
    expect(sanitizeLocalName('中文 文件.tar.gz')).toBe('中文 文件.tar.gz')
  })

  it('keeps only the final path component', () => {
    expect(sanitizeLocalName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeLocalName('/var/log/syslog')).toBe('syslog')
    expect(sanitizeLocalName('..\\..\\windows\\evil.dll')).toBe('evil.dll')
  })

  it('replaces traversal-only and empty names', () => {
    expect(sanitizeLocalName('..')).toBe('unnamed')
    expect(sanitizeLocalName('.')).toBe('unnamed')
    expect(sanitizeLocalName('')).toBe('unnamed')
    expect(sanitizeLocalName('   ')).toBe('unnamed')
  })

  it('strips control characters and Windows-hostile characters', () => {
    expect(sanitizeLocalName('bad\x1b[31mname.txt')).toBe('bad[31mname.txt')
    expect(sanitizeLocalName('a:b*c?.txt')).toBe('a_b_c_.txt')
  })

  it('protects Windows device names and trailing dots', () => {
    expect(sanitizeLocalName('CON')).toBe('_CON')
    expect(sanitizeLocalName('nul.txt')).toBe('_nul.txt')
    expect(sanitizeLocalName('file.txt.  ')).toBe('file.txt')
  })

  it('never returns separators, control bytes, or overlong names', () => {
    const alphabet = ['a', 'B', '中', '/', '\\', '..', '.', ' ', ':', '*', '\0', '\n', 'CON']
    let seed = 42
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed
    }
    for (let index = 0; index < 500; index += 1) {
      let input = ''
      const length = random() % 8
      for (let part = 0; part < length; part += 1) {
        input += alphabet[random() % alphabet.length]
      }
      const name = sanitizeLocalName(input)
      expect(name.length).toBeGreaterThan(0)
      expect(name).not.toMatch(/[/\\\u0000-\u001f\u007f]/)
      expect(name).not.toBe('.')
      expect(name).not.toBe('..')
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255)
    }
  })
})

describe('normalizeRemotePath', () => {
  it('normalizes duplicate slashes and keeps the root', () => {
    expect(normalizeRemotePath('/')).toBe('/')
    expect(normalizeRemotePath('//var//log/./syslog')).toBe('/var/log/syslog')
    expect(normalizeRemotePath('/home/user/中文 文件')).toBe('/home/user/中文 文件')
  })

  it('rejects relative, traversing, and control-character paths', () => {
    expect(() => normalizeRemotePath('var/log')).toThrow('绝对路径')
    expect(() => normalizeRemotePath('/var/../etc/passwd')).toThrow('..')
    expect(() => normalizeRemotePath('/var/a\0b')).toThrow('控制字符')
    expect(() => normalizeRemotePath('/var/a\nb')).toThrow('控制字符')
    expect(() => normalizeRemotePath(`/${'a'.repeat(5000)}`)).toThrow('过长')
  })
})

describe('joinRemotePath', () => {
  it('joins a child onto its parent', () => {
    expect(joinRemotePath('/', 'file.txt')).toBe('/file.txt')
    expect(joinRemotePath('/var/log/', 'syslog')).toBe('/var/log/syslog')
  })

  it('rejects names that could change the directory', () => {
    expect(() => joinRemotePath('/var', '..')).toThrow('文件名无效')
    expect(() => joinRemotePath('/var', '.')).toThrow('文件名无效')
    expect(() => joinRemotePath('/var', 'a/b')).toThrow('/')
    expect(() => joinRemotePath('/var', '')).toThrow('文件名无效')
  })
})

describe('local path containment', () => {
  const root = '/tmp/hshell-root'

  it('resolves local children inside the download root', () => {
    expect(localChildPath(root, '/remote/dir/report.txt')).toBe(
      '/tmp/hshell-root/report.txt'
    )
    expect(localChildPath(root, '/remote/dir/../../etc/passwd')).toBe(
      '/tmp/hshell-root/passwd'
    )
    expect(localChildPath(root, '/remote/dir/..')).toBe('/tmp/hshell-root/unnamed')
  })

  it('checks containment with path boundaries', () => {
    expect(isInside(root, '/tmp/hshell-root')).toBe(true)
    expect(isInside(root, '/tmp/hshell-root/a/b')).toBe(true)
    expect(isInside(root, '/tmp/hshell-root-evil/a')).toBe(false)
    expect(isInside(root, '/tmp/other')).toBe(false)
    expect(() => assertInside(root, '/tmp/other')).toThrow('超出')
  })
})
