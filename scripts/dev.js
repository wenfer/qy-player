#!/usr/bin/env node
import { spawn } from 'child_process';
import { createServer } from 'vite';
import { build } from 'vite';

// Step 1: Build main and preload
console.log('[dev] Building main process...');
await build({
  configFile: './electron.vite.config.ts',
  build: {
    watch: null,
  },
});
console.log('[dev] Main process built.');

// Step 2: Start Vite dev server for renderer
const vite = await createServer({
  configFile: './vite.renderer.config.ts',
});

await vite.listen();
const url = vite.resolvedUrls.local[0];
console.log(`[dev] Vite dev server running at ${url}`);

// Step 3: Launch Electron
const electron = spawn('npx', ['electron', '.'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    VITE_DEV_SERVER_URL: url,
  },
});

electron.on('close', (code) => {
  console.log(`[dev] Electron exited with code ${code}`);
  vite.close();
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  electron.kill('SIGINT');
  vite.close();
});
