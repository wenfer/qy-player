#!/usr/bin/env node
/**
 * End-to-end scenario: play 《消失的人》 from the 华语电影 library category.
 * Path driven through the real UI: Home → category card → LibraryBrowse →
 * poster card → Detail → 立即播放 → verify MPV actually renders.
 *
 * Usage: node scripts/cdp-play.mjs
 */
import { statSync, readdirSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { execSync } from 'child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ CDP

class CdpClient {
  static async connect(port = 9222) {
    let targets = null;
    for (let i = 0; i < 10; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        break;
      } catch {
        await sleep(500);
      }
    }
    const page = targets?.find((t) => t.type === 'page' && t.url.includes('5173'));
    if (!page) throw new Error('未找到应用页面 target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
    });
    const client = new CdpClient(ws);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    return client;
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.errors = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.text || 'unknown');
      }
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error(`eval 失败: ${res.exceptionDetails.text}`);
    return res.result?.value;
  }

  close() {
    this.ws.close();
  }
}

async function waitFor(cdp, expression, { timeout = 8000, desc = expression } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ok = await cdp.eval(`(() => { try { return Boolean(${expression}); } catch { return false; } })()`);
    if (ok) return true;
    await sleep(250);
  }
  throw new Error(`等待超时: ${desc}`);
}

// ------------------------------------------------------------------ MPV

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
      .map((f) => `/tmp/qy-player/${f}`)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return null;
  }
}

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
        } catch {}
      }
    });
  }

  command(...args) {
    const rid = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`mpv socket timeout: ${args[0]}`));
      }, 15000);
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
}

// ------------------------------------------------------------------ helpers

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------------ main

