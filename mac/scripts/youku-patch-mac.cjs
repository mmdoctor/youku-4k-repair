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
// youku-4k-repair · macOS 移植版
// 基于 https://github.com/mmdoctor/youku-4k-repair 的 Windows 脚本改写。
// 只把同一会话里、优酷已为当前 VIP 账号下发的普通 SDR 4K（mp5hd4 / QUALITY=6 / 2160）
// 固定成一个可手选的菜单项；保留原有会员校验、签名地址与 DRM，不涉及 SVIP / HDR。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Script } = require('node:vm');

/* ------------------------------------------------------------------ */
/* 注入到播放器里的两个函数（会被 toString() 原样写入播放器脚本）           */
/* ------------------------------------------------------------------ */

function selectAdaptive4k(manifest) {
  if (typeof manifest !== 'string') return null;
  const lines = manifest.trimEnd().split(/\r?\n/);
  if (lines[0] !== '#EXTM3U' || lines[lines.length - 1] !== '#EXT-X-ENDLIST') {
    return null;
  }

  let selected;
  for (let index = 1; index < lines.length - 1; index += 2) {
    const attributes = lines[index];
    const uri = lines[index + 1];
    if (!attributes.startsWith('#EXT-X-STREAM-INF:') || !/^https?:\/\/[^\s]+$/.test(uri)) {
      return null;
    }
    if (/(?:^|[:,])RESOLU=2160(?:,|$)/.test(attributes) &&
        /(?:^|[:,])QUALITY=6(?:,|$)/.test(attributes) &&
        /(?:^|[:,])STREAMTYPE="mp5hd4"(?:,|$)/.test(attributes)) {
      if (selected) return null;
      selected = [attributes, uri];
    }
  }

  if (!selected) return null;
  return [lines[0], ...selected, lines[lines.length - 1], ''].join('\r\n');
}

function localAdaptive4k(resource, language) {
  if (!resource.user?.vip) return null;
  const auto = resource.streamList?.find(stream => stream.id === 'auto' && stream.lang === language);
  if (!auto?.uri?.HLS) return null;
  const manifest = selectAdaptive4k(auto.uri.HLSCONTENT);
  if (!manifest) return null;

  return {
    ...auto,
    id: 'local_adaptive_sdr4k',
    name: '4k',
    uri: { ...auto.uri, HLSCONTENT: manifest },
  };
}

function youku4kDiagnose(player, platform, env, engine, list) {
  const context = player._context || {};
  const config = context.config || {};
  const resource = player.mediaResource || {};
  const streams = Array.isArray(resource.streamList) ? resource.streamList : [];
  const auto = streams.find(stream => stream.id === 'auto' && stream.lang === player._language);
  const content = auto && auto.uri ? auto.uri.HLSCONTENT : undefined;
  const pick = line => {
    const out = [];
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let found;
    while ((found = re.exec(line.slice(line.indexOf(':') + 1)))) {
      const value = found[2].replace(/^"|"$/g, '');
      if (found[1] === 'URI' || /:\/\/|[?&]sig/i.test(value)) continue;
      out.push(found[1] + '=' + value.slice(0, 48));
    }
    return out.join(',');
  };
  const variants = typeof content === 'string'
    ? content.split(/\r?\n/).filter(line => line.startsWith('#EXT-X-STREAM-INF:')).map(pick)
    : null;
  let reason = 'ok';
  if (!resource.user || !resource.user.vip) reason = 'not-vip';
  else if (!auto) reason = 'no-auto-stream';
  else if (!auto.uri || !auto.uri.HLS) reason = 'no-auto-hls';
  else if (typeof content !== 'string') reason = 'no-hlscontent';
  else if (!selectAdaptive4k(content)) reason = 'no-unique-mp5hd4-2160';
  return {
    time: new Date().toISOString(),
    isMac: !!(platform && platform.isMac),
    electronIku: config.environment === env.ElectronIku,
    supportType: String(context.supportType),
    engineNPlayer: context.supportType === engine.NPlayer,
    engineM3U8: context.supportType === engine.M3U8,
    enable4k: config.enable4k,
    hardware: config.hardware,
    hasUser: !!resource.user,
    language: player._language,
    menuIn: Array.isArray(list) ? list.map(item => item && (item.name || item.id)) : typeof list,
    streams: streams.slice(0, 40).map(stream => [stream.id, stream.name, stream.lang].join('|')),
    autoUriKeys: auto && auto.uri ? Object.keys(auto.uri) : null,
    variants,
    reason,
  };
}

