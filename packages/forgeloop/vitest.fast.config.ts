import { defineConfig } from 'vitest/config'

/**
 * 快速 CI：只跑不依赖真实 Git/构建/多进程的用例。
 * 慢用例（候选构建、完整流水线、独立验证、契约夹具）由全量 CI 运行。
 * 清单按 2026-11-01 实测单文件耗时 ≥2s 划定；新增慢用例时同步加入。
 */
export const SLOW_TEST_FILES = [
  'tests/candidate-build.test.ts',
  'tests/continuous-flow.test.ts',
  'tests/verification.test.ts',
  'tests/service.test.ts',
  'tests/issue-retry-loop.test.ts',
  'tests/business-review.test.ts',
  'tests/auto-intake.test.ts',
  'tests/integration.test.ts',
  'tests/ops-controls.test.ts',
  'tests/requirement-gate.test.ts',
  'tests/ops-agent.test.ts',
  'tests/architecture-contract.test.ts',
]

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: SLOW_TEST_FILES,
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
  },
})
