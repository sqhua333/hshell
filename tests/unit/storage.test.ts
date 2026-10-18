import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Session, SessionData } from '@shared/types'
import { AppStore } from '../../src/main/store'
import {
  buildExportBundle,
  importEmbeddedKeys,
  mergeSessions,
  parseExportBundle,
  serializeBundle
} from '../../src/main/storage/export-import'
import {
  findFolderCycles,
  migrateSessions,
  normalizeFolders
} from '../../src/main/storage/migrations'
import { parseSshConfig, sshConfigToSessions } from '../../src/main/storage/ssh-config'

const NOW = 1_700_000_000_000

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-test',
    name: 'test',
    folderId: null,
    host: '127.0.0.1',
    port: 22,
    username: 'tester',
    auth: { method: 'password' },
    terminal: { term: 'xterm-256color', theme: 'dark', fontSize: 14 },
    proxyJump: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('migrations', () => {
  it('strips passwords and fills proxyJump for v1 data', () => {
    const sessions = migrateSessions(
      [
        {
          ...makeSession(),
          auth: { method: 'password', password: 'hunter2' },
          proxyJump: undefined
        },
        { id: 'broken' }
      ],
      1
    )

    expect(sessions).toHaveLength(1)
    expect(sessions[0].auth.password).toBeUndefined()
    expect(sessions[0].proxyJump).toBeNull()
  })

  it('detects folder cycles and dangling parents', () => {
    const folders = [
      { id: 'a', name: 'A', parentId: 'b', sortOrder: 0 },
      { id: 'b', name: 'B', parentId: 'a', sortOrder: 1 },
      { id: 'c', name: 'C', parentId: 'missing', sortOrder: 2 },
      { id: 'd', name: 'D', parentId: null, sortOrder: 3 }
    ]

    expect(findFolderCycles(folders).sort()).toEqual(['a', 'b'])

    const normalised = normalizeFolders(folders)
    expect(normalised.repaired).toBe(true)
    expect(normalised.folders.find((folder) => folder.id === 'a')?.parentId).toBeNull()
    expect(normalised.folders.find((folder) => folder.id === 'c')?.parentId).toBeNull()
    expect(findFolderCycles(normalised.folders)).toEqual([])
  })
})

describe('export / import', () => {
  it('round-trips folders and sessions without passwords', () => {
    const data: SessionData = {
      folders: [{ id: 'f-1', name: 'Ops', parentId: null, sortOrder: 0 }],
      sessions: [
        makeSession({
          id: 's-1',
          folderId: 'f-1',
          auth: { method: 'password', password: 'top-secret' }
        })
      ]
    }

    const { bundle } = buildExportBundle(data, { appName: 'HShell', appVersion: '1.0.0' })
    const text = serializeBundle(bundle)
    expect(text).not.toContain('top-secret')

    const parsed = parseExportBundle(text)
    const merged = mergeSessions({ folders: [], sessions: [] }, parsed)

    expect(merged.folders).toBe(1)
    expect(merged.sessions).toBe(1)
    expect(merged.data.sessions[0]).toMatchObject({ id: 's-1', folderId: 'f-1' })
    expect(merged.data.sessions[0].auth.password).toBeUndefined()
  })

  it('remaps colliding ids and can skip duplicate endpoints', () => {
    const bundle = buildExportBundle(
      { folders: [], sessions: [makeSession()] },
      { appName: 'HShell', appVersion: '1.0.0' }
    ).bundle

    const first = mergeSessions({ folders: [], sessions: [] }, bundle)
    const second = mergeSessions(first.data, bundle, {
      idFactory: (prefix) => `${prefix}-new`
    })

    expect(second.data.sessions).toHaveLength(2)
    expect(second.data.sessions[1].id).toBe('session-new')

    const deduped = mergeSessions(first.data, bundle, { dedupe: true })
    expect(deduped.sessions).toBe(0)
    expect(deduped.skipped).toBe(1)
  })

  it('rejects malformed files', () => {
    expect(() => parseExportBundle('not json')).toThrow('JSON')
    expect(() => parseExportBundle('{"format":"other"}')).toThrow('HShell')
  })

  it('encrypts embedded keys and decrypts them on import', () => {
    const dir = tempDir('hshell-keys-')
    const keyFile = join(dir, 'id_test')
    const keyMaterial = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----\n'
    writeFileSync(keyFile, keyMaterial)

    const bundle = buildExportBundle(
      {
        folders: [],
        sessions: [makeSession({ auth: { method: 'key', keyPath: keyFile } })]
      },
      { appName: 'HShell', appVersion: '1.0.0', includeKeys: true, password: 'correct horse' }
    ).bundle

    expect(bundle.keys).toHaveLength(1)
    expect(JSON.stringify(bundle)).not.toContain('BEGIN OPENSSH PRIVATE KEY')

    const keysDir = join(dir, 'imported-keys')
    expect(() => importEmbeddedKeys(bundle.keys, 'wrong password', keysDir)).toThrow('口令错误')

    const { keyMap, count } = importEmbeddedKeys(bundle.keys, 'correct horse', keysDir)
    expect(count).toBe(1)
    const imported = keyMap.get(keyFile)!
    expect(readFileSync(imported, 'utf8')).toBe(keyMaterial)
    expect(statSync(imported).mode & 0o777).toBe(0o600)

    const merged = mergeSessions({ folders: [], sessions: [] }, bundle, { keyMap })
    expect(merged.data.sessions[0].auth.keyPath).toBe(imported)
  })

  it('requires a password when exporting keys', () => {
    expect(() =>
      buildExportBundle(
        { folders: [], sessions: [makeSession()] },
        { appName: 'HShell', appVersion: '1.0.0', includeKeys: true }
      )
    ).toThrow('口令')
  })
})

