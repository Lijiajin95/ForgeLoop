import { defineConfig } from 'vitest/config'
import { SLOW_TEST_FILES } from './vitest.fast.config.js'

/**
 * 非 runtime 分片的变异配置：与快速 CI 一致，额外排除依赖宿主进程表的 monitor 用例。
 *
 * domain/records/config/session 的行为断言都在快速用例里；把候选构建、完整流水线等
 * 慢用例再跑一遍只会拖慢分片，不会显著增加杀伤。runtime 分片使用全量配置。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...SLOW_TEST_FILES, 'tests/monitor.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
  },
})
