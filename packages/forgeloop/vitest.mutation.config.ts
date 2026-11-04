import { defineConfig } from 'vitest/config'

/**
 * 变异测试专用 vitest 配置：与全量测试保持一致，只排除依赖宿主进程表的 monitor 用例。
 *
 * 变异测试必须衡量真实测试套件的杀伤力，不能只跑快速子集：runtime 流水线的
 * 断言大量位于 candidate-build / continuous-flow / verification / service 等慢用例，
 * 排除它们会把已覆盖的代码记成 NoCoverage，分数失真。
 *
 * tests/monitor.test.ts 的进程聚合用例需要读取宿主的 ps 进程表；Stryker 的
 * worker 沙箱里该采集会返回空表（环境假失败），因此只排除这一个用例。
 * 该用例仍在 make test / make coverage 中运行，monitor 源码也仍在变异范围内。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/monitor.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
  },
})