/* ------------------------------------------------------------------ */
/* 播放器补丁                                                          */
/* ------------------------------------------------------------------ */

const ident = '[a-zA-Z_$][\\w$]*';
const member = `${ident}(?:\\.${ident})*`;

function matchOnce(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `无法唯一识别${label}（命中 ${matches.length} 处）`);
  return matches[0];
}

const playerPatterns = {
  prefix: () => new RegExp(String.raw`var ${ident}=\{"1080p":\["mp4hd3v2","mp4hd3","cmaf4hd3","mp5hd3"`, 'g'),
  lookup: () => new RegExp(String.raw`(?<head>\.prototype\.getStream=function\((?<language>${ident}),(?<key>${ident})\)\{)return this\._checkEmptyStream\(\)\?null:this\._model\.streamList\.find`, 'g'),
  start: () => new RegExp(String.raw`(?<owner>${ident})\.prototype\.setMultiQuality=function\((?<input>${ident})\)\{`, 'g'),
};

// 与 Windows 版的唯一实质差异：注入条件。
// Windows 版要求 !isMac && supportType===NPlayer；Mac 版去掉平台排除，
// 并同时接受 NPlayer 与 M3U8 两种引擎（Mac 客户端实际使用哪种需用 probe 核对）。
function patchPlayer(original) {
  const prefix = matchOnce(original, playerPatterns.prefix(), '播放器画质映射');
  const lookup = matchOnce(original, playerPatterns.lookup(), '播放器流查找');
  const start = matchOnce(original, playerPatterns.start(), '播放器画质菜单入口');
  const end = original.indexOf(`${start.groups.owner}.prototype.hasQuality=function`, start.index);
  assert(end > start.index && prefix.index < lookup.index && lookup.index < start.index, '无法确定播放器代码结构');
  const menu = original.slice(start.index, end);
  const { list } = matchOnce(menu, new RegExp(String.raw`\.streamTypeFilter,(?<list>${ident})=${start.groups.input};if\(!`, 'g'), '播放器档位列表').groups;
  const loop = matchOnce(menu, new RegExp(String.raw`var ${ident}=!1;if\(${list}\.forEach\(\(function\((?<item>${ident})\)\{`, 'g'), '播放器档位渲染循环');
  const { item } = loop.groups;
  const { platform } = matchOnce(menu, new RegExp(String.raw`(?<platform>${member})\.isMac&&\(`, 'g'), '平台分支').groups;
  const { env } = matchOnce(menu, new RegExp(String.raw`this\._context\.config\.environment===(?<env>${member})\.ElectronIku\)\{`, 'g'), '桌面播放器校验').groups;
  const { engine } = matchOnce(menu, new RegExp(String.raw`this\._context\.supportType===(?<engine>${member})\.M3U8`, 'g'), '播放器引擎校验').groups;
  assert(original.includes(`${engine}.NPlayer`) && menu.includes('this.dispatchPropertyChangeEvent("multiQuality")'), '无法确认原生播放器菜单路径');
  const caption = matchOnce(menu, new RegExp(String.raw`var (?<title>${ident})=${item}\.title&&${ident}\?${item}\.title:(?<labels>${ident})\[${item}\.name\]\.name,${ident}=${item}\.label&&${ident}\?${item}\.label:\k<labels>\[${item}\.name\]\.label(?:,${ident}=\k<labels>\[${item}\.name\]\.spm\|\|"")?;`, 'g'), '播放器画质标题');

  const gate = `this._context.config.environment===${env}.ElectronIku && (this._context.supportType===${engine}.NPlayer || this._context.supportType===${engine}.M3U8)`;
  const replacements = [
    [prefix[0], `${selectAdaptive4k.toString()}\n${localAdaptive4k.toString()}\n${youku4kDiagnose.toString()}\n${prefix[0]}`],
    [lookup[0], `${lookup.groups.head}if(${lookup.groups.key}==="local_adaptive_sdr4k")return localAdaptive4k(this,${lookup.groups.language});${lookup[0].slice(lookup.groups.head.length)}`],
    [loop[0], `try{var __yk4k=(globalThis.__youku4kDiag=globalThis.__youku4kDiag||{version:2,runs:[]});__yk4k.runs.push(youku4kDiagnose(this,${platform},${env},${engine},${list}));if(__yk4k.runs.length>6)__yk4k.runs.shift()}catch(__e){(globalThis.__youku4kDiag=globalThis.__youku4kDiag||{runs:[]}).error=String(__e&&__e.message||__e)}if(${gate} && !${list}.some((function(t){return t.name==="4k"}))){const allowed4k=localAdaptive4k(this.mediaResource,this._language);if(allowed4k)${list}=${list}.concat(allowed4k)}${loop[0]}`],
    [caption[0], `${caption[0]}if(${item}.id==="local_adaptive_sdr4k")${caption.groups.title}="智能 4K（固定）";`],
  ];
  return replaceOnce(original, replacements);
}

