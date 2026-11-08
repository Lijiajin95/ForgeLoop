/**
 * 证据归档 CLI：实现见 packages/forgeloop/src/records/evidence-archive.ts。
 *
 * 用法：node scripts/ts/evidence-archive.ts <source.sqlite> <target.sqlite>
 */
import { archiveDatabase } from '../../packages/forgeloop/lib/records/evidence-archive.js'

function runCli(): void {
  const [source, target] = process.argv.slice(2)
  if (!source || !target) {
    console.error('用法：node scripts/ts/evidence-archive.ts <source.sqlite> <target.sqlite>')
    process.exit(1)
  }
  const result = archiveDatabase(source, target)
  process.stdout.write(`[evidence-archive] ${result.target}（${result.bytes} 字节）\n`)
}

try {
  runCli()
} catch (error) {
  console.error(`[evidence-archive] ${(error as Error).message}`)
  process.exit(1)
}
