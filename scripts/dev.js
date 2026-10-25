#!/usr/bin/env node
import { spawn } from 'child_process';
import { existsSync } from 'fs';
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
const macAppMpv = '/Applications/QY Player.app/Contents/Resources/mpv/mpv';
const devMpvPath = process.env.QY_MPV_PATH || process.env.MPV_PATH || (process.platform === 'darwin' && existsSync(macAppMpv) ? macAppMpv : undefined);

const electron = spawn('npx', ['electron', '.', '--remote-debugging-port=9222', '--no-sandbox'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(devMpvPath ? { QY_MPV_PATH: devMpvPath, MPV_PATH: devMpvPath } : {}),
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
