# 优酷普通 4K 修复

> **macOS 用户**：Mac 版移植见 [`mac/`](mac/)（优酷 Mac 9.5.6 实测可用）。以下内容为原作者的 Windows 版说明。

恢复 Windows 优酷的「智能 4K（固定）」菜单项，适用于原播放器的「智能」已经收到普通 SDR 4K 的影片。可选的保护补丁可以关闭优酷的后台更新和自动资源缓存清理。脚本从本机播放页找到播放器，再按代码结构自动匹配。

## 安装为 Codex 技能

将解压得到的整个 `youku-4k-repair` 目录放进 Codex 当前使用的用户技能目录。常见路径为 `%USERPROFILE%\.agents\skills`。已经配置了其他技能目录的电脑，沿用现有技能的安装位置。新开一个聊天，用 `$youku-4k-repair` 调用。如果列表仍未出现，重新打开 Codex。

也可以把下面这句话连同解压后的目录交给 Codex。

> 请把这个 `youku-4k-repair` 技能安装到当前 Codex 的用户技能目录，验证能加载。先运行只读补丁状态检查。需要修改优酷文件时按我给出的授权操作。

## 单独使用补丁

需要 Windows、优酷和 Node.js 18 或更高版本。在解压后的 `youku-4k-repair` 目录打开 PowerShell。同一份脚本也供 Codex Skill 调用。

```powershell
node .\scripts\youku-patch.cjs check
node .\scripts\youku-patch.cjs status
```

打开一部影片生成播放器缓存，然后从托盘完全退出优酷。

```powershell
node .\scripts\youku-patch.cjs apply
```

如需关闭后台更新和自动资源缓存清理，再执行下面的命令。把示例路径替换为包含 `YOUKU.exe` 的安装目录。

```powershell
node .\scripts\youku-patch.cjs protect "C:\Apps\YOUKU\9.5.3.1001"
```

重开优酷，在支持普通 4K 的影片里打开右下角画质菜单。客户端或播放器换版后可以直接重新运行。只有找不到对应缓存、存在多个候选或实际代码结构变化时，才需要通过 Codex Skill 进一步定位和适配。

## 还原

退出优酷后按需要执行。两种变更可独立还原。

```powershell
node .\scripts\youku-patch.cjs restore
node .\scripts\youku-patch.cjs unprotect "C:\Apps\YOUKU\9.5.3.1001"
```

安装、应用和退出保护都不会需要输入账号凭据。脚本从本机文件生成补丁，备份放在 `%LOCALAPPDATA%\youku-4k-repair\backups`。