async function main() {
  console.log('=== 端到端场景：播放「华语电影」分类中的《消失的人》===\n');
  // Clean slate: a leftover mpv from a previous failed run would make
  // isMpvRunning() pass immediately and the stale socket would hang IPC.
  if (isMpvRunning()) {
    console.log('（清理残留 mpv 进程）');
    await killMpv();
  }
  const cdp = await CdpClient.connect();
  await cdp.eval(`
    window.__qy = {
      text: () => document.body.innerText,
      buttonByText: (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(t)),
    };
  `);

  // Step 1: Home settled
  console.log('▶ 1. 首页数据就绪');
  await cdp.eval(`window.location.hash = '#/';`);
  await waitFor(
    cdp,
    `['已连接', '尚未配置媒体服务器', '加载失败'].some((t) => window.__qy.text().includes(t))`,
    { desc: '首页数据就绪' }
  );
  check('首页就绪', true);

  // Step 2: Click the 华语电影 category card
  console.log('▶ 2. 点击「华语电影」分类卡片');
  const clickedCat = await cdp.eval(`
    (() => {
      const card = [...document.querySelectorAll('button[aria-label^="打开媒体库"]')]
        .find((b) => b.textContent.includes('华语电影'));
      card?.click();
      return card ? 'ok' : 'not-found';
    })()
  `);
  if (clickedCat !== 'ok') {
    check('找到「华语电影」分类卡片', false, '分类卡片不存在');
    return finish(cdp);
  }
  check('分类卡片已点击', true);

  // Step 3: LibraryBrowse page renders, find 消失的人
  console.log('▶ 3. 分类浏览页加载');
  await waitFor(cdp, `window.__qy.text().includes('华语电影')`, { desc: '浏览页标题' });
  // PosterCard has aria-label like `消失的人, 电影, 2026年`
  await waitFor(cdp, `[...document.querySelectorAll('[aria-label]')].some((e) => e.getAttribute('aria-label').includes('消失的人'))`, {
    timeout: 15000,
    desc: '《消失的人》卡片出现',
  });
  check('《消失的人》卡片出现在分类中', true);

  // Step 4: Click the card → Detail
  console.log('▶ 4. 点击卡片进入详情页');
  await cdp.eval(`
    [...document.querySelectorAll('[aria-label]')]
      .find((e) => e.getAttribute('aria-label').includes('消失的人'))
      .click();
  `);
  await waitFor(cdp, `window.__qy.buttonByText('立即播放')`, { desc: '立即播放按钮' });
  check('详情页打开（立即播放按钮可见）', true);

  // Step 5: Click 立即播放（直连）
  console.log('▶ 5. 点击「立即播放」（直连/客户端解码）');
  // Snapshot existing sockets so we only accept the NEW mpv's socket later
  const preSocks = new Set(
    (() => {
      try {
        return readdirSync('/tmp/qy-player').filter((f) => f.endsWith('.sock'));
      } catch {
        return [];
      }
    })()
  );
  await cdp.eval(`window.__qy.buttonByText('立即播放')?.click()`);
  check('已点击播放', true);

  // Grab the toast so a failed play attempt reports WHY (handlePlay shows
  // an error toast on every failure path). Tolerant: missing helpers must
  // not abort the scenario.
  await sleep(3000);
  try {
    const toastText = await cdp.eval(`
      document.body.innerText.split('\\n').filter((l) => /开始播放|媒体源|失败|错误|无法/.test(l)).join(' || ')
    `);
    console.log(`  toast: ${toastText || '(无)'}`);
  } catch (err) {
    console.log(`  toast 抓取失败（不阻塞）: ${err.message.slice(0, 80)}`);
  }

  // Step 6: MPV process + socket + playback verification
  console.log('▶ 6. MPV 拉起与播放验证');
  let mpv = null;
  let mpvRunning = false;
  for (let i = 0; i < 30; i++) {
    if (isMpvRunning()) {
      mpvRunning = true;
      break;
    }
    await sleep(500);
  }
  check('MPV 进程启动', mpvRunning);

  let sockPath = null;
  if (mpvRunning) {
    for (let i = 0; i < 20; i++) {
      // Only accept a socket created AFTER the play click (stale sockets
      // from a previous session hang every IPC call)
      sockPath = findMpvSocket();
      if (sockPath && !preSocks.has(sockPath.split('/').pop())) break;
      sockPath = null;
      await sleep(500);
    }
    check('MPV IPC socket 就绪（新会话）', !!sockPath);
  }

  if (sockPath) {
    mpv = new MpvSocket(sockPath);
    await mpv.ready;

    let duration = 0;
    for (let i = 0; i < 20; i++) {
      duration = (await mpv.get('duration').catch(() => 0)) || 0;
      if (duration > 0) break;
      await sleep(500);
    }
    check('媒体元数据加载（duration > 0）', duration > 0, `实际 ${duration}`);

    // Wait for playback to start
    let paused = true;
    for (let i = 0; i < 16; i++) {
      paused = await mpv.get('pause').catch(() => true);
      if (!paused) break;
      await sleep(500);
    }
    check('开始播放（未暂停）', paused === false);

    // Seek to 30% to skip a possibly-black intro, then verify the frame
    const seekTo = duration > 120 ? 60 : Math.max(5, Math.floor(duration * 0.3));
    await mpv.command('seek', seekTo, 'absolute').catch(() => {});
    // Poll until playback reaches the target - seeking on soft-decoded
    // 4K HEVC takes seconds, and a fixed sleep lands mid-black-intro.
    for (let i = 0; i < 40; i++) {
      const tp = (await mpv.get('time-pos').catch(() => -1)) || -1;
      if (tp >= seekTo - 1) break;
      await sleep(500);
    }
    await sleep(1000); // let the first frames render

    const vo = await mpv.get('current-vo').catch(() => null);
    const width = await mpv.get('video-params/w').catch(() => 0);
    const height = await mpv.get('video-params/h').catch(() => 0);
    check('视频输出管线建立', !!vo, `current-vo=${vo ?? '无'}`);
    check('视频参数解析', width > 0 && height > 0, `${width}x${height}`);

    const shotFile = `/tmp/cdp-play-disappear-${Date.now()}.png`;
    await mpv.command('screenshot-to-file', shotFile).catch(() => {});
    await sleep(5000);
    let frameSize = 0;
    try {
      frameSize = statSync(shotFile).size;
    } catch {}
    check('画面非黑屏（帧截图 > 30KB）', frameSize > 30000, `${(frameSize / 1024).toFixed(1)} KB，文件: ${shotFile}`);
  }

  // Step 7: Cleanup
  console.log('▶ 7. 清理');
  if (mpv) {
    await mpv.command('quit').catch(() => {});
  }
  try {
    execSync('pkill -x mpv', { stdio: 'pipe' });
  } catch {}
  await sleep(1500);
  check('MPV 已清理', !isMpvRunning());

  check('页面无未捕获异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '));

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n=== 场景测试: ${passed}/${results.length} 通过${failed ? `，${failed} 失败` : ''} ===`);
  if (failed) {
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    }
  }
  cdp.close();
  process.exit(failed ? 1 : 0);
}

function finish(cdp) {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== 场景测试: ${passed}/${results.length} 通过 ===`);
  cdp.close();
  process.exit(1);
}

main().catch((err) => {
  console.error('❌ 场景测试错误:', err.message);
  try {
    execSync('pkill -x mpv', { stdio: 'pipe' });
  } catch {}
  process.exit(1);
});
