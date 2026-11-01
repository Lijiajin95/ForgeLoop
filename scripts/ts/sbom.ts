/**
 * 生成 CycloneDX 1.5 SBOM（直接依赖 + 锁定版本）。
 * 只读取 package-lock.json，不联网；输出到 dist/sbom.cdx.json。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = process.cwd()
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
  lockfileVersion?: number
  packages?: Record<string, { version?: string; dev?: boolean }>
}
const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/forgeloop/package.json'), 'utf8')) as {
  name: string
  version: string
}

const components = Object.entries(lock.packages ?? {})
  .filter(([path, meta]) => path.startsWith('node_modules/') && meta.version)
  .map(([path, meta]) => {
    const name = path.replace(/^node_modules\//, '').replace(/\/node_modules\//g, '/')
    return {
      type: 'library',
      name,
      version: meta.version,
      purl: `pkg:npm/${name}@${meta.version}`,
      ...(meta.dev ? { scope: 'optional' } : {}),
    }
  })
  .sort((left, right) => left.name.localeCompare(right.name))

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      name: pkg.name,
      version: pkg.version,
      purl: `pkg:npm/${pkg.name}@${pkg.version}`,
    },
  },
  components,
}

const target = join(ROOT, 'dist/sbom.cdx.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify(bom, null, 2)}\n`, 'utf8')
console.log(`[sbom] ${components.length} 个组件 → dist/sbom.cdx.json`)
