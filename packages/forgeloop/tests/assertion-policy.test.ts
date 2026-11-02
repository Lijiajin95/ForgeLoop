import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const SRC = resolve(ROOT, 'packages/forgeloop/src')

function lintFile(path: string): { status: number | null; output: string } {
  const result = spawnSync(join(ROOT, 'node_modules/.bin/eslint'), ['--no-ignore', path], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function printConfig(path: string): Record<string, unknown> {
  const result = spawnSync(
    join(ROOT, 'node_modules/.bin/eslint'),
    ['--print-config', path],
    { cwd: ROOT, encoding: 'utf8' },
  )
  return JSON.parse(result.stdout).rules as Record<string, unknown>
}

describe('type assertion policy', () => {
  it('blocks plain `as` and `as any` in business code', () => {
    const file = join(SRC, `domain/__assertion_probe_${randomUUID()}.ts`)
    try {
      writeFileSync(
        file,
        [
          "export const plain = JSON.parse('{}') as { value: string }",
          'export const anyValue = {} as any',
        ].join('\n'),
      )
      const { status, output } = lintFile(file)
      expect(status).not.toBe(0)
      expect(output).toContain('consistent-type-assertions')
      expect(output).toContain('no-explicit-any')
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('allows `as const` in business code', () => {
    const file = join(SRC, `domain/__assertion_probe_${randomUUID()}.ts`)
    try {
      writeFileSync(file, "export const literal = { value: 'x' } as const\n")
      const { status, output } = lintFile(file)
      expect(status, output).toBe(0)
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('keeps boundary files allowing `as` but still blocking `any`', () => {
    const rules = printConfig(join(SRC, 'records/db.ts'))
    expect(rules['@typescript-eslint/consistent-type-assertions']).toEqual([
      2,
      { assertionStyle: 'as' },
    ])
    expect(rules['@typescript-eslint/no-explicit-any']).toEqual([2])
    expect(rules['@typescript-eslint/no-unsafe-assignment']).toEqual([2])
  })

  it('uses `never` for ordinary business files', () => {
    const rules = printConfig(join(SRC, 'domain/ops.ts'))
    expect(rules['@typescript-eslint/consistent-type-assertions']).toEqual([
      2,
      { assertionStyle: 'never' },
    ])
  })
})
