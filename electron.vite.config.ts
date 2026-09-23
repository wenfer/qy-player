import { defineConfig } from 'vite';
import { isAbsolute, resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: {
        main: resolve(__dirname, 'src/main/index.ts'),
        preload: resolve(__dirname, 'src/preload/index.ts'),
      },
      formats: ['cjs'],
      fileName: (_format, entryName) => `${entryName}.cjs`,
    },
    outDir: 'out',
    // 只在 build:main（串行构建的第一步）清空：preload/renderer 的构建会往同
    // 一个 out/ 写，谁都清空就会互相删掉对方的产物。不清空的话，共享 chunk
    // （`ipc-channels-<hash>.cjs`）每次内容变化都留下一个新文件，out/** 是
    // 整体进包的，几十个历史 chunk 会被一起打进安装包。
    emptyOutDir: process.env.QY_CLEAN_OUT === '1',
    rollupOptions: {
      // Externalize ALL bare imports (node builtins + npm packages).
      // The main process runs in Node/Electron where node_modules is always
      // available; bundling packages like axios breaks their node adapters
      // (e.g. "adapter http is not available in the build").
      //
      // 必须用 path.isAbsolute，不能写 `!id.startsWith('/')`：入口模块是以
      // **绝对路径**送进来的，Windows 上是 `D:\a\...\src\main\index.ts`，
      // 既不以 '.' 也不以 '/' 开头 → 被判成 external → rollup 直接抛
      // `Entry module "src/main/index.ts" cannot be external`（1.5.0 三端
      // CI 实测，Windows job 挂在这里；POSIX 主机上 isAbsolute 与
      // startsWith('/') 完全等价，改它不影响 Linux/mac）
      external: (id) => !id.startsWith('.') && !isAbsolute(id),
      output: {
        format: 'cjs',
      },
    },
    // hidden：仍然生成 .map 落盘（出问题时可以拿它还原栈），但不写
    // `//# sourceMappingURL` 注释——preload 与它的共享 chunk 是在渲染器的
    // DevTools 上下文里加载的，dev 下页面来自 vite（root=src/renderer），
    // 按注释去取 /home/.../out/*.map 只会拿到 index.html，控制台便每刷一次
    // 就报两条 "Could not parse content ... Unexpected token '<'"。
    sourcemap: 'hidden',
    minify: false,
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@preload': resolve(__dirname, 'src/preload'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
