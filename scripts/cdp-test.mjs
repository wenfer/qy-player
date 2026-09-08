#!/usr/bin/env node
/**
 * CDP-based UI automation tests for qy-player.
 *
 * Uses the built-in Node 22+ WebSocket/fetch - no extra dependencies.
 * Requires the app running with: electron . --remote-debugging-port=9222
 * (scripts/restart-app.sh does this).
 *
 * Usage:  node scripts/cdp-test.mjs [--screenshot-dir /tmp]
 *         npm run test:ui
 */

const CDP_PORT = 9222;
const SCREENSHOT_DIR = (() => {
  const i = process.argv.indexOf('--screenshot-dir');
  return i > -1 ? process.argv[i + 1] : '/tmp';
})();

import { readdirSync, statSync } from 'fs';
import { createConnection } from 'net';
import { execSync } from 'child_process';

// ------------------------------------------------------------ MPV helpers

function isMpvRunning() {
  try {
    execSync('pgrep -x mpv', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function findMpvSocket() {
  try {
    return readdirSync('/tmp/qy-player')
      .filter((f) => f.endsWith('.sock'))
      .map((f) => ({ path: `/tmp/qy-player/${f}`, mtime: statSync(`/tmp/qy-player/${f}`).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]?.path;
  } catch {
    return null;
  }
}

/** Minimal mpv JSON-IPC client over the unix socket. */
class MpvSocket {
  constructor(path) {
    this.pending = new Map();
    this.requestId = 0;
    this.buffer = '';
    this.ready = new Promise((resolve, reject) => {
      this.socket = createConnection(path, resolve);
      this.socket.on('error', reject);
    });
    this.socket.on('data', (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.request_id && this.pending.has(msg.request_id)) {
            const { resolve, reject } = this.pending.get(msg.request_id);
            this.pending.delete(msg.request_id);
            if (msg.error && msg.error !== 'success') reject(new Error(msg.error));
            else resolve(msg.data);
          }
        } catch {
          // ignore malformed lines
        }
      }
    });
  }

  command(...args) {
    const rid = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`mpv socket timeout: ${args[0]}`));
      }, 8000);
      this.pending.set(rid, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(JSON.stringify({ request_id: rid, command: args }) + '\n');
    });
  }

  get(prop) {
    return this.command('get_property', prop);
  }

  quit() {
    return this.command('quit');
  }

  close() {
    try {
      this.socket?.destroy();
    } catch {}
  }
}

async function killMpv() {
  try {
    execSync('pkill -x mpv', { stdio: 'pipe' });
  } catch {}
  for (let i = 0; i < 10; i++) {
    if (!isMpvRunning()) return true;
    await sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------- CDP client

class CdpClient {
  /** Connect to the app's main page target. */
  static async connect(port = CDP_PORT) {
    // Discover targets; retry briefly since the app may still be starting
    let targets = null;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`);
        targets = await res.json();
        break;
      } catch {
        await sleep(500);
      }
    }
    if (!targets) throw new Error(`无法连接 CDP 端口 ${port}（应用未以 --remote-debugging-port 启动？）`);

    const page = targets.find((t) => t.type === 'page' && /localhost:5173|index\.html/.test(t.url));
    if (!page) {
      throw new Error(`未找到应用页面 target。可用: ${targets.map((t) => `${t.type}:${t.url}`).join(', ')}`);
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
    });

    const client = new CdpClient(ws);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Log.enable');
    return client;
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        this.consoleErrors.push(text);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(msg.params.exceptionDetails?.text || 'unknown');
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.consoleErrors.push(`[log] ${msg.params.entry.text}`);
      }
    };

    ws.onclose = () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('CDP 连接已关闭'));
      }
      this.pending.clear();
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression and return its value. */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`eval 失败: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
    }
    return res.result?.value;
  }

  async screenshot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = `${SCREENSHOT_DIR}/cdp-${name}-${Date.now()}.png`;
    const { writeFileSync } = await import('fs');
    writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  }

  close() {
    this.ws.close();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until the expression is truthy. */
async function waitFor(cdp, expression, { timeout = 5000, interval = 250, desc = expression } = {}) {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await cdp.eval(`(() => { try { return Boolean(${expression}); } catch { return false; } })()`);
    if (lastValue) return true;
    await sleep(interval);
  }
  throw new Error(`等待超时 (${timeout}ms): ${desc}`);
}

// ---------------------------------------------------------------- assertions

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
}

