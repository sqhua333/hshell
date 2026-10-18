import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sanitizeFileName, uniqueFilePath } from '../../src/main/storage/path-safety'

describe('sanitizeFileName', () => {
  it('keeps ordinary names', () => {
    expect(sanitizeFileName('report.txt')).toBe('report.txt')
    expect(sanitizeFileName('中文 文件.tar.gz')).toBe('中文 文件.tar.gz')
  })

  it('reduces paths to their final component', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('/tmp/file.bin')).toBe('file.bin')
    expect(sanitizeFileName('..\\..\\windows\\system32\\evil.dll')).toBe('evil.dll')
  })

  it('rejects traversal-only and empty names', () => {
    expect(sanitizeFileName('..')).toBeNull()
    expect(sanitizeFileName('.')).toBeNull()
    expect(sanitizeFileName('')).toBeNull()
    expect(sanitizeFileName('   ')).toBeNull()
    expect(sanitizeFileName(null)).toBeNull()
    expect(sanitizeFileName('a\0b')).toBeNull()
  })

  it('strips control characters', () => {
    expect(sanitizeFileName('bad\x1b[31mname.txt')).toBe('bad[31mname.txt')
    expect(sanitizeFileName('line\nbreak.txt')).toBe('linebreak.txt')
  })

  it('protects Windows device names and trailing dot/space', () => {
    expect(sanitizeFileName('CON')).toBe('_CON')
    expect(sanitizeFileName('nul.txt')).toBe('_nul.txt')
    expect(sanitizeFileName('LPT9.log')).toBe('_LPT9.log')
    expect(sanitizeFileName('file.txt.  ')).toBe('file.txt')
  })

  it('limits names to 255 UTF-8 bytes', () => {
    const name = sanitizeFileName('文'.repeat(200))
    expect(name).not.toBeNull()
    expect(Buffer.byteLength(name!, 'utf8')).toBeLessThanOrEqual(255)
  })
})

describe('uniqueFilePath', () => {
  it('adds a counter when the target exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hshell-name-'))
    writeFileSync(join(dir, 'a.txt'), 'one')
    writeFileSync(join(dir, 'a (1).txt'), 'two')
    const target = uniqueFilePath(dir, 'a.txt')
    expect(target.endsWith('a (2).txt')).toBe(true)
    expect(target.startsWith(dir)).toBe(true)
  })

  it('returns the original path when free', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hshell-name-'))
    expect(uniqueFilePath(dir, 'fresh.txt')).toBe(join(dir, 'fresh.txt'))
  })
})