function replaceOnce(original, replacements) {
  let source = original;
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length, 2, `Expected one match for ${before.slice(0, 80)}`);
    source = source.replace(before, () => after);
  }
  return source;
}

/* ------------------------------------------------------------------ */
/* 主进程补丁（后台更新 / 自动清缓存）——与 Windows 版相同的锚点             */
/* ------------------------------------------------------------------ */

const automaticCheck = 'case 0:return s=t.source,c=void 0===s?"menu":s,p=t.bizSource,e.n=1,X();case 1:if(global.onceInstalled';
const updaterSetup = 'function $(){o.ipcMain.on("check-update",(function(){H({source:"menu"})}))';
const automaticClear = 'global.remoteCacheVersion=t,Object(h.clearCache)().then((function(){Object(M.reloadWindow)()}))';

function patchMaintenance(original) {
  return replaceOnce(original, [
    [automaticCheck, 'case 0:s=t.source,c=void 0===s?"menu":s;if(c!=="menu"){f.a.info("[youku-4k-repair] Skipped background app update");return e.a(2)}return p=t.bizSource,e.n=1,X();case 1:if(global.onceInstalled'],
    [updaterSetup, 'function $(){r.autoUpdater.autoInstallOnAppQuit=!1,o.ipcMain.on("check-update",(function(){H({source:"menu"})}))'],
    [automaticClear, 'global.remoteCacheVersion=t,r.kuLog.info("[youku-4k-repair] Skipped automatic resource cache clear")'],
  ]);
}

const player = { marker: 'local_adaptive_sdr4k', build: patchPlayer, inBundle: false };
const maintenance = { marker: '[youku-4k-repair] Skipped background app update', file: 'main.prod.js', build: patchMaintenance, inBundle: true };

/* ------------------------------------------------------------------ */
/* macOS 路径                                                          */
/* ------------------------------------------------------------------ */

const HOME = os.homedir();
const APP_SUPPORT = path.join(HOME, 'Library', 'Application Support');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function backupDirectory() {
  return path.join(APP_SUPPORT, 'youku-4k-repair', 'backups');
}

// Mac 版的缓存不一定在 Application Support/youku-app，向下查找含 layout_caches 的目录
function findCacheParents() {
  const lib = path.join(HOME, 'Library');
  const SKIP = /^(Cookies|Local Storage|Session Storage|IndexedDB|databases|blob_storage|Cache|Code Cache|GPUCache|Crashpad|PlayLog|fsCachedData)$/;
  const out = [];
  const walk = (dir, depth) => {
    let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (es.some(e => e.isDirectory() && e.name === 'layout_caches')) out.push(dir);
    if (depth > 0) for (const e of es) if (e.isDirectory() && !SKIP.test(e.name) && !/^(layout_caches|local_caches)$/.test(e.name)) walk(path.join(dir, e.name), depth - 1);
  };
  for (const parent of ['Application Support', 'Containers', 'Group Containers', 'Caches']) {
    let es = []; try { es = fs.readdirSync(path.join(lib, parent)); } catch { continue; }
    for (const n of es) if (/youku|优酷/i.test(n) && n !== 'youku-4k-repair') walk(path.join(lib, parent, n), 7);
  }
  return out;
}

// Electron 的 userData：Windows 是 %APPDATA%\youku-app，Mac 对应 ~/Library/Application Support/youku-app
function appDataCandidates() {
  if (process.env.YOUKU_APP_DATA) return [process.env.YOUKU_APP_DATA];
  let names = [];
  try { names = fs.readdirSync(APP_SUPPORT); } catch { /* ignore */ }
  const guess = names.filter(n => /youku|优酷/i.test(n) && n !== 'youku-4k-repair');
  const dirs = [...new Set(['youku-app', ...guess])].map(n => path.join(APP_SUPPORT, n));
  // App Store 版（沙盒）数据位于 ~/Library/Containers/<bundle-id>/Data/Library/Application Support/
  const containers = path.join(HOME, 'Library', 'Containers');
  let ids = [];
  try { ids = fs.readdirSync(containers).filter(n => /youku/i.test(n)); } catch { /* ignore */ }
  for (const id of ids) {
    const support = path.join(containers, id, 'Data', 'Library', 'Application Support');
    let inner = [];
    try { inner = fs.readdirSync(support).filter(n => /youku|优酷/i.test(n)); } catch { /* ignore */ }
    for (const n of new Set(['youku-app', ...inner])) dirs.push(path.join(support, n));
  }
  dirs.push(...findCacheParents());
  return [...new Set(dirs)];
}

