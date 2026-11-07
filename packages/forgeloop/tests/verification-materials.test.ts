import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verificationMaterialDigest } from '../src/runtime/verification-materials.js'

describe('verification material digest', () => {
  let root = ''

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function workspace(): string {
    root = mkdtempSync(join(tmpdir(), 'forgeloop-material-digest-'))
    return root
  }

  it('returns empty when verification has no executable material', () => {
    const ws = workspace()
    expect(verificationMaterialDigest(ws)).toBe('')
    mkdirSync(join(ws, 'verification'), { recursive: true })
    writeFileSync(join(ws, 'verification', 'commands.json'), '{}')
    writeFileSync(join(ws, 'verification', 'notes.txt'), 'not executable')
    expect(verificationMaterialDigest(ws)).toBe('')
  })

  it('hashes executable scripts, nested scripts and ignores controls and links', () => {
    const ws = workspace()
    mkdirSync(join(ws, 'verification', 'lib'), { recursive: true })
    mkdirSync(join(ws, 'verification', 'controls'), { recursive: true })
    writeFileSync(join(ws, 'verification', 'run.js'), 'console.log(1)')
    writeFileSync(join(ws, 'verification', 'lib', 'helper.mjs'), 'export const x = 1')
    writeFileSync(join(ws, 'verification', 'controls', 'fault.patch'), 'ignored')
    writeFileSync(join(ws, 'verification', 'run.py'), 'print(1)')
    symlinkSync(join(ws, 'verification', 'run.js'), join(ws, 'verification', 'link.js'))

    const first = verificationMaterialDigest(ws)
    expect(first).not.toBe('')
    expect(verificationMaterialDigest(ws)).toBe(first)

    writeFileSync(join(ws, 'verification', 'controls', 'other.patch'), 'changed')
    expect(verificationMaterialDigest(ws)).toBe(first)

    writeFileSync(join(ws, 'verification', 'lib', 'helper.mjs'), 'export const x = 2')
    expect(verificationMaterialDigest(ws)).not.toBe(first)
  })
})
