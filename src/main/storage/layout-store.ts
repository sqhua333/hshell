import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WindowLayout } from '@shared/types'
import { windowLayoutSchema } from '@shared/schemas'
import { readEnvelope, writeEnvelope } from './json-file'

const SCHEMA_VERSION = 1

const EMPTY_LAYOUT: WindowLayout = { tabs: [], activeIndex: 0 }

/** Persists the open tabs and split sizes to `<userData>/layouts.json`. */
export class LayoutStore {
  private readonly file: string

  constructor(userDataDir: string) {
    mkdirSync(userDataDir, { recursive: true })
    this.file = join(userDataDir, 'layouts.json')
  }

  get(): WindowLayout {
    const result = readEnvelope(this.file)
    const parsed = windowLayoutSchema.safeParse(result.data)
    return parsed.success ? parsed.data : { ...EMPTY_LAYOUT, tabs: [] }
  }

  save(layout: WindowLayout): void {
    const checked = windowLayoutSchema.parse(layout)
    writeEnvelope(this.file, checked, SCHEMA_VERSION)
  }
}
