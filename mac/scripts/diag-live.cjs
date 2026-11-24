#!/usr/bin/env node
'use strict';
// 优酷 Mac 版 · 运行时诊断（只读）
// 通过本机调试端口读取补丁记录在播放页里的诊断信息 globalThis.__youku4kDiag，
// 判断「智能 4K（固定）」为什么没出现。只读取画质元数据（分辨率/档号/类型/码率），不读取播放地址、Cookie 或账号字段。
//
// 用法：
//   1. ⌘Q 完全退出优酷
//   2. open -a "优酷" --args --remote-debugging-port=9222
//   3. 打开一部 VIP 影片，等画面出来、打开一次画质菜单
//   4. node scripts/diag-live.cjs
//   5. 结束后 ⌘Q 退出，再正常打开优酷（关闭调试端口）

const PORT = Number(process.env.YK_DEBUG_PORT || 9222);
const strip = u => String(u || '').replace(/[?#].*$/, '');

const EXPRESSION = `(() => {
  const strip = u => String(u || '').replace(/[?#].*$/, '');
  const scripts = [...document.querySelectorAll('script[src]')].map(s => strip(s.src)).filter(s => /kplayer|kuplayer/.test(s));
  const v = [...document.querySelectorAll('video')].map(x => x.videoWidth + 'x' + x.videoHeight);
  const text = document.body ? document.body.innerText : '';
  return JSON.stringify({ title: document.title.slice(0, 60), scripts, videos: v, menuHas4k: text.includes('智能 4K（固定）'), diag: globalThis.__youku4kDiag || null });
})()`;

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { } reject(new Error('超时')); }, 6000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    ws.onmessage = event => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString());
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { }
      if (msg.error) reject(new Error(msg.error.message));
      else if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text || '执行出错'));
      else resolve(msg.result?.result?.value);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); };
  });
}

const REASONS = {
  'ok': '条件全部满足，本应加入菜单',
  'not-vip': '播放器认为当前账号不是 VIP',
  'no-auto-stream': '当前影片的流列表里没有「智能」(auto) 流',
  'no-auto-hls': '「智能」流没有 HLS 地址',
  'no-hlscontent': '「智能」流没有内联的自适应清单（可能要先切到「智能」才会下发）',
  'no-unique-mp5hd4-2160': '自适应清单里没有唯一的普通 4K（RESOLU=2160 / QUALITY=6 / mp5hd4）',
};

async function main() {
  if (typeof WebSocket !== 'function') throw new Error('需要 Node 22 或更高版本（内置 WebSocket）。');
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    console.log(`连不上 127.0.0.1:${PORT}。\n请先 ⌘Q 退出优酷，再用下面的命令启动，打开影片后重试：\n  open -a "优酷" --args --remote-debugging-port=${PORT}`);
    process.exitCode = 1;
    return;
  }
  console.log(`调试目标 ${targets.length} 个`);
  let seen = 0;
  for (const t of targets) {
    if (!t.webSocketDebuggerUrl) continue;
    const label = `${t.type}  ${strip(t.url).slice(0, 110)}`;
    let value;
    try { value = await evaluate(t.webSocketDebuggerUrl, EXPRESSION); }
    catch (e) { console.log(`- ${label}\n    读取失败：${e.message}`); continue; }
    let info; try { info = JSON.parse(value); } catch { continue; }
    if (!info.scripts.length && !info.diag && !info.videos.length) { console.log(`- ${label}（非播放页）`); continue; }
    seen++;
    console.log(`\n# ${label}`);
    console.log(`  页面标题：${info.title}`);
    console.log(`  加载的播放器脚本：${info.scripts.join('  ') || '无'}`);
    console.log(`  <video> 尺寸：${info.videos.join('  ') || '无'}`);
    console.log(`  页面文字里有「智能 4K（固定）」：${info.menuHas4k ? '是' : '否（画质菜单打开时再运行一次）'}`);
    if (!info.diag) {
      console.log('  补丁诊断：无记录 —— 说明这个页面里的播放器不是打过新版补丁的那份文件，或画质菜单还没生成。');
      continue;
    }
    if (info.diag.error) console.log(`  诊断出错：${info.diag.error}`);
    for (const run of info.diag.runs || []) {
      console.log(`  --- 画质菜单生成 @ ${run.time}`);
      console.log(`  isMac=${run.isMac}  桌面环境=${run.electronIku}  引擎=${run.supportType}（NPlayer=${run.engineNPlayer} M3U8=${run.engineM3U8}）`);
      console.log(`  config.enable4k=${run.enable4k}  config.hardware=${run.hardware}  language=${run.language}`);
      console.log(`  菜单原始档位：${JSON.stringify(run.menuIn)}`);
      console.log(`  流列表(id|name|lang)：${(run.streams || []).join('  ')}`);
      console.log(`  智能流 uri 字段：${JSON.stringify(run.autoUriKeys)}`);
      console.log(`  自适应清单变体：${run.variants ? (run.variants.length ? '\n    ' + run.variants.join('\n    ') : '（空）') : '无'}`);
      console.log(`  结论：${run.reason} —— ${REASONS[run.reason] || ''}`);
    }
  }
  if (!seen) console.log('\n没有找到播放页。请确认已经打开影片并在播放。');
  console.log('\n（只读诊断结束。用完请 ⌘Q 退出优酷，再正常打开，以关闭调试端口。）');
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
