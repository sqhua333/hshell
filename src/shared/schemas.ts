import { z } from 'zod'
import type { StoredLayoutNode } from './types'

export const authSchema = z.object({
  method: z.enum(['password', 'key', 'agent', 'keyboard-interactive']),
  keyPath: z.string().max(4096).optional(),
  keyId: z.string().max(128).optional(),
  password: z.string().max(4096).optional(),
  savePassword: z.boolean().optional()
})

export const jumpHostSchema = z.object({
  id: z.string().min(1).max(128),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255),
  auth: authSchema.optional()
})

export const terminalOptionsSchema = z.object({
  term: z.string().min(1).max(64).default('xterm-256color'),
  theme: z.enum(['dark', 'light', 'solarized']).default('dark'),
  fontSize: z.number().int().min(8).max(40).default(14),
  colorScheme: z.string().min(1).max(40).optional(),
  showTimestamps: z.boolean().optional()
})

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色必须是 #rrggbb 格式')

export const quickCommandSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().trim().min(1).max(64),
  command: z.string().min(1).max(4096),
  sendEnter: z.boolean().optional()
})

export const triggerRuleSchema = z.object({
  id: z.string().min(1).max(128),
  pattern: z.string().min(1).max(512),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  action: z.enum(['send', 'notify']),
  payload: z.string().max(4096),
  enabled: z.boolean().optional()
})

export const highlightRuleSchema = z.object({
  id: z.string().min(1).max(128),
  pattern: z.string().min(1).max(512),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  foreground: colorSchema.optional(),
  background: colorSchema.optional(),
  enabled: z.boolean().optional()
})

export const serialOptionsSchema = z.object({
  path: z.string().min(1).max(255),
  baudRate: z.number().int().min(50).max(4_000_000),
  dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]),
  stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]),
  parity: z.enum(['none', 'even', 'odd', 'mark', 'space']),
  flowControl: z.enum(['none', 'rtscts', 'xonxoff']),
  dtr: z.boolean().optional(),
  rts: z.boolean().optional()
})

export const sessionSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  folderId: z.string().max(128).nullable(),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(255),
  auth: authSchema,
  terminal: terminalOptionsSchema,
  connectionType: z.enum(['ssh', 'serial']).optional(),
  serial: serialOptionsSchema.optional(),
  proxyJump: z.string().max(1024).nullable().optional(),
  jumpHosts: z.array(jumpHostSchema).max(8).optional(),
  quickCommands: z.array(quickCommandSchema).max(100).optional(),
  triggers: z.array(triggerRuleSchema).max(100).optional(),
  highlights: z.array(highlightRuleSchema).max(100).optional(),
  logging: z
    .object({
      enabled: z.boolean(),
      format: z.enum(['text', 'asciinema']),
      directory: z.string().max(4096).optional(),
      timestamps: z.boolean().optional()
    })
    .optional(),
  color: z.string().max(32).optional(),
  createdAt: z.number(),
  updatedAt: z.number()
})

export const folderSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  parentId: z.string().max(128).nullable(),
  sortOrder: z.number()
})

export const connectRequestSchema = z.object({
  runtimeId: z.string().min(1).max(128),
  session: sessionSchema,
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
})

/** Auth data allowed in an exported bundle: never include passwords. */
export const exportedAuthSchema = authSchema.omit({ password: true, savePassword: true })

export const exportedJumpHostSchema = jumpHostSchema.extend({
  auth: exportedAuthSchema.optional()
})

export const exportedSessionSchema = sessionSchema.extend({
  auth: exportedAuthSchema,
  jumpHosts: z.array(exportedJumpHostSchema).max(8).optional()
})

export const EXPORT_FORMAT = 'hshell-sessions'
export const EXPORT_FORMAT_VERSION = 1

/** Private key embedded in an export bundle, encrypted with the user's password. */
export const exportedKeySchema = z.object({
  /** Original `keyPath` as configured in the session. */
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(256),
  salt: z.string().min(1).max(256),
  iv: z.string().min(1).max(64),
  tag: z.string().min(1).max(64),
  /** Base64 AES-256-GCM ciphertext. */
  data: z.string().max(2 * 1024 * 1024)
})

