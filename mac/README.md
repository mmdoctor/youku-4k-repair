# 优酷普通 4K 修复 · macOS 版

移植自 [mmdoctor/youku-4k-repair](https://github.com/mmdoctor/youku-4k-repair)（Windows 版）。

## 它解决什么问题

VIP 账号在优酷 Mac 客户端选「智能」画质时，部分影片其实已经下发了普通 SDR 4K（`2160` / `QUALITY=6` / `mp5hd4`），但手选菜单里没有 4K 可选。
补丁会在画质菜单里加一项 **「智能 4K（固定）」**，把「智能」已经下发的这一档 4K 固定下来。

- 只改优酷本地缓存里的播放器脚本，**不改 App 包，不影响官方签名**。
- 沿用原有的会员校验、签名地址和 DRM。**不解锁** SVIP「帧享 4K」、HDR 或任何付费权益。
- 不读取、也不导出账号、Cookie 或播放地址。

## 已验证环境

| 项目 | 版本 |
|---|---|
| 系统 | macOS 27.2，Apple Silicon |
| 优酷 | 9.5.6（9.5.6.1001），`/Applications/优酷.app` |
| 播放器 | `kuplayer 4.24.1-xmedia`，原生 NPlayer 引擎 |
| Node.js | v26（需要 18 及以上；运行 `diag-live` 需要 22 及以上） |
| 实测影片 | 《航拍中国 4K版》：菜单出现选项，选中后原生播放器日志显示 `local_adaptive_sdr4k`、`gear quality:6, stream type mp5hd4` |

## 目录

```
youku-4k-repair-mac/
├── README.md                    本说明
├── SKILL.md                     Codex 技能描述
├── references/diagnose-mac.md   诊断记录与适配说明
└── scripts/
    ├── youku-patch-mac.cjs      主脚本：check / probe / status / apply / restore
    ├── diag-live.cjs            运行时诊断：为什么某部片没出现选项
    ├── verify-4k.cjs            验收：从播放器日志里找 4K 分片
    ├── probe-deep.cjs           深度结构诊断（App 包、asar、安全开关）
    └── probe-paths.cjs          缓存位置诊断
```

所有命令都在这个目录下执行：

```bash
git clone <本仓库地址>
cd youku-4k-repair-mac
```

也可以直接下载 ZIP 解压，在解压出来的目录里执行。

## 快速使用

### 1. 自检（不碰任何优酷文件）

```bash
node scripts/youku-patch-mac.cjs check
```

看到 `离线检查通过` 再继续。

### 2. 生成缓存，然后完全退出

在优酷里随便打开一部影片，播放几秒，然后按 **⌘Q** 完全退出。只关窗口不算退出。

### 3. 检查能不能打补丁

```bash
node scripts/youku-patch-mac.cjs status
```

| 输出 | 含义 |
|---|---|
| `匹配，可应用` | 可以执行下一步 |
| `已应用（当前版本）` | 已经打好，不用再操作 |
| `已应用旧版补丁（运行 apply 可升级）` | 执行 `apply` 即可升级 |
| `无法唯一识别…` | 播放器结构变了，先运行 `probe`，见下文「排查」 |

### 4. 应用

```bash
node scripts/youku-patch-mac.cjs apply
```

看到 `已应用并校验` 就完成了。原文件会先备份到 `~/Library/Application Support/youku-4k-repair/backups`（按 SHA-256 命名）。

### 5. 使用

重新打开优酷，在有普通 4K 的影片里打开右下角画质菜单，选 **「智能 4K（固定）」**。

## 哪些影片会出现这个选项

只有「智能」清单里本来就有普通 4K 的影片才会出现：

| 情况 | 例子 | 是否出现 |
|---|---|---|
| 「智能」清单里有 `mp5hd4` 档 | 《航拍中国 4K版》 | ✅ 出现 |
| 最高只有 1080P | 部分电视剧（如《谷雨》） | ❌ 不出现，正常 |
| 菜单里本来就有原生「4K」 | 部分电影 | ❌ 不重复添加，直接用原生项 |
| 只有 SVIP「帧享 4K」，「智能」清单格式为 `RESOLUTION=3840x…` | 部分新剧和电影 | ❌ **有意不处理**：无法确认是普通 4K，避免越过会员权益 |

## 验收

选中「智能 4K（固定）」并播放 20 秒后：

```bash
node scripts/verify-4k.cjs
```

日志里出现 `local_adaptive_sdr4k` 和 `stream type mp5hd4`，就说明正在播放这一档普通 4K。航拍类影片在 4K 下细节差别很明显，也可以直接看画面判断。

建议再按 ⌘Q 退出、正常打开一次，确认选项还在。

## 还原

先按 ⌘Q 退出优酷，再执行：

```bash
node scripts/youku-patch-mac.cjs restore
```

看到 `已还原` 即可。备份目录可以留着，也可以手动删除。

## 补丁失效了怎么办

优酷在线更新播放页或播放器、手动清缓存、重装或升级客户端，都可能让选项消失。这时重新执行一遍：

```bash
node scripts/youku-patch-mac.cjs status
node scripts/youku-patch-mac.cjs apply
```

播放器版本变了（例如不再是 `4.24.1-xmedia`）时，只要代码结构没变，脚本照样能自动匹配。结构变了，`status` 会报 `无法唯一识别…`，这时按下面的「排查」处理。

## 排查

### 某部片没出现选项

用调试端口启动优酷，读出补丁记录下来的诊断信息。这一步只读，不改任何文件：

```bash
# 1. ⌘Q 退出优酷，然后：
open -a "优酷" --args --remote-debugging-port=9222
# 2. 打开那部影片，切到「智能」播放 10 秒，打开一次画质菜单
# 3. 保持优酷开着，运行：
node scripts/diag-live.cjs
# 4. 用完后 ⌘Q 退出，再正常打开（这样就关掉了调试端口）
```

看输出里的「结论」：

| 结论 | 含义 |
|---|---|
| `ok` | 条件都满足，选项应该已经出现 |
| `no-unique-mp5hd4-2160` | 这部片的「智能」清单里没有普通 4K（或格式无法确认），属正常 |
| `no-hlscontent` | 还没切到「智能」，切过去再试 |
| `not-vip` | 播放器认为当前账号不是 VIP |
| 补丁诊断：无记录 | 页面加载的不是打过补丁的播放器，重新执行 `status` 和 `apply` |

### `status` 报「无法唯一识别…」

```bash
node scripts/youku-patch-mac.cjs probe
```

它会列出各匹配点的命中次数和补丁试算结果。如果命中 0 处或多处，说明播放器代码改版了，要按 `references/diagnose-mac.md` 重新适配。

### 常见问题

- **终端提示 `Operation not permitted`**：在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里允许「终端」，然后重开终端。
- **提示「优酷仍在运行」**：⌘Q 完全退出，菜单栏里也不能留着优酷的图标。
- **终端里出现大量 `zsh: command not found`**：是把输出内容粘回了终端，忽略即可，不影响任何东西。
- **选中后黑屏或报错**：⌘Q 退出后执行 `restore`，再记下当时的现象。

## 与 Windows 版的区别

| 项目 | Windows 原版 | Mac 版 |
|---|---|---|
| 缓存位置 | `%APPDATA%\youku-app\{layout,local}_caches` | `~/Library/Containers/com.youku.mac/data/{layout,local}_caches` |
| 注入条件 | 非 Mac，且引擎为 NPlayer | 去掉 Mac 排除，接受 NPlayer 和 M3U8 两种引擎 |
| 进程检测 | `tasklist.exe` | `ps`（包括所有 Helper 进程） |
| 备份位置 | `%LOCALAPPDATA%\youku-4k-repair\backups` | `~/Library/Application Support/youku-4k-repair/backups` |
| 后台更新和自动清缓存保护（`protect`） | 支持 | **这一版不支持**：主程序打包在签名过的 `app.asar` 里，修改会破坏官方签名 |
| 诊断工具 | — | `probe`、`diag-live`、`verify-4k` |

## 免责声明

修改客户端缓存文件可能违反优酷用户协议，风险自担。本工具只固定当前账号已经获授权、「智能」已经下发的普通 4K，不绕过任何付费或会员校验。分享时只分享本目录，**不要**附带播放器原文件、补丁后的厂商脚本、备份、日志或账号文件。

提 Issue 贴诊断输出前请先检查一遍：脚本已把家目录替换成 `~`，播放地址也去掉了查询参数，但影片标题等信息仍会保留。
