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
      // 入口装配与打包 CLI 同样纳入逐文件门槛；不再排除任何源码。
      // 默认排除项会把 formal-test.ts 当成测试文件；这里只保留真正的构建/依赖目录。
      exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.d.ts'],
      // 所有被统计源码逐文件检查，不再只靠全局平均或少数关键文件豁免。
      // 任何一个文件低于任一项门槛都会失败；新增源码自动纳入。
      thresholds: {
        lines: 90,
        functions: 93,
        branches: 84,
        statements: 90,
        // 所有源码逐文件检查；新增文件自动纳入，不再只靠全局平均。
        perFile: true,
        // 可靠性看板仍引用这六个关键文件的门槛；它们不替代上面的全量逐文件门槛。
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
