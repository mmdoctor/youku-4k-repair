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
// 优酷 Mac 版 · 只读深度诊断
// 目的：Mac 版没有 Windows 那套 layout_caches/local_caches，需要弄清播放器脚本从哪里加载、
//       主程序结构、Electron 安全开关，从而决定补丁走哪条路线。
// 只读：不修改任何文件；不读取 Cookies / Local Storage / IndexedDB；URL 一律去掉查询参数再输出。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOME = os.homedir();
const APP = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2].replace(/\/$/, '') : '/Applications/优酷.app';
const DATA = process.env.YOUKU_APP_DATA || path.join(HOME, 'Library', 'Application Support', 'youku-app');

const TOKENS = [
  'kuplayer', 'kplayer/', 'layout_caches', 'local_caches', 'playerPage',
  'setMultiQuality', '.prototype.getStream=function', 'ElectronIku', 'NPlayer', 'supportType',
  'remoteCacheVersion', 'clearCache', 'autoUpdater', 'check-update', 'autoInstallOnAppQuit',
  'registerFileProtocol', 'registerBufferProtocol', 'registerStreamProtocol', 'interceptBufferProtocol',
  'interceptStreamProtocol', 'protocol.handle', 'webRequest', 'remote-debugging', 'loadURL(',
];
const SNIPPET_TOKENS = new Set(['kuplayer', 'layout_caches', 'local_caches', 'playerPage', 'remoteCacheVersion', 'check-update', 'registerFileProtocol', 'registerBufferProtocol', 'registerStreamProtocol', 'interceptBufferProtocol', 'protocol.handle', 'loadURL(']);

