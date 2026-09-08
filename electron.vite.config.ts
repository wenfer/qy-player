import { defineConfig } from 'vite';
import { resolve } from 'path';

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
    emptyOutDir: false,
    rollupOptions: {
      // Externalize ALL bare imports (node builtins + npm packages).
      // The main process runs in Node/Electron where node_modules is always
      // available; bundling packages like axios breaks their node adapters
      // (e.g. "adapter http is not available in the build").
      external: (id) => !id.startsWith('.') && !id.startsWith('/'),
      output: {
        format: 'cjs',
      },
    },
    sourcemap: true,
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