describe('ssh config parsing', () => {
  const config = `
# Global defaults are ignored
User global
Host web
  HostName 10.0.0.5
  User deploy
  Port 2202
  IdentityFile ~/.ssh/deploy_key
  ProxyJump none

Host db1 db2
  User root
  ProxyJump bastion

Host *
  User wildcard

Host quoted
  HostName "%h.internal"
  IdentityFile "~/.ssh/quoted key"
`

  it('parses the supported directive subset', () => {
    const parsed = parseSshConfig(config, { username: 'fallback', home: '/home/tester' })
    expect(parsed.skipped).toBe(1)
    expect(parsed.hosts).toHaveLength(4)

    const web = parsed.hosts.find((host) => host.name === 'web')!
    expect(web).toMatchObject({ hostName: '10.0.0.5', user: 'deploy', port: 2202 })
    expect(web.identityFile).toBe('/home/tester/.ssh/deploy_key')
    expect(web.proxyJump).toBeUndefined()

    const db1 = parsed.hosts.find((host) => host.name === 'db1')!
    expect(db1).toMatchObject({ hostName: 'db1', user: 'root', port: 22, proxyJump: 'bastion' })

    const quoted = parsed.hosts.find((host) => host.name === 'quoted')!
    expect(quoted.hostName).toBe('quoted.internal')
    expect(quoted.identityFile).toBe('/home/tester/.ssh/quoted key')
    expect(quoted.user).toBe('fallback')
  })

  it('converts hosts into valid sessions', () => {
    let counter = 0
    const result = sshConfigToSessions(config, {
      username: 'fallback',
      home: '/home/tester',
      now: NOW,
      idFactory: (prefix) => `${prefix}-${(counter += 1)}`
    })

    expect(result.sessions).toHaveLength(4)
    expect(result.skipped).toBe(1)
    expect(result.sessions[0]).toMatchObject({
      name: 'web',
      host: '10.0.0.5',
      port: 2202,
      username: 'deploy',
      folderId: null,
      proxyJump: null
    })
    expect(result.sessions[0].auth).toEqual({
      method: 'key',
      keyPath: '/home/tester/.ssh/deploy_key'
    })
  })
})

describe('AppStore persistence', () => {
  it('reloads sessions from disk and never writes passwords', () => {
    const dir = tempDir('hshell-store-')
    const store = new AppStore(dir)
    store.saveSession(
      makeSession({ id: 's-persist', auth: { method: 'password', password: 'hunter2' } })
    )

    const raw = readFileSync(join(dir, 'sessions.json'), 'utf8')
    expect(raw).not.toContain('hunter2')

    const reloaded = new AppStore(dir)
    const session = reloaded.list().sessions.find((item) => item.id === 's-persist')
    expect(session).toBeDefined()
    expect(session!.auth.password).toBeUndefined()
    expect(session!.proxyJump).toBeNull()
  })

  it('migrates v1 files and rejects folder cycles', () => {
    const dir = tempDir('hshell-migrate-')
    writeFileSync(
      join(dir, 'sessions.json'),
      JSON.stringify({
        schemaVersion: 1,
        data: [
          {
            ...makeSession({ id: 's-old' }),
            proxyJump: undefined,
            auth: { method: 'password', password: 'plaintext' }
          }
        ]
      })
    )
    writeFileSync(
      join(dir, 'folders.json'),
      JSON.stringify({
        schemaVersion: 1,
        data: [{ id: 'f-old', name: 'Old', parentId: null, sortOrder: 0 }]
      })
    )

    const store = new AppStore(dir)
    const loaded = store.list()
    expect(loaded.sessions.find((item) => item.id === 's-old')?.proxyJump).toBeNull()

    store.saveFolder({ id: 'fa', name: 'A', parentId: null, sortOrder: 10 })
    store.saveFolder({ id: 'fb', name: 'B', parentId: 'fa', sortOrder: 11 })
    expect(() =>
      store.saveFolder({ id: 'fa', name: 'A', parentId: 'fb', sortOrder: 10 })
    ).toThrow('循环')
  })

  it('imports ssh config sessions and skips duplicates', () => {
    const dir = tempDir('hshell-import-')
    const store = new AppStore(dir)
    const sessions = sshConfigToSessions('Host new-host\n  HostName 192.0.2.10\n', {
      username: 'tester',
      idFactory: (prefix) => store.newId(prefix)
    })

    const first = store.importSessions(sessions.sessions, sessions.skipped)
    expect(first.sessions).toBe(1)

    const duplicate = sshConfigToSessions('Host new-host\n  HostName 192.0.2.10\n', {
      username: 'tester',
      idFactory: (prefix) => store.newId(prefix)
    })
    const second = store.importSessions(duplicate.sessions, duplicate.skipped)
    expect(second.sessions).toBe(0)
    expect(second.skipped).toBe(1)
  })
})