function check(name, pass, detail = '') {
  results.push({ group: currentGroup, name, pass: !!pass, detail });
  const icon = pass ? '✓' : '✗';
  console.log(`  ${icon} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
  return pass;
}

async function runCase(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (err) {
    check(`${name}（执行异常）`, false, err.message);
  }
}

// Test helpers (run inside the page)
const HELPERS = `
window.__qy = {
  text: () => document.body.innerText,
  buttons: () => [...document.querySelectorAll('button')],
  buttonByText: (t) => window.__qy.buttons().find((b) => b.textContent.trim().includes(t)),
  setInput: (el, value) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  },
  waitFor: (fn, timeout = 5000) => new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try { if (fn()) return resolve(true); } catch {}
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 200);
    };
    tick();
  }),
};
`;

/** Navigate the hash router and wait for a marker. */
async function navigate(cdp, hash, waitExpr, desc) {
  await cdp.eval(`window.location.hash = ${JSON.stringify(hash)};`);
  await waitFor(cdp, waitExpr, { timeout: 6000, desc: `${hash} → ${desc}` });
}

// ---------------------------------------------------------------- test cases

async function main() {
  console.log('=== qy-player CDP 界面自动化测试 ===\n');
  const cdp = await CdpClient.connect();
  const startErrors = cdp.consoleErrors.length + cdp.pageErrors.length;
  await cdp.eval(HELPERS);

  group('加载');
  await runCase('应用初始加载', async () => {
    await waitFor(cdp, `document.querySelector('#root')?.children.length > 0`, { desc: '#root 渲染内容' });
    check('React 应用已挂载', true);
  });

  await runCase('导航侧边栏存在', async () => {
    const ok = await cdp.eval(`!!document.querySelector('nav') || window.__qy.buttons().length > 0`);
    check('导航元素存在', ok);
  });

  group('首页');
  await runCase('首页渲染', async () => {
    // Wait until async data has settled: either servers connected, or an
    // explicit empty/error state. Without this, assertions race the loader.
    await navigate(
      cdp,
      '#/',
      `['已连接', '尚未配置媒体服务器', '加载失败'].some((t) => window.__qy.text().includes(t))`,
      '首页数据就绪'
    );
    check('首页可见', true);
    const hasServer = await cdp.eval(`window.__qy.text().includes('已连接')`);
    if (hasServer) {
      const libCards = await cdp.eval(`[...document.querySelectorAll('button[aria-label^="打开媒体库"]')].length`);
      check('分类卡片渲染', libCards > 0, `实际 ${libCards} 张`);
      const rows = await cdp.eval(`[...document.querySelectorAll('h2, [aria-label]')].map(e => e.textContent).join('|')`);
      check('继续观看/最近添加区块', /继续观看|最近添加|媒体库/.test(rows), `实际: ${rows.slice(0, 80)}`);
    } else {
      check('未配置服务器（跳过数据断言）', true);
    }
  });

  group('设置页');
  await runCase('打开设置页', async () => {
    await navigate(cdp, '#/settings', `window.__qy.text().includes('设置')`, '设置页');
    check('设置页可见', true);
  });

  await runCase('服务器列表/添加表单', async () => {
    const addBtn = await cdp.eval(`!!window.__qy.buttonByText('添加')`);
    check('「添加」按钮存在', addBtn);
    await cdp.eval(`window.__qy.buttonByText('添加')?.click()`);
    await waitFor(cdp, `!!document.querySelector('#server-url')`, { desc: '服务器表单出现' });
    check('服务器表单出现', true);

    // Fill form (React controlled inputs need the native setter)
    await cdp.eval(`
      window.__qy.setInput(document.querySelector('#server-type'), 'emby');
      window.__qy.setInput(document.querySelector('#server-name'), 'CDP测试');
      window.__qy.setInput(document.querySelector('#server-url'), 'http://10.229.160.54:8096');
      window.__qy.setInput(document.querySelector('#server-username'), 'qiuyuan');
      'ok'
    `);
    const filled = await cdp.eval(`document.querySelector('#server-url').value`);
    check('表单可填写', filled === 'http://10.229.160.54:8096', `实际 "${filled}"`);
    const hasEye = await cdp.eval(`!!document.querySelector('button[aria-label="显示密码"], button[aria-label="隐藏密码"]')`);
    check('密码显隐按钮存在', hasEye);

    // Cancel the form so the test doesn't save a server
    await cdp.eval(`window.__qy.buttonByText('取消')?.click()`);
    await waitFor(cdp, `!document.querySelector('#server-url')`, { desc: '表单关闭' });
    check('取消后表单关闭', true);
  });

  group('详情页');
  await runCase('详情页导航与返回', async () => {
    // Return home first (previous group leaves us on /settings)
    await navigate(cdp, '#/', `['已连接', '尚未配置媒体服务器', '加载失败'].some((t) => window.__qy.text().includes(t))`, '首页数据就绪');
    const hasCw = await cdp.eval(`!!window.__qy.buttonByText('继续观看')`);
    if (!hasCw) {
      check('无继续观看条目（跳过）', true);
      return;
    }
    // Click the first poster card in the continue-watching row
    await cdp.eval(`
      (() => {
        const row = window.__qy.buttons().find((b) => b.textContent.trim() === '继续观看');
        const card = row?.parentElement?.querySelector('[role="button"], article, [tabindex="0"]');
        card?.click();
      })()
    `);
    await waitFor(
      cdp,
      `window.__qy.text().includes('立即播放') || window.__qy.text().includes('返回')`,
      { desc: '详情页出现' }
    );
    check('详情页打开', true);
    const backBtn = await cdp.eval(`window.__qy.buttonByText('返回')`);
    check('返回按钮存在', !!backBtn);
    await cdp.eval(`window.__qy.buttonByText('返回')?.click()`);
    await waitFor(cdp, `window.__qy.text().includes('首页') || window.__qy.text().includes('媒体库')`, { desc: '返回首页' });
    check('返回正常', true);
  });

  group('播放端到端');
  let mpv = null;
  await runCase('海报播放按钮拉起 MPV', async () => {
    // Return home and wait for data (same readiness rule as the home group)
    await navigate(cdp, '#/', `['已连接', '尚未配置媒体服务器', '加载失败'].some((t) => window.__qy.text().includes(t))`, '首页数据就绪');
    // Click the first poster card's play button (PosterCard = <article>;
    // the PlayerControls play toggle lives outside articles, so this is safe)
    const clicked = await cdp.eval(`(document.querySelector('article button[aria-label^="播放"]')?.click(), 'ok')`);
    if (clicked !== 'ok') {
      check('无可播放卡片（跳过）', true);
      return;
    }
    for (let i = 0; i < 30; i++) {
      if (isMpvRunning()) break;
      await sleep(500);
    }
    check('MPV 进程启动', isMpvRunning());
    if (!isMpvRunning()) return;

    let sockPath = null;
    for (let i = 0; i < 20; i++) {
      sockPath = findMpvSocket();
      if (sockPath) break;
      await sleep(500);
    }
    check('MPV IPC socket 就绪', !!sockPath);
    if (!sockPath) return;

    mpv = new MpvSocket(sockPath);
    await mpv.ready;

    let duration = 0;
    for (let i = 0; i < 20; i++) {
      duration = (await mpv.get('duration').catch(() => 0)) || 0;
      if (duration > 0) break;
      await sleep(500);
    }
    check('媒体已加载（duration > 0）', duration > 0, `实际 ${duration}`);
  });

  await runCase('播放位置持续推进', async () => {
    if (!mpv) {
      check('无 MPV 连接（跳过）', true);
      return;
    }
    const t1 = (await mpv.get('time-pos').catch(() => 0)) || 0;
    await sleep(4000);
    const t2 = (await mpv.get('time-pos').catch(() => 0)) || 0;
    check('播放位置持续推进', t2 > t1 + 2, `${t1.toFixed(1)}s → ${t2.toFixed(1)}s（4秒内应前进 >2s）`);
  });

  await runCase('播放画面验证（视频/音频管线 + 非黑屏截图）', async () => {
    if (!mpv) {
      check('无 MPV 连接（跳过）', true);
      return;
    }
    // Wait until playback actually starts (pause should clear after buffering)
    let paused = true;
    for (let i = 0; i < 16; i++) {
      paused = await mpv.get('pause').catch(() => true);
      if (!paused) break;
      await sleep(500);
    }
    check('未处于暂停/缓冲', paused === false, `pause=${paused}`);

    const vo = await mpv.get('current-vo').catch(() => null);
    const ao = await mpv.get('current-ao').catch(() => null);
    const width = await mpv.get('video-params/w').catch(() => 0);
    const height = await mpv.get('video-params/h').catch(() => 0);
    check('视频输出管线已建立', !!vo, `current-vo=${vo ?? '未配置'}`);
    check('音频输出管线已建立', !!ao, `current-ao=${ao ?? '未配置'}`);
    check('视频参数解析成功', width > 0 && height > 0, `实际 ${width}x${height}`);

    // Seek to the middle of the video: intros are commonly a black screen
    // with credits, which would make the frame check below a false positive.
    const dur = (await mpv.get('duration').catch(() => 0)) || 0;
    const seekTo = dur > 120 ? 60 : Math.max(5, Math.floor(dur * 0.3));
    await mpv.command('seek', seekTo, 'absolute').catch(() => {});
    // Poll until playback reaches the target (fixed sleep lands mid-black-intro)
    for (let i = 0; i < 40; i++) {
      const tp = (await mpv.get('time-pos').catch(() => -1)) || -1;
      if (tp >= seekTo - 1) break;
      await sleep(500);
    }
    await sleep(1000); // let the first frames render

    // The decisive check: capture a frame and verify it is NOT a black screen.
    // A real video frame compresses to tens of KB; a blank frame to a few KB.
    const shotFile = `/tmp/cdp-mpv-frame-${Date.now()}.png`;
    await mpv.command('screenshot-to-file', shotFile).catch(() => {});
    await sleep(5000); // 35MB PNG write-out takes a moment
    let frameSize = 0;
    try {
      frameSize = statSync(shotFile).size;
    } catch {}
    check('画面非黑屏（帧截图大小合理）', frameSize > 30000, `${(frameSize / 1024).toFixed(1)} KB（<30KB 视为黑屏）, 文件: ${shotFile}`);
  });

  await runCase('清理：退出 MPV', async () => {
    if (mpv) {
      await mpv.quit().catch(() => {});
      mpv.close();
      mpv = null;
    }
    if (isMpvRunning()) {
      await killMpv();
    }
    check('MPV 已退出', !isMpvRunning());
  });

  group('健康检查');
  await runCase('页面错误监控', async () => {
    // Errors that appeared DURING the test run (not before it started)
    const newErrors = cdp.pageErrors.length + cdp.consoleErrors.length - startErrors;
    const errorLines = [...cdp.pageErrors, ...cdp.consoleErrors.slice(startErrors)].slice(0, 3);
    check('无未捕获异常/console 错误', newErrors === 0, errorLines.join(' | ') || `${newErrors} 条`);
  });

  await runCase('截图', async () => {
    const file = await cdp.screenshot('final');
    check('截图已保存', true, file);
  });

  // ------------------------------------------------------------ report
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n=== 测试报告: ${passed}/${results.length} 通过${failed ? `，${failed} 失败` : ''} ===`);
  if (failed) {
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ✗ [${r.group}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    }
  }
  cdp.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 测试框架错误:', err.message);
  process.exit(1);
});
