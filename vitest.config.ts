import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    setupFiles: ['tests/setup.ts'],
    // 80+ 文件并行 + 每个 jsdom 文件都要现建环境，单机（老机器）负载下
    // 个别用例的墙钟时间会超过默认 5s → 假红。放宽上限只影响"本来就慢"
    // 的用例，真正卡死的仍会失败。见 tasks/todo.md QYP2P-006。
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@preload': resolve(__dirname, 'src/preload'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