const stripQuery = u => u.replace(/[?#].*$/, '');
const scrub = s => s.replace(/(https?:)?\/\/[^\s"'`\\)]+/g, m => stripQuery(m)).replace(/[\r\n\t]+/g, ' ');
const section = t => console.log(`\n=== ${t} ===`);

/* ---------------- asar ---------------- */

function parseAsarHeader(head16, readJson) {
  const headerSize = head16.readUInt32LE(4);
  const jsonLen = head16.readUInt32LE(12);
  return { header: JSON.parse(readJson(16, jsonLen).toString('utf8')), base: 8 + headerSize };
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p, out);
    else if (!entry.link) out.push({ path: p, size: entry.size, offset: Number(entry.offset || 0), unpacked: !!entry.unpacked });
  }
  return out;
}

function openAsar(file) {
  const fd = fs.openSync(file, 'r');
  const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
  const { header, base } = parseAsarHeader(read(0, 16), read);
  const files = walk(header, '', []);
  const content = f => f.unpacked
    ? fs.readFileSync(path.join(`${file}.unpacked`, f.path))
    : read(base + f.offset, f.size);
  return { files, content, close: () => fs.closeSync(fd) };
}

function count(s, t) { let n = 0, i = 0; while ((i = s.indexOf(t, i)) !== -1) { n++; i += t.length; } return n; }

function snippets(s, t, max = 2, width = 160) {
  const out = []; let i = 0;
  while (out.length < max && (i = s.indexOf(t, i)) !== -1) {
    out.push(scrub(s.slice(Math.max(0, i - width / 2), i + t.length + width / 2)));
    i += t.length;
  }
  return out;
}

function probeAsar() {
  section('App 包');
  const plist = path.join(APP, 'Contents', 'Info.plist');
  let info = {};
  try { info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch (e) { console.log(`读取 Info.plist 失败：${e.message}`); }
  console.log(`版本 ${info.CFBundleShortVersionString} (${info.CFBundleVersion})  ${info.CFBundleIdentifier}`);
  console.log(`ElectronAsarIntegrity（asar 完整性校验）：${info.ElectronAsarIntegrity ? '已启用 → ' + Object.keys(info.ElectronAsarIntegrity).join(',') : '未声明'}`);
  try {
    const fw = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(APP, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    console.log(`Electron 版本：${fw.CFBundleVersion || fw.CFBundleShortVersionString}`);
  } catch { console.log('Electron 版本：未知'); }
  probeFuses();
  try { console.log(`签名：${execFileSync('/usr/bin/codesign', ['-dv', APP], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || ''}`.trim()); } catch (e) {
    const msg = String(e.stderr || '').split('\n').filter(l => /Authority|TeamIdentifier|Signature|flags/.test(l)).join(' | ');
    console.log(`签名：${msg || '无法读取'}`);
  }

  const res = path.join(APP, 'Contents', 'Resources');
  console.log(`Resources 下：${fs.readdirSync(res).filter(n => !/\.lproj$|\.icns$/.test(n)).join('  ')}`);

  const natives = [];
  const scan = (dir, depth) => {
    let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0 && !/\.lproj$/.test(e.name)) scan(p, depth - 1);
      else if (/\.(node|dylib)$/i.test(e.name) || /player|nplayer|xmedia|kplayer/i.test(e.name)) natives.push(path.relative(APP, p));
    }
  };
  scan(path.join(APP, 'Contents'), 5);
  console.log(`原生模块/播放器相关（${natives.length}）：\n  ${natives.slice(0, 40).join('\n  ')}`);

  const asarFile = path.join(res, 'app.asar');
  if (!fs.existsSync(asarFile)) { console.log('没有 app.asar'); return; }
  section('app.asar 结构');
  const asar = openAsar(asarFile);
  try {
    const { files } = asar;
    const total = files.reduce((a, f) => a + f.size, 0);
    console.log(`文件数 ${files.length}，总计 ${(total / 1048576).toFixed(1)} MB，unpacked ${files.filter(f => f.unpacked).length} 个`);
    const pkg = files.find(f => f.path === 'package.json');
    if (pkg) {
      const j = JSON.parse(asar.content(pkg).toString('utf8'));
      console.log(`package.json → name=${j.name} version=${j.version} main=${j.main}`);
    }
    const dirs = {};
    for (const f of files) { const d = f.path.split('/').slice(0, 3).join('/'); dirs[d] = (dirs[d] || 0) + 1; }
    console.log('目录（前 3 级，文件数 ≥3 或含 js）：');
    for (const [d, n] of Object.entries(dirs).filter(([d, n]) => n >= 3 || /\.js$/.test(d)).slice(0, 40)) console.log(`  ${d}  (${n})`);
    const bigJs = files.filter(f => /\.(js|cjs|mjs)$/.test(f.path)).sort((a, b) => b.size - a.size).slice(0, 12);
    console.log('最大的 JS：');
    for (const f of bigJs) console.log(`  ${f.path}  ${(f.size / 1024).toFixed(0)} KB${f.unpacked ? ' [unpacked]' : ''}`);

    section('app.asar 关键字命中');
    for (const f of files) {
      if (!/\.(js|cjs|mjs|html|json)$/.test(f.path) || f.size > 40 * 1048576 || /node_modules\//.test(f.path)) continue;
      let s; try { s = asar.content(f).toString('utf8'); } catch { continue; }
      const hits = TOKENS.map(t => [t, count(s, t)]).filter(([, n]) => n);
      if (!hits.length) continue;
      console.log(`${f.path}：${hits.map(([t, n]) => `${t}×${n}`).join('  ')}`);
      for (const [t] of hits) if (SNIPPET_TOKENS.has(t)) for (const sn of snippets(s, t)) console.log(`    [${t}] …${sn}…`);
      for (const a of ['case 0:return s=t.source', 'function $(){o.ipcMain.on("check-update"', 'global.remoteCacheVersion=t,Object(h.clearCache)']) {
        if (s.includes(a)) console.log(`    ✓ 含 Windows 版主进程锚点：${a}`);
      }
    }
  } finally { asar.close(); }
}

function probeFuses() {
  const bin = path.join(APP, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
  try {
    const buf = fs.readFileSync(bin);
    const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
    const at = buf.indexOf(sentinel);
    if (at < 0) { console.log('Electron fuses：未找到'); return; }
    const len = buf[at + sentinel.length + 1];
    const raw = buf.slice(at + sentinel.length + 2, at + sentinel.length + 2 + len).toString('latin1');
    const names = ['RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar', 'LoadBrowserProcessSpecificV8Snapshot', 'GrantFileProtocolExtraPrivileges', 'WasmTrapHandlers'];
    console.log(`Electron fuses：${[...raw].map((c, i) => `${names[i] || '#' + i}=${c === '1' ? 'on' : c === '0' ? 'off' : c}`).join('  ')}`);
  } catch (e) { console.log(`Electron fuses：读取失败 ${e.code || e.message}`); }
}

/* ---------------- 数据目录 / 缓存 ---------------- */

function probeCache() {
  section('数据目录');
  console.log(DATA);
  for (const sub of ['Cache/Cache_Data', 'Cache', 'Code Cache/js']) {
    const dir = path.join(DATA, sub);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    let names = []; try { names = fs.readdirSync(dir); } catch (e) { console.log(`${sub}：无法读取 ${e.code}`); continue; }
    const found = new Map();
    for (const n of names.slice(0, 30000)) {
      const p = path.join(dir, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile() || st.size > 60 * 1048576) continue;
      let b; try { b = fs.readFileSync(p); } catch { continue; }
      const s = b.toString('latin1');
      const re = /https?:\/\/[^\s"'\x00-\x1f]*?(?:kuplayer|kplayer)[^\s"'\x00-\x1f]*/g;
      let m;
      while ((m = re.exec(s))) {
        const url = stripQuery(m[0]);
        const prev = found.get(url) || { files: new Set(), mtime: 0, plain: false };
        prev.files.add(n); prev.mtime = Math.max(prev.mtime, st.mtimeMs);
        if (s.includes('setMultiQuality')) prev.plain = true;
        found.set(url, prev);
      }
    }
    console.log(`${sub}：${names.length} 个文件，含播放器 URL ${found.size} 个`);
    for (const [url, v] of [...found].sort((a, b) => b[1].mtime - a[1].mtime).slice(0, 15)) {
      console.log(`  ${url}  ← ${[...v.files].slice(0, 3).join(',')}  ${new Date(v.mtime).toLocaleString()}${v.plain ? '  [明文含 setMultiQuality]' : ''}`);
    }
  }

  section('其他可能的缓存位置');
  const roots = [path.join(HOME, 'Library', 'Application Support'), path.join(HOME, 'Library', 'Caches'), path.join(HOME, 'Library', 'Containers')];
  for (const root of roots) {
    let es = []; try { es = fs.readdirSync(root); } catch { continue; }
    for (const n of es.filter(n => /youku|优酷/i.test(n) && n !== 'youku-4k-repair')) {
      const p = path.join(root, n);
      let inner = []; try { inner = fs.readdirSync(p); } catch { }
      console.log(`${p}\n    ${inner.filter(x => !/^(Cookies|Local Storage|IndexedDB|Session Storage|SingletonCookie|SingletonLock)/.test(x)).slice(0, 30).join('  ')}`);
    }
  }
  const nplayer = [path.join(HOME, 'Library', 'Application Support', 'youku', 'nplayer'), path.join(DATA, 'nplayer')];
  for (const d of nplayer) if (fs.existsSync(d)) console.log(`原生播放器目录：${d}（${fs.readdirSync(d).length} 个文件）`);
}

/* ---------------- 自检 ---------------- */

function selfTest() {
  const header = JSON.stringify({ files: { 'package.json': { size: 2, offset: '0' }, dist: { files: { 'a.js': { size: 3, offset: '2' } } } } });
  const json = Buffer.from(header);
  const pickle = Buffer.alloc(8); pickle.writeUInt32LE(json.length + 4, 0); pickle.writeUInt32LE(json.length, 4);
  const headerPickle = Buffer.concat([pickle, json]);
  const sizePickle = Buffer.alloc(8); sizePickle.writeUInt32LE(4, 0); sizePickle.writeUInt32LE(headerPickle.length, 4);
  const buf = Buffer.concat([sizePickle, headerPickle, Buffer.from('{}abc')]);
  const read = (pos, len) => buf.slice(pos, pos + len);
  const { header: h, base } = parseAsarHeader(read(0, 16), read);
  const files = walk(h, '', []);
  if (files.length !== 2 || read(base + files[1].offset, files[1].size).toString() !== 'abc') throw new Error('asar 解析自检失败');
  if (stripQuery('https://g.alicdn.com/kplayer/kuplayer/4.24.1/index.js?sig=x') !== 'https://g.alicdn.com/kplayer/kuplayer/4.24.1/index.js') throw new Error('URL 清洗自检失败');
  console.log('自检通过');
}

if (process.argv.includes('--selftest')) { selfTest(); }
else {
  console.log(`macOS ${os.release()} · ${process.arch} · Node ${process.version}`);
  try { probeAsar(); } catch (e) { console.log(`App 诊断出错：${e.message}`); }
  try { probeCache(); } catch (e) { console.log(`缓存诊断出错：${e.message}`); }
  console.log('\n（只读诊断结束，未修改任何文件）');
}
