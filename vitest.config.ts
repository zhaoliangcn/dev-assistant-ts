import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // 排除：类型声明模块（无可执行语句，只产生 0% 噪声）与需要 TTY/ink 的 CLI 入口
      exclude: [
        'src/**/*.d.ts',
        'src/main.ts',
        'src/repl.ts',
        'src/ui/bridge.ts',
        'src/hooks/types.ts',
        'src/llm/models.ts',
        'src/llm/provider/types.ts',
        'src/tools/spec.ts',
      ],
      // 棘轮阈值：贴近当前实测值（88.1/82.5/87.9/88.1）略留余量，防止覆盖率回退
      thresholds: {
        statements: 85,
        branches: 78,
        functions: 84,
        lines: 85,
      },
    },
  },
})
