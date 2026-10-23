import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
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
      },
    },
  },
})
