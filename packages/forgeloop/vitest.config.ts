import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 测试会 spawn Git/Node 子进程；threads 池在 macOS + Node 26 下与 worker RPC 竞争会长时间挂起。
    // 统一用 forks：每个文件独立进程，子进程退出即隔离，避免超时被误判为行为失败。
    pool: 'forks',
    // 真实 Git/子进程流程在满载（覆盖率并行）时会到 25–30 秒：单用例上限放宽到 60 秒，
    // 仍有明确上界，挂起仍会被判失败。需要更久的个别用例单独声明超时。
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // 入口装配与打包 CLI 同样纳入逐文件门槛；不再排除任何源码。
      // 默认排除项会把 formal-test.ts 当成测试文件；这里只保留真正的构建/依赖目录。
      // `__assertion_probe_*` 是断言规则用例临时写入 src 的探针文件（用完即删）；
      // 并行跑覆盖率时它可能被计入统计而记成 0%，不能算业务源码。
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/*.d.ts',
        '**/__assertion_probe_*.ts',
      ],
      // 所有被统计源码逐文件检查，不再只靠全局平均或少数关键文件豁免。
      // 任何一个文件低于任一项门槛都会失败；新增源码自动纳入。
      thresholds: {
        lines: 90,
        functions: 95,
        branches: 85,
        statements: 90,
        // 所有源码逐文件检查；新增文件自动纳入，不再只靠全局平均。
        perFile: true,
        // 可靠性看板仍引用这六个关键文件的门槛；它们不低于全局门槛。
        'src/runtime/service.ts': { lines: 90, branches: 85, functions: 95 },
        'src/runtime/coordinator.ts': { lines: 90, branches: 85, functions: 99 },
        'src/records/repository.ts': { lines: 97, branches: 86, functions: 98 },
        'src/domain/verification.ts': { lines: 94, branches: 88, functions: 99 },
        'src/domain/admission.ts': { lines: 100, branches: 100, functions: 100 },
        'src/domain/retry-policy.ts': { lines: 100, branches: 100, functions: 100 },
      },
    },
  },
})