export const exportBundleSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.number().int().min(1).max(EXPORT_FORMAT_VERSION),
  exportedAt: z.number(),
  app: z.object({
    name: z.string().max(64),
    version: z.string().max(64)
  }),
  folders: z.array(folderSchema).max(5000),
  sessions: z.array(exportedSessionSchema).max(5000),
  keys: z.array(exportedKeySchema).max(200).optional()
})

export type ExportBundle = z.infer<typeof exportBundleSchema>
export type ExportedKey = z.infer<typeof exportedKeySchema>

export const keyMetadataSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  algorithm: z.enum(['rsa', 'ecdsa', 'ed25519']),
  bits: z.number().int().min(0),
  comment: z.string().max(256).optional(),
  fingerprint: z.string().min(1).max(128),
  publicKey: z.string().min(1).max(16384),
  hasPassphrase: z.boolean(),
  createdAt: z.number()
})

export const keyGenerateSchema = z.object({
  label: z.string().trim().min(1).max(128),
  algorithm: z.enum(['rsa', 'ecdsa', 'ed25519']),
  bits: z.number().int().min(256).max(8192).optional(),
  passphrase: z.string().max(1024).optional()
})

export const keyImportSchema = z.object({
  label: z.string().trim().min(1).max(128),
  privateKey: z.string().min(1).max(1024 * 1024),
  passphrase: z.string().max(1024).optional()
})

export const vaultUnlockSchema = z.string().min(1).max(1024)

const hostNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001f\u007f\s]+$/, '主机名包含无效字符')

export const tunnelConfigSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/, '转发 ID 无效'),
    runtimeId: z.string().min(1).max(128),
    tunnelType: z.enum(['local', 'remote', 'dynamic']),
    bindHost: hostNameSchema,
    bindPort: z.number().int().min(1).max(65535),
    targetHost: hostNameSchema.optional(),
    targetPort: z.number().int().min(1).max(65535).optional()
  })
  .superRefine((value, ctx) => {
    if (value.tunnelType === 'dynamic') return
    if (!value.targetHost) {
      ctx.addIssue({ code: 'custom', path: ['targetHost'], message: '请填写目标主机' })
    }
    if (value.targetPort === undefined) {
      ctx.addIssue({ code: 'custom', path: ['targetPort'], message: '请填写目标端口' })
    }
  })

export const layoutPaneSchema = z.object({
  sessionId: z.string().min(1).max(128)
})

export const storedLayoutNodeSchema: z.ZodType<StoredLayoutNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('pane'),
      sessionId: z.string().min(1).max(128)
    }),
    z.object({
      type: z.literal('split'),
      direction: z.enum(['horizontal', 'vertical']),
      sizes: z.array(z.number().min(0).max(100)).max(64).optional(),
      children: z.array(storedLayoutNodeSchema).min(1).max(64)
    })
  ])
)

/** Iterative validation so a maliciously deep layout cannot exhaust the stack. */
function layoutTreeIssue(root: StoredLayoutNode): string | null {
  let nodes = 0
  let panes = 0
  const stack: Array<{ node: StoredLayoutNode; depth: number }> = [{ node: root, depth: 1 }]
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!
    nodes += 1
    if (nodes > 256) return '布局节点过多'
    if (depth > 16) return '布局层级过深'
    if (node.type === 'pane') {
      panes += 1
      if (panes > 64) return '面板数量过多'
      continue
    }
    if (node.sizes && node.sizes.length !== node.children.length) return '布局尺寸不匹配'
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 })
  }
  return null
}

const storedLayoutTabSchema = z
  .object({ layout: storedLayoutNodeSchema })
  .superRefine((tab, ctx) => {
    const issue = layoutTreeIssue(tab.layout)
    if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['layout'] })
  })

/** Accepts the current nested tree and layouts written by older versions. */
export const layoutTabSchema = z.union([
  storedLayoutTabSchema,
  z.object({
    panes: z.array(layoutPaneSchema).min(1).max(64),
    direction: z.enum(['horizontal', 'vertical']),
    sizes: z.array(z.number().min(0).max(100)).max(64).optional()
  })
])

export const windowLayoutSchema = z.object({
  tabs: z.array(layoutTabSchema).max(100),
  activeIndex: z.number().int().min(0).max(99)
})

export const recordingSaveSchema = z.object({
  content: z.string().min(1).max(5 * 1024 * 1024),
  defaultName: z
    .string()
    .max(128)
    .regex(/^[^/\\\u0000-\u001f\u007f]+$/, '文件名无效')
    .optional()
})
