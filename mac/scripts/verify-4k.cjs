#!/usr/bin/env node
'use strict';

// 输出脱敏：把家目录显示为 ~，方便直接把输出贴到 Issue
{
  const home = require('node:os').homedir();
  for (const level of ['log', 'error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => original(...args.map(a => typeof a === 'string' ? a.split(home).join('~') : a));
  }
}
// 优酷 Mac 版 · 4K 验收（只读）
// 在优酷相关目录里找最近修改的日志，只输出与首帧/分辨率/画质档相关的行（去掉 URL 与长串参数）。
// 用法：选中「智能 4K（固定）」播放 20 秒后运行：node scripts/verify-4k.cjs [分钟数，默认 30]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const MINUTES = Number(process.argv[2] || 30);
const since = Date.now() - MINUTES * 60 * 1000;
const roots = [
  path.join(HOME, 'Library', 'Containers', 'com.youku.mac', 'data'),
  path.join(HOME, 'Library', 'Containers', '优酷'),
  path.join(HOME, 'Library', 'Application Support', 'youku-app'),
  path.join(HOME, 'Library', 'Application Support', 'youku'),
  path.join(HOME, 'Library', 'Logs'),
  path.join(HOME, 'Library', 'Caches', 'com.youku.mac'),
];
const SKIP = /^(Cookies|Local Storage|Session Storage|IndexedDB|databases|blob_storage|Cache|Code Cache|GPUCache|local_caches|layout_caches|download|screenshot|danmu|youkudisk|fsCachedData)$/;
const INTEREST = /FirstFrame|first.?frame|video width|width[:=]\s*\d{3,4}|\b\d{3,4}x\d{3,4}\b|size changed|RESOLU=|STREAMTYPE|mp5hd4|local_adaptive_sdr4k|quality/i;
const clean = s => s
  .replace(/(?:https?|client):\/\/\S+/g, '<url>')
  .replace(/[A-Za-z0-9+/=_-]{40,}/g, '<…>')
  .replace(/(token|sign|sig|ckey|cna|utdid|uid|ytid|psid)=[^&\s,;"]+/gi, '$1=<…>')
  .slice(0, 260);

const logs = [];
function walk(dir, depth) {
  let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !SKIP.test(e.name)) walk(p, depth - 1); continue; }
    if (!/\.(log|txt)$|log$/i.test(e.name)) continue;
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs >= since && st.size > 0) logs.push({ p, st });
  }
}
for (const r of roots) walk(r, r.endsWith('Logs') ? 3 : 6);
logs.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

console.log(`最近 ${MINUTES} 分钟内修改过的日志：${logs.length} 个`);
let total3840 = 0;
for (const { p, st } of logs.slice(0, 12)) {
  let text;
  try {
    const fd = fs.openSync(p, 'r');
    const len = Math.min(st.size, 8 * 1048576);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { continue; }
  const lines = text.split(/\r?\n/).filter(l => INTEREST.test(l));
  const hits4k = lines.filter(l => /3840|2160|mp5hd4|local_adaptive_sdr4k/.test(l));
  total3840 += hits4k.length;
  console.log(`\n# ${p.replace(HOME, '~')}  ${(st.size / 1024).toFixed(0)} KB  ${new Date(st.mtimeMs).toLocaleTimeString()}`);
  console.log(`  相关行 ${lines.length}，含 4K 线索 ${hits4k.length}`);
  for (const l of (hits4k.length ? hits4k : lines).slice(-12)) console.log(`  ${clean(l)}`);
}
console.log(`\n结论：${total3840 ? '日志中出现 4K（3840/2160/mp5hd4）线索，请对照上面最近的时间确认' : '日志中没有找到 4K 线索（Mac 原生播放器可能不写这类日志，可改用画面信息核对）'}`);
console.log('（只读，未修改任何文件）');
