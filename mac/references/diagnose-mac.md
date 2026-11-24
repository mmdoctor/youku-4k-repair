# Mac 端诊断与适配

## 已验证（2026-11-23，优酷 Mac 9.5.6，Apple Silicon，播放器 kuplayer 4.24.1-xmedia）

- 缓存位置：`~/Library/Containers/com.youku.mac/data/{layout_caches,local_caches}`（由 main.prod.js 的 `getUserPath` 在 darwin 下决定），与 Windows 版同一套机制。
- 引擎为 NPlayer；`enable4k=true`、`hardware=true`，Mac 分支不会移除注入的档位。
- 《航拍中国 4K版》：智能清单含唯一 `RESOLU=2160,QUALITY=6,STREAMTYPE=mp5hd4`，菜单出现「智能 4K（固定）」；选中后原生播放日志（`~/Library/Containers/优酷/PlayLog/`）显示 `local_adaptive_sdr4k`、`gear quality:6, stream type mp5hd4` 分片下载。
- 只有 1080P 的影片（如部分电视剧）清单里没有 2160 档，补丁不加选项，属正常。
- 另见一种清单格式：`RESOLUTION=3840x2160,CODECS=hvc1…`，无 `QUALITY`/`STREAMTYPE`。出现在同时提供 SVIP「帧享 4K」的影片中，无法据此判断是否普通 SDR 4K，**补丁有意不匹配**。
- 不改 app.asar：主程序打包在 asar 内、启用强化运行时与官方签名，`protect` 在此版本不可用。


## 首次适配时的假设（历史记录，已被上面的实测结果取代；换版时可参考）

1. **Mac 客户端是 Electron 版，数据目录为 `~/Library/Application Support/youku-app`**：Windows 用的是 `%APPDATA%\youku-app`（Electron 的 userData），Mac 上对应这个位置。probe 会列出候选目录和是否存在 `layout_caches`。
2. **播放器脚本与 Windows 相同**：kuplayer 从 `g.alicdn.com/kplayer/kuplayer/<版本>/index.js` 加载，两个平台通常共用。probe 会对每个锚点报告命中次数，并试算一次补丁。
3. **Mac 播放引擎**：原版只在 Windows 的原生 `NPlayer` 上注入。Mac 可能也走 NPlayer，也可能走 `M3U8`（网页内 HLS）。两种这里都放行。
   - 如果走 M3U8 引擎：菜单项会出现，但播放器可能读的是 `uri.HLS`（blob 地址）而不是裁剪后的 `HLSCONTENT`，实际仍是自适应码流。必须按下面的方法验收。
4. **主进程路径**：查找 `Contents/Resources/app/app/main/dist/main.prod.js` 等位置。混淆后的变量名（`f.a`、`r.kuLog`、`h.clearCache`）与 Windows 构建不一定相同。如果 probe 显示锚点命中 0 处，不要强行 protect。

## probe 结果怎么看

- 「补丁试算：成功」→ 可以 `apply`。
- 「无法唯一识别 X（命中 0 处）」→ 这一版播放器结构变了，需要按 X 对应的正则重新找函数。命中多处说明锚点过宽。
- 「菜单内 Mac 分支片段」→ 原播放器在 Mac 上专门做的处理。如果它会过滤掉 4K 或改写列表，看注入点（`forEach` 之前）是否仍在它之后。
- 「发现多个播放页指向不同播放器」→ 先打开影片，确认当前窗口加载的是哪个版本，清掉旧缓存后再试。

## 验收

- 能用 Safari 的「开发 → 优酷」或 `--remote-debugging-port` 调试时：在播放页控制台检查 `video.videoWidth`，或者看 Network 里请求的是不是 `mp5hd4` 分片。
- 原生播放器日志：可在 `~/Library/Application Support/youku*/nplayer`、`~/Library/Logs` 下找 `*player*.log`，查看 `FirstFrame`、`video width:3840`。
- 证据要求：实际点击了该菜单项，记录为 `4k`，点击后首帧为 3840 宽，并且同一会话中只有 `RESOLU=2160` 的一个普通变体。

## 失效场景

远程播放页换了播放器版本、手动清缓存、清理工具、重装或升级都会让补丁失效。重新运行 `probe` → `status` → `apply` 即可。
