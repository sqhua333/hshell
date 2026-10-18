import { basename, resolve, sep } from 'node:path'
import { sanitizeFileName } from '../storage/path-safety'

const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Turn an untrusted remote file name into a safe local file name.
 *
 * Remote servers may return names containing path separators, control
 * characters, or Windows device names. Downloads must never escape the chosen
 * local directory.
 */
export function sanitizeLocalName(input: string): string {
  return sanitizeFileName(input) ?? 'unnamed'
}

/** Resolve a remote path and reject traversal/control characters. */
export function normalizeRemotePath(input: string): string {
  if (!input || !input.startsWith('/')) throw new Error('远程路径必须是绝对路径')
  if (CONTROL.test(input)) throw new Error('远程路径包含控制字符')
  if (input.length > 4096) throw new Error('远程路径过长')
  const parts = input.split('/').filter((part) => part && part !== '.')
  if (parts.includes('..')) throw new Error('远程路径不能包含 ..')
  return `/${parts.join('/')}`
}

/** Join a child name onto a remote directory and normalize the result. */
export function joinRemotePath(dir: string, name: string): string {
  if (!name || name === '.' || name === '..') throw new Error('远程文件名无效')
  if (name.includes('/')) throw new Error('远程文件名不能包含 /')
  return normalizeRemotePath(`${dir.replace(/\/+$/, '')}/${name}`)
}

/** Safe local child path: sanitize the remote name, then verify containment. */
export function localChildPath(localDir: string, remotePath: string, root = localDir): string {
  const name = sanitizeLocalName(basename(remotePath.replace(/\\/g, '/')))
  const target = resolve(localDir, name)
  assertInside(root, target)
  return target
}

/** True when `target` is the root itself or lives beneath it. */
export function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  if (normalizedTarget === normalizedRoot) return true
  return normalizedTarget.startsWith(normalizedRoot + sep)
}

export function assertInside(root: string, target: string): void {
  if (!isInside(root, target)) throw new Error('目标路径超出允许的目录')
}
