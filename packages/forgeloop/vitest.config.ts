import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 测试会 spawn Git/Node 子进程；threads 池在 macOS + Node 26 下与 worker RPC 竞争会长时间挂起。
    // 统一用 forks：每个文件独立进程，子进程退出即隔离，避免超时被误判为行为失败。
    pool: 'forks',
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/index.ts'],
      // 2026-10-23 扩充测试后实测：行/语句 92.16、函数 95.45、分支 85.12。
      // 门槛取略低于实测的整数，阻断回退；历史目标（行/语句 90、分支 85）已达到。
      thresholds: {
        lines: 90,
        functions: 93,
        branches: 84,
        statements: 90,
        // 关键路径单独设门槛，避免被低风险文件平均掉。
        'src/runtime/service.ts': { lines: 85, branches: 78, functions: 92 },
        'src/runtime/coordinator.ts': { lines: 90, branches: 83, functions: 99 },
        'src/records/repository.ts': { lines: 97, branches: 86, functions: 98 },
        'src/domain/verification.ts': { lines: 94, branches: 88, functions: 99 },
        'src/domain/admission.ts': { lines: 100, branches: 100, functions: 100 },
        'src/domain/retry-policy.ts': { lines: 100, branches: 100, functions: 100 },
      },
    },
  },
})
