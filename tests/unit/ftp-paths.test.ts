import { describe, expect, it } from 'vitest'
import { FileInfo, FileType } from 'basic-ftp'
import { joinRemote, toFileEntry } from '../../src/main/ftp/manager'

function info(name: string, type: FileType, size = 0, modifiedAt?: Date): FileInfo {
  const file = new FileInfo(name)
  file.type = type
  file.size = size
  if (modifiedAt) file.modifiedAt = modifiedAt
  return file
}

describe('joinRemote', () => {
  it('joins POSIX remote paths', () => {
    expect(joinRemote('/', 'file.txt')).toBe('/file.txt')
    expect(joinRemote('/pub', 'file.txt')).toBe('/pub/file.txt')
    expect(joinRemote('/pub/', '/file.txt')).toBe('/pub/file.txt')
  })

  it('rejects control characters and empty names', () => {
    expect(() => joinRemote('/pub', 'a\rb')).toThrow('文件名无效')
    expect(() => joinRemote('/pub', '')).toThrow('文件名无效')
    expect(() => joinRemote('/pub\r\nRETR x', 'a')).toThrow('远程路径包含非法字符')
  })
})

describe('toFileEntry', () => {
  it('maps directories, files and symlinks', () => {
    const dir = toFileEntry(info('docs', FileType.Directory), '/pub')
    expect(dir).toMatchObject({ name: 'docs', path: '/pub/docs', type: 'directory' })

    const file = toFileEntry(
      info('readme.txt', FileType.File, 42, new Date('2026-01-02T03:04:05Z')),
      '/pub'
    )
    expect(file).toMatchObject({
      name: 'readme.txt',
      path: '/pub/readme.txt',
      type: 'file',
      size: 42,
      mtime: Date.parse('2026-01-02T03:04:05Z')
    })

    const link = toFileEntry(info('latest', FileType.SymbolicLink), '/pub')
    expect(link.type).toBe('symlink')
  })

  it('uses 0 when the server provides no modification time', () => {
    expect(toFileEntry(info('x', FileType.File), '/').mtime).toBe(0)
  })
})
