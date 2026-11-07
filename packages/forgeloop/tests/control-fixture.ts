import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ForgeLoopRuntime } from '../src/runtime/service.js'
import { runFormalTest } from '../src/runtime/formal-test.js'
import { sha256OfText } from '../src/domain/delivery.js'

/** 对照副本中的命令按“已知错误实现”失败；正式候选仍走真实命令执行。 */
export const controlAwareFormalTest: typeof runFormalTest = async (request) => {
  if (request.cwd.includes('/controls/')) {
    const output = 'target rule broken: injected fault'
    mkdirSync(dirname(request.logPath), { recursive: true })
    writeFileSync(request.logPath, output, 'utf8')
    return {
      exitCode: 1,
      timedOut: false,
      aborted: false,
      logPath: request.logPath,
      logSha256: sha256OfText(output),
      durationMs: 1,
      output,
    }
  }
  return runFormalTest(request)
}

/** 为当前测试会话登记一份可自检通过的对照，供只关心流程的用例使用。 */
export async function registerSmokeControl(
  runtime: ForgeLoopRuntime,
  reqId: string,
  label: string,
): Promise<void> {
  const outcome = await runtime.verificationTool.writeControl(reqId, {
    label,
    patch:
      'diff --git a/fault-marker.txt b/fault-marker.txt\nnew file mode 100644\n--- /dev/null\n+++ b/fault-marker.txt\n@@ -0,0 +1 @@\n+broken\n',
    expectedFailureOutput: 'target rule broken',
  })
  if (!outcome.ok) throw new Error(outcome.text)
}
