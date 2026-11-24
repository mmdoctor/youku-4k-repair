---
name: youku-4k-repair-mac
description: 在 macOS 优酷客户端上核验、恢复和验证普通 SDR 4K 手选入口「智能 4K（固定）」，并在客户端或播放器更新后重新适配。适用于「智能」能播 4K 但手选项缺失的情况。帧享 SVIP、HDR 解锁、App 包修改和手机端不在本技能范围内。
---

# 优酷普通 4K 修复（macOS）

1. 运行 `node scripts/youku-patch-mac.cjs check`，再运行 `status`。缓存位于 `~/Library/Containers/com.youku.mac/data`。如果提示未找到缓存，先让用户播放一部影片，再 ⌘Q 完全退出优酷。
2. `status` 显示可应用后，先征得用户同意，确认优酷已 ⌘Q 退出，再执行 `apply`。还原用 `restore`。不要修改 `app.asar`，因为它带官方签名和强化运行时。
3. 某部影片不出现选项时，用调试端口启动优酷（`open -a "优酷" --args --remote-debugging-port=9222`），然后运行 `scripts/diag-live.cjs`，按输出中的结论判断原因。只固定清单里唯一的 `RESOLU=2160 / QUALITY=6 / mp5hd4`。格式为 `RESOLUTION=3840x…` 且缺少档位字段的清单无法确认是普通 4K，不做匹配。
4. `status` 报「无法唯一识别」时，先运行 `probe`，再参照 [Mac 诊断与适配](references/diagnose-mac.md) 重新定位代码结构，在副本上验证补丁和回滚。
5. 验收标准：菜单中出现该选项；选中后运行 `scripts/verify-4k.cjs`，日志里能看到 `local_adaptive_sdr4k` 和 `mp5hd4` 分片；正常重启优酷后选项仍在。诊断完成后提醒用户 ⌘Q 退出并正常重开，以关闭调试端口。

分享时只打包本目录下的自写脚本和文档。播放器原包、补丁后的厂商脚本、备份、日志和账号文件都只留在本机。
