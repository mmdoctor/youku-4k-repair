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
// 优酷 Mac 版 · 只读定位：播放器缓存（layout_caches / local_caches）到底存在哪里
// 1) 从 app.asar 的 main.prod.js 里取出 getUserPath / copyCache / client:// 协议处理的源码片段
// 2) 在 ~/Library 下与优酷相关的目录中查找 layout_caches、local_caches
// 只读；跳过 Cookies / Local Storage / IndexedDB 等账号数据；URL 去掉查询参数后再输出。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HOME = os.homedir();
const APP = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2].replace(/\/$/, '') : '/Applications/优酷.app';
const scrub = s => s.replace(/((?:https?|client):)?\/\/[^\s"'`\\)]+/g, m => m.replace(/[?#].*$/, '')).replace(/[\r\n\t]+/g, ' ');
const section = t => console.log(`\n=== ${t} ===`);
const SKIP = /^(Cookies|Cookies-journal|Local Storage|Session Storage|IndexedDB|databases|blob_storage|Cache|Code Cache|GPUCache|Crashpad|shared_proto_db|QuotaManager.*|Service Worker|SingletonCookie|SingletonLock|TransportSecurity|Network Persistent State|Preferences|PlayLog|fsCachedData)$/;

function openAsar(file) {
  const fd = fs.openSync(file, 'r');
  const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
  const head = read(0, 16);
  const header = JSON.parse(read(16, head.readUInt32LE(12)).toString('utf8'));
  const base = 8 + head.readUInt32LE(4);
  const get = p => {
    let node = header;
    for (const part of p.split('/')) node = node?.files?.[part];
    if (!node || node.files) return null;
    return read(base + Number(node.offset || 0), node.size).toString('utf8');
  };
  return { get, close: () => fs.closeSync(fd) };
}

function around(src, idx, before, after) { return scrub(src.slice(Math.max(0, idx - before), idx + after)); }

function definitionOf(src, exportName) {
  const out = [];
  const exp = new RegExp(`"${exportName}",\\(?function\\(\\)\\{return ([\\w$]+)\\}`, 'g');
  const locals = new Set([...src.matchAll(exp)].map(m => m[1]));
  for (const local of locals) {
    const def = new RegExp(`function ${local.replace(/\$/g, '\\$')}\\(`, 'g');
    for (const m of src.matchAll(def)) out.push(`[${exportName} → ${local}] ${around(src, m.index, 0, 700)}`);
  }
  const direct = new RegExp(`(?:function ${exportName}\\(|${exportName}=function\\(|${exportName}:function\\()`, 'g');
  for (const m of src.matchAll(direct)) out.push(`[${exportName}] ${around(src, m.index, 0, 700)}`);
  return out.slice(0, 4);
}

function probeCode() {
  section('main.prod.js 关键源码');
  const asarFile = path.join(APP, 'Contents', 'Resources', 'app.asar');
  const asar = openAsar(asarFile);
  try {
    const main = asar.get('app/main/dist/main.prod.js');
    if (!main) { console.log('未找到 app/main/dist/main.prod.js'); return; }
    for (const name of ['getUserPath', 'copyCache', 'getCachePath', 'getUserDataPath']) {
      const defs = definitionOf(main, name);
      if (defs.length) { for (const d of defs) console.log(`${d}\n`); }
      else if (main.includes(name)) console.log(`[${name}] 未解析到定义，首次出现：${around(main, main.indexOf(name), 200, 300)}\n`);
    }
    for (const token of ['getPath("userData")', "getPath('userData')", 'getPath("appData")', 'getPath("home")', 'setPath(']) {
      let i = 0, n = 0;
      while ((i = main.indexOf(token, i)) !== -1 && n < 3) { console.log(`[${token}] ${around(main, i, 150, 250)}\n`); i += token.length; n++; }
    }
    const c = main.indexOf('registerStreamProtocol("client"');
    if (c >= 0) console.log(`[client:// 协议] ${around(main, c, 50, 1200)}\n`);
    const play = asar.get('app/renderer/page/play.html');
    if (play) {
      const urls = [...new Set([...play.matchAll(/(?:\\u002F|\/){2}g\.alicdn\.com(?:\\u002F|\/)kplayer[^"'\s]*?index\.js/g)].map(m => m[0].replace(/\\u002F/g, '/')))];
      console.log(`[包内 play.html 声明的播放器] ${urls.join('  ') || '无'}`);
    }
  } finally { asar.close(); }

  try {
    execFileSync('/usr/bin/codesign', ['-dv', APP], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { /* codesign -dv 输出在 stderr，下面单独取 */ }
  try {
    const r = require('node:child_process').spawnSync('/usr/bin/codesign', ['-dv', APP], { encoding: 'utf8' });
    const keep = (r.stderr || '').split('\n').filter(l => /^(Authority|TeamIdentifier|Signature|CodeDirectory|Runtime)/.test(l));
    console.log(`[签名] ${keep.join(' | ') || '无法读取'}`);
  } catch (e) { console.log(`[签名] 读取失败 ${e.message}`); }
}

function walkFor(root, depth, hits) {
  let es = [];
  try { es = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES') hits.denied.push(root); return; }
  for (const e of es) {
    if (!e.isDirectory() || SKIP.test(e.name)) continue;
    const p = path.join(root, e.name);
    if (/^(layout_caches|local_caches)$/.test(e.name)) hits.found.push(p);
    else if (depth > 0) walkFor(p, depth - 1, hits);
  }
}

function probeDirs() {
  section('在 ~/Library 下查找 layout_caches / local_caches');
  const lib = path.join(HOME, 'Library');
  const roots = new Set();
  for (const parent of ['Application Support', 'Containers', 'Group Containers', 'Caches', 'Preferences']) {
    let es = []; try { es = fs.readdirSync(path.join(lib, parent)); } catch { continue; }
    for (const n of es) if (/youku|优酷|alibaba|alicdn/i.test(n) && n !== 'youku-4k-repair') roots.add(path.join(lib, parent, n));
  }
  const hits = { found: [], denied: [] };
  for (const r of roots) { console.log(`扫描 ${r}`); walkFor(r, 7, hits); }
  if (hits.denied.length) console.log(`无权限读取：${hits.denied.join('、')}`);
  if (!hits.found.length) { console.log('没有找到 layout_caches / local_caches'); return; }

  for (const dir of hits.found) {
    console.log(`\n找到：${dir}`);
    let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { }
    console.log(`  子项：${es.map(e => e.name + (e.isDirectory() ? '/' : '')).slice(0, 30).join('  ')}`);
    if (path.basename(dir) === 'layout_caches') {
      for (const profile of ['v2', '']) {
        const pp = path.join(dir, profile, 'playerPage');
        if (!fs.existsSync(pp)) continue;
        for (const f of fs.readdirSync(pp)) {
          const fp = path.join(pp, f);
          if (!fs.statSync(fp).isFile()) continue;
          const s = fs.readFileSync(fp, 'utf8');
          const urls = [...new Set([...s.matchAll(/(?:(?:https?|client):)?\/\/g\.alicdn\.com\/kplayer\/kuplayer\/[\w.-]+\/index\.js/g)].map(m => m[0]))];
          const md5 = urls.map(u => createHash('md5').update('https://' + u.replace(/^(?:(?:https?|client):)?\/\//, '')).digest('hex'));
          console.log(`  playerPage${profile ? '(' + profile + ')' : ''}/${f}  ${(s.length / 1024).toFixed(0)} KB  播放器：${urls.join(', ') || '无'}  → 缓存名 ${md5.join(', ') || '-'}`);
        }
      }
    }
    if (path.basename(dir) === 'local_caches') {
      for (const profile of ['v2', '']) {
        const st = path.join(dir, profile, 'static');
        if (!fs.existsSync(st)) continue;
        const files = fs.readdirSync(st);
        const players = [];
        for (const f of files) {
          const fp = path.join(st, f);
          let s; try { s = fs.readFileSync(fp, 'utf8'); } catch { continue; }
          if (s.includes('setMultiQuality')) players.push(`${f} (${(s.length / 1024).toFixed(0)} KB${s.includes('local_adaptive_sdr4k') ? '，已打补丁' : ''})`);
        }
        console.log(`  static${profile ? '(' + profile + ')' : ''}：${files.length} 个文件；含播放器代码：${players.join('、') || '无'}`);
      }
    }
  }
}

console.log(`macOS ${os.release()} · Node ${process.version}`);
try { probeCode(); } catch (e) { console.log(`源码定位出错：${e.message}`); }
try { probeDirs(); } catch (e) { console.log(`目录查找出错：${e.message}`); }
console.log('\n（只读诊断结束，未修改任何文件）');
