import { defineConfig } from 'vitest/config'
import { SLOW_TEST_FILES } from './vitest.fast.config.js'

/**
 * 变异测试专用 vitest 配置：在快速配置的基础上排除依赖宿主进程表的用例。
 *
 * tests/monitor.test.ts 的进程聚合用例需要读取宿主的 ps 进程表；Stryker 的
 * worker 沙箱里该采集会返回空表（环境假失败），导致初始测试失败、整轮变异无法开始。
 * 该用例仍在 make test / make coverage 中运行，monitor 源码也仍在全量变异范围内；
 * 这里只调整变异执行器的测试选择，不放宽任何门槛、不排除业务源码。
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