function appDataDir() {
  const hit = appDataCandidates().filter(dir => fs.existsSync(path.join(dir, 'layout_caches')));
  if (hit.length > 1) throw new Error(`找到多个优酷数据目录：${hit.join('、')}。请用环境变量 YOUKU_APP_DATA 指定。`);
  if (!hit.length) throw new Error('未找到优酷的 layout_caches。请先在优酷里打开一部影片，再从菜单栏完全退出后重试（或用 YOUKU_APP_DATA 指定数据目录）。');
  return hit[0];
}

function playerCandidates(appData) {
  const declared = new Set();
  for (const profile of ['v2', '']) {
    const layouts = path.join(appData, 'layout_caches', profile, 'playerPage');
    if (!fs.existsSync(layouts)) continue;
    const cache = path.join(appData, 'local_caches', profile, 'static');
    for (const file of fs.readdirSync(layouts, { withFileTypes: true })) {
      if (!file.isFile() || !/^[\da-f]{32}$/i.test(file.name)) continue;
      const page = fs.readFileSync(path.join(layouts, file.name), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      const scripts = page.matchAll(/<script\b[^>]*\ssrc\s*=\s*(["'])(?:(?:https?|client):)?\/\/(g\.alicdn\.com\/kplayer\/kuplayer\/[\w.-]+\/index\.js)(?:\?rnd=[\w.-]+)?\1/gi);
      for (const match of scripts) {
        const filename = createHash('md5').update(`https://${match[2]}`).digest('hex');
        declared.add(JSON.stringify({ file: path.join(cache, `${filename}.js`), url: match[2] }));
      }
    }
  }
  return [...declared].map(s => JSON.parse(s));
}

function playerTarget() {
  const found = playerCandidates(appDataDir());
  const files = [...new Set(found.map(x => x.file))];
  if (files.length > 1) throw new Error('发现多个播放页指向不同播放器。请先用 probe 核对正在加载的脚本。');
  const [target] = files;
  if (!target || !fs.existsSync(target)) throw new Error('未找到播放页对应的播放器缓存。请先打开影片，再完全退出优酷重试。');
  return target;
}

function readPlist(appPath) {
  try {
    const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(json);
  } catch { return null; }
}

function findAppBundles() {
  const out = [];
  for (const root of ['/Applications', path.join(HOME, 'Applications')]) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (e) {
      if (e.code !== 'ENOENT') console.error(`（无法读取 ${root}：${e.code}）`);
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.app')) continue;
      const appPath = path.join(root, name);
      const info = readPlist(appPath);
      const id = `${info?.CFBundleIdentifier || ''} ${info?.CFBundleName || ''} ${name}`;
      if (/youku|优酷/i.test(id)) out.push(appPath);
    }
  }
  return out;
}

function resolveApp(arg) {
  if (arg) {
    if (!path.isAbsolute(arg) || !arg.replace(/\/$/, '').endsWith('.app')) throw new Error('请提供优酷 .app 的绝对路径，例如 "/Applications/优酷.app"。');
    if (!fs.existsSync(path.join(arg, 'Contents', 'Info.plist'))) throw new Error('该路径不是有效的 .app。');
    return arg.replace(/\/$/, '');
  }
  const found = findAppBundles();
  if (found.length !== 1) throw new Error(found.length ? `找到多个优酷 App：${found.join('、')}，请显式指定。` : '没有在 /Applications 找到优酷 App，请显式指定路径。');
  return found[0];
}

function mainProdTarget(appPath) {
  const res = path.join(appPath, 'Contents', 'Resources');
  const candidates = [
    path.join(res, 'app', 'app', 'main', 'dist', 'main.prod.js'),
    path.join(res, 'app', 'main', 'dist', 'main.prod.js'),
    path.join(res, 'app.asar.unpacked', 'app', 'main', 'dist', 'main.prod.js'),
  ];
  const hit = candidates.find(p => fs.existsSync(p));
  if (hit) return hit;
  if (fs.existsSync(path.join(res, 'app.asar'))) {
    throw new Error('该版本主程序打包在 app.asar 内（且可能启用 ASAR 完整性校验），本脚本不改写 asar。4K 菜单补丁不受影响，可单独使用 apply。');
  }
  throw new Error('未在 App 包内找到 main.prod.js。');
}

function targetPath(spec, appArg) {
  if (spec === player) return playerTarget();
  return mainProdTarget(resolveApp(appArg));
}

/* ------------------------------------------------------------------ */
/* 检查 / 备份 / 原子写入                                               */
/* ------------------------------------------------------------------ */

function inspectTarget(spec, target) {
  if (!fs.existsSync(target)) throw new Error('未找到对应的优酷文件。');
  const current = fs.readFileSync(target);
  if (!current.includes(spec.marker)) {
    const source = current.toString('utf8');
    assert(Buffer.from(source).equals(current), '文件编码无法识别');
    const patched = Buffer.from(spec.build(source));
    new Script(patched.toString('utf8'), { filename: path.basename(target) });
    return { current, original: current, patched, isPatched: false };
  }

  const directory = backupDirectory();
  const suffix = `-${path.basename(target)}`;
  let stale;
  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      const original = fs.readFileSync(path.join(directory, entry.name));
      if (`${digest(original)}${suffix}` !== entry.name) continue;
      let patched;
      try {
        patched = Buffer.from(spec.build(original.toString('utf8')));
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        continue;
      }
      if (current.equals(patched)) return { current, original, patched, isPatched: true };
      if (!stale) stale = { original, patched };
    }
  }
  if (stale) return { current, original: stale.original, patched: stale.patched, isPatched: true, stale: true };
  throw new Error('检测到已有修改（可能是 Windows 版补丁或其他修改），找不到与当前文件匹配的原始备份。');
}

const runningPattern = line => {
  const s = line.trim();
  return /\/(?:优酷|youku)[^/]*\.app\/Contents\//i.test(s) || /^(?:youku|youkunplayer|优酷)$/i.test(path.basename(s));
};

function requireClosed() {
  const processes = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' });
  if (processes.split('\n').some(runningPattern)) {
    throw new Error('优酷仍在运行。请在菜单栏/程序坞中完全退出优酷（⌘Q）后重试。');
  }
}

function replaceAtomically(target, currentHash, bytes) {
  const pending = path.join(path.dirname(target), `.youku-4k-repair-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(pending, bytes, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      throw new Error('没有写入权限。修改 App 包需要在「系统设置 → 隐私与安全性 → App 管理」里允许你的终端；若 App 归 root 所有，需用 sudo 运行。');
    }
    throw error;
  }
  try {
    if (digest(fs.readFileSync(target)) !== currentHash) throw new Error('操作期间文件发生变化。');
    const mode = fs.statSync(target).mode;
    fs.chmodSync(pending, mode);
    fs.renameSync(pending, target);
  } finally {
    fs.rmSync(pending, { force: true });
  }
  if (digest(fs.readFileSync(target)) !== digest(bytes)) throw new Error('写入后的 SHA-256 验证失败。');
}

function change(spec, target, restore) {
  const { current, original, patched, isPatched, stale } = inspectTarget(spec, target);
  if (!stale && restore !== isPatched) return '已是所需状态';
  const bytes = restore ? original : patched;
  if (!restore) {
    const backup = path.join(backupDirectory(), `${digest(original)}-${path.basename(target)}`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { flag: 'wx' });
    if (!fs.readFileSync(backup).equals(original)) throw new Error('备份的 SHA-256 不匹配。');
  }
  replaceAtomically(target, digest(current), bytes);
  return restore ? '已还原' : (stale ? '已升级到新版补丁并校验' : '已应用并校验');
}

function afterBundleWrite(appPath, resign) {
  if (resign) {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log('已对 App 做 ad-hoc 重签名（官方签名被替换，登录状态可能需要重新登录）。');
    return;
  }
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    console.log('代码签名校验：通过');
  } catch {
    console.log('代码签名校验：已失效（修改了包内资源的正常结果）。若优酷无法启动，可加 --adhoc-resign 重新执行，或用 unprotect 还原。');
  }
}

/* ------------------------------------------------------------------ */
/* probe：只读诊断，用来确认 Mac 客户端结构                              */
/* ------------------------------------------------------------------ */

function count(source, re) { return [...source.matchAll(re)].length; }

function probe(appArg) {
  console.log(`macOS ${os.release()} · ${process.arch} · Node ${process.version}`);
  const apps = appArg ? [appArg] : findAppBundles();
  if (!apps.length) console.log('App：未在 /Applications 找到优酷');
  for (const app of apps) {
    const info = readPlist(app) || {};
    console.log(`App：${app}  版本 ${info.CFBundleShortVersionString || '?'}  (${info.CFBundleIdentifier || '?'})`);
    const res = path.join(app, 'Contents', 'Resources');
    console.log(`  Electron 框架：${fs.existsSync(path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework')) ? '是' : '否/未知'}`);
    console.log(`  app.asar：${fs.existsSync(path.join(res, 'app.asar')) ? '存在' : '无'}；解包目录 app/：${fs.existsSync(path.join(res, 'app')) ? '存在' : '无'}`);
    try {
      const main = mainProdTarget(app);
      const src = fs.readFileSync(main, 'utf8');
      console.log(`  main.prod.js：${main}`);
      console.log(`    已打保护补丁：${src.includes(maintenance.marker) ? '是' : '否'}`);
      for (const [label, s] of [['后台更新入口', automaticCheck], ['更新器初始化', updaterSetup], ['自动清缓存', automaticClear]]) {
        console.log(`    锚点「${label}」命中 ${src.split(s).length - 1} 处`);
      }
    } catch (e) { console.log(`  main.prod.js：${e.message}`); }
  }

  console.log('数据目录候选：');
  for (const dir of appDataCandidates()) {
    console.log(`  ${dir}  ${fs.existsSync(dir) ? (fs.existsSync(path.join(dir, 'layout_caches')) ? '[含 layout_caches]' : '[存在]') : '[不存在]'}`);
    try { console.log(`    内容：${fs.readdirSync(dir).slice(0, 40).join('  ')}`); } catch (e) { if (fs.existsSync(dir)) console.log(`    无法列出：${e.code || e.message}`); }
  }
  let appData;
  try { appData = appDataDir(); } catch (e) { console.log(`  ${e.message}`); return; }

  const found = playerCandidates(appData);
  console.log(`播放页声明的播放器：${found.length} 个`);
  for (const { file, url } of found) {
    console.log(`  ${url} → ${path.basename(file)} ${fs.existsSync(file) ? '' : '[缓存不存在]'}`);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    console.log(`    已打 4K 补丁：${src.includes(player.marker) ? '是' : '否'}；大小 ${src.length} 字符`);
    for (const [k, fn] of Object.entries(playerPatterns)) console.log(`    锚点 ${k} 命中 ${count(src, fn())} 处`);
    for (const token of ['.ElectronIku', '.NPlayer', '.M3U8', '.isMac&&(']) console.log(`    "${token}" 出现 ${src.split(token).length - 1} 次`);
    const at = src.indexOf('.setMultiQuality=function(');
    if (at >= 0) {
      const end = src.indexOf('.prototype.hasQuality=function', at);
      const menu = src.slice(at, end > at ? end : at + 6000);
      const clean = s => s.replace(/(https?:)?\/\/[^\s"'`\\)]+/g, m => m.replace(/[?#].*$/, ''));
      let i = 0, n = 0;
      while ((i = menu.indexOf('isMac', i)) !== -1 && n < 4) {
        console.log(`    菜单内 Mac 片段 #${++n}：${clean(menu.slice(Math.max(0, i - 120), i + 500))}`);
        i += 5;
      }
      const env = menu.indexOf('.ElectronIku){');
      if (env >= 0) console.log(`    菜单内桌面分支：${clean(menu.slice(Math.max(0, env - 200), env + 600))}`);
    }
    let k = 0, m = 0;
    while ((k = src.indexOf('supportType=', k)) !== -1 && m < 4) {
      console.log(`    引擎赋值 #${++m}：${src.slice(Math.max(0, k - 150), k + 250).replace(/(https?:)?\/\/[^\s"'`\\)]+/g, x => x.replace(/[?#].*$/, ''))}`);
      k += 12;
    }
    if (!src.includes(player.marker)) {
      try { new Script(patchPlayer(src)); console.log('    补丁试算：成功（结构匹配，语法有效）'); }
      catch (e) { console.log(`    补丁试算：失败 —— ${e.message}`); }
    }
  }

  for (const dir of [path.join(APP_SUPPORT, 'youku', 'nplayer'), path.join(APP_SUPPORT, 'youku-app', 'nplayer'), path.join(HOME, 'Library', 'Logs')]) {
    if (!fs.existsSync(dir)) continue;
    let logs = [];
    try { logs = fs.readdirSync(dir).filter(n => /player.*\.log$/i.test(n)); } catch { /* ignore */ }
    if (logs.length) console.log(`播放器日志：${dir}（${logs.length} 个）`);
  }
}

/* ------------------------------------------------------------------ */
/* 离线自检                                                            */
/* ------------------------------------------------------------------ */

function playerFixture() {
  return [
    'var Q={"1080p":["mp4hd3v2","mp4hd3","cmaf4hd3","mp5hd3"]};',
    'var E={ElectronIku:"ElectronIku"},S={M3U8:"m3u8",NPlayer:"nplayer"},P={isMac:true};',
    'var L={"1080p":{name:"1080P",label:"",spm:""},"4k":{name:"4K",label:"",spm:""}};',
    'function MR(r){this._model=r;this.user=r.user;this.streamList=r.streamList;this.engine=S.NPlayer}',
    'MR.prototype._checkEmptyStream=function(){return!1};',
    'MR.prototype.getStream=function(e,t){return this._checkEmptyStream()?null:this._model.streamList.find((function(n){return n.lang===e&&n.id===t}))};',
    'function R(c){this._context=c;this._cfg={streamTypeFilter:null};this.seen=[];this._language="default"}',
    'R.prototype.dispatchPropertyChangeEvent=function(){};',
    'R.prototype.setMultiQuality=function(e){var t=this._cfg.streamTypeFilter,n=e;if(!n)return;P.isMac&&(n=n.slice());',
    'if(this._context.config.environment===E.ElectronIku){}if(this._context.supportType===S.M3U8){}',
    'var self=this;var o=!1;if(n.forEach((function(i){var a=i.title&&o?i.title:L[i.name].name,r=i.label&&o?i.label:L[i.name].label,s=L[i.name].spm||"";self.seen.push(a)})),o){}',
    'this.dispatchPropertyChangeEvent("multiQuality")};',
    'R.prototype.hasQuality=function(){return!0};',
    'return{R:R,MR:MR,E:E,S:S};',
  ].join('');
}

function selfCheck() {
  const lower = '#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLU=1080,QUALITY=5,STREAMTYPE="mp5hd3"';
  const regular = '#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLU=2160,QUALITY=6,STREAMTYPE="mp5hd4"';
  const premium = '#EXT-X-STREAM-INF:BANDWIDTH=300,RESOLU=2160,QUALITY=25,STREAMTYPE="hls5hd4_hbr_bit10"';
  const signedUri = 'https://example.test/ordinary?a=1&sig=abc%3D';
  const fixture = ['#EXTM3U', lower, 'https://example.test/lower', regular, signedUri, premium, 'https://example.test/premium', '#EXT-X-ENDLIST', ''].join('\n');
  const expected = ['#EXTM3U', regular, signedUri, '#EXT-X-ENDLIST', ''].join('\r\n');
  assert.equal(selectAdaptive4k(fixture), expected);
  assert.equal(selectAdaptive4k(fixture.replace('QUALITY=6', 'QUALITY=25')), null);
  assert.equal(selectAdaptive4k(fixture.replace('#EXTM3U', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO')), null);

  const drmInfo = { type: 'customized' };
  const auto = { id: 'auto', lang: 'default', drmInfo, uri: { HLS: 'blob:existing', HLSCONTENT: fixture } };
  const resource = { streamList: [auto], user: { vip: true } };
  assert.equal(localAdaptive4k(resource, 'default').drmInfo, drmInfo);
  assert.equal(auto.uri.HLSCONTENT, fixture);
  assert.equal(localAdaptive4k(resource, 'other'), null);
  assert.equal(localAdaptive4k({ ...resource, user: { vip: false } }, 'default'), null);
  assert.throws(() => patchPlayer('unknown build'), /无法唯一识别/);
  assert.throws(() => patchMaintenance('unknown build'), /Expected one match/);

  // Mac 关键差异：isMac=true 时也要能加入菜单，且 NPlayer / M3U8 引擎都放行
  const patched = patchPlayer(playerFixture());
  const mod = new Function(patched)();
  for (const engine of ['NPlayer', 'M3U8']) {
    const r = new mod.R({ config: { environment: mod.E.ElectronIku }, supportType: mod.S[engine] });
    r.mediaResource = resource;
    r.setMultiQuality([{ id: '1080p', name: '1080p' }]);
    assert.deepEqual(r.seen, ['1080P', '智能 4K（固定）'], `引擎 ${engine} 未加入固定 4K`);
  }
  const plain = new mod.R({ config: { environment: 'Web' }, supportType: mod.S.M3U8 });
  plain.mediaResource = resource;
  plain.setMultiQuality([{ id: '1080p', name: '1080p' }]);
  assert.deepEqual(plain.seen, ['1080P'], '非桌面环境不应注入');
  const native4k = new mod.R({ config: { environment: mod.E.ElectronIku }, supportType: mod.S.NPlayer });
  native4k.mediaResource = resource;
  native4k.setMultiQuality([{ id: 'x', name: '4k' }]);
  assert.deepEqual(native4k.seen, ['4K'], '已有原生 4K 时不应重复注入');
  const diag = globalThis.__youku4kDiag;
  assert(diag && diag.runs.length >= 1, '诊断信息未记录');
  const last = diag.runs[diag.runs.length - 1];
  assert.equal(last.reason, 'ok');
  assert.equal(last.isMac, true);
  assert.deepEqual(last.variants, ['BANDWIDTH=100,RESOLU=1080,QUALITY=5,STREAMTYPE=mp5hd3', 'BANDWIDTH=200,RESOLU=2160,QUALITY=6,STREAMTYPE=mp5hd4', 'BANDWIDTH=300,RESOLU=2160,QUALITY=25,STREAMTYPE=hls5hd4_hbr_bit10']);
  assert(!JSON.stringify(diag).includes('example.test'), '诊断信息不应包含播放地址');
  delete globalThis.__youku4kDiag;
  const mr = new mod.MR(resource);
  assert.equal(mr.getStream('default', 'local_adaptive_sdr4k').uri.HLSCONTENT, expected);
  assert.equal(mr.getStream('default', 'auto'), auto);

  const fixtureMain = [automaticCheck, updaterSetup, automaticClear, 'manual.clearCache()'].join('\n');
  const changedMain = patchMaintenance(fixtureMain);
  assert.match(changedMain, /if\(c!=="menu"\).*return e\.a\(2\)/);
  assert.match(changedMain, /autoInstallOnAppQuit=!1/);
  assert.doesNotMatch(changedMain, /Object\(h\.clearCache\)/);
  assert.match(changedMain, /manual\.clearCache\(\)/);

  assert(runningPattern('/Applications/优酷.app/Contents/MacOS/优酷'));
  assert(runningPattern('/Applications/Youku.app/Contents/Frameworks/Youku Helper (Renderer).app/Contents/MacOS/Youku Helper (Renderer)'));
  assert(!runningPattern('/usr/local/bin/node'));
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE = '用法：check | probe [App路径] | status [App路径] | apply | restore | protect [App路径] [--adhoc-resign] | unprotect [App路径] [--adhoc-resign]';

function cli(argv) {
  const flags = argv.filter(a => a.startsWith('--'));
  const [command, appArg, ...rest] = argv.filter(a => !a.startsWith('--'));
  const resign = flags.includes('--adhoc-resign');
  if (rest.length) throw new Error(USAGE);
  if (command === 'check') { selfCheck(); console.log('离线检查通过'); return; }
  if (process.platform !== 'darwin') throw new Error('此版本仅用于 macOS；Windows 请用原项目脚本。');
  if (command === 'probe') { probe(appArg); return; }
  if (command === 'status') {
    const specs = [{ label: '4K 菜单', spec: player }];
    if (appArg) specs.push({ label: '更新与缓存保护', spec: maintenance });
    for (const { label, spec } of specs) {
      try {
        const { isPatched, stale } = inspectTarget(spec, targetPath(spec, appArg));
        console.log(`${label}：${stale ? '已应用旧版补丁（运行 apply 可升级）' : isPatched ? '已应用（当前版本）' : '匹配，可应用'}`);
      } catch (error) {
        console.error(`${label}：${error.message}`);
        process.exitCode = 1;
      }
    }
    return;
  }
  const isPlayer = ['apply', 'restore'].includes(command) && !appArg;
  const isMaint = ['protect', 'unprotect'].includes(command);
  if (!isPlayer && !isMaint) throw new Error(USAGE);
  const spec = isPlayer ? player : maintenance;
  const target = targetPath(spec, appArg);
  requireClosed();
  const result = change(spec, target, command === 'restore' || command === 'unprotect');
  console.log(result);
  if (spec.inBundle && result !== '已是所需状态') afterBundleWrite(resolveApp(appArg), resign);
}

if (require.main === module) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { patchPlayer, patchMaintenance, selectAdaptive4k, localAdaptive4k, selfCheck, cli };
