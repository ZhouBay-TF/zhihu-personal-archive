# 故障排查

## Chrome 调试端口没开

现象：`CDP connect ECONNREFUSED`、`fetch failed`。

处理：

```bash
node scripts/launch-chrome.mjs
```

确认 Chrome 窗口已经打开，并且地址栏能访问知乎。脚本默认使用 9222 端口；被占用时：

```bash
ZHIHU_CDP_PORT=9333 node scripts/launch-chrome.mjs
node scripts/collect-content.mjs --port=9333 --out=./archive
```

## 登录失效

现象：接口返回 401 / 403，或提示“登录状态可能失效”。

处理：

1. 在专用 Chrome 窗口里重新扫码登录。
2. 确认打开的是 `https://www.zhihu.com/`，不是无痕窗口。
3. 重新运行命令。

不要在登录失效后循环重试，先手动登录。

## 采集到 0 条内容

- 确认账号确实有已发布内容。
- 确认页面是 `https://www.zhihu.com/creator/manage/creation/all`。
- 确认登录的是本人账号。
- 换用 `--types=answer` 单独试。

## 导出很慢/图片失败

- 默认每条之间有约 0.55 秒间隔，属于正常限速。
- 图片失败不会中断正文导出；`meta.json` 会记录失败的图片。
- 视频原文件不下载，只在 Markdown 中保留原文链接。

## 条目被跳过

已有 `answer.md` 和 `meta.json` 的条目会自动跳过。要重新导出：

```bash
node scripts/export-content.mjs --out=./archive --force=true
```

## 内容清单被覆盖

`collect-content.mjs` 会覆盖 `archive/_lists/*.json`。如果要做新旧对比，先把旧 `archive/_lists` 复制到另一个目录，再用 `--lists=` 指向它。

## 页面结构变化

知乎页面改版可能导致正文提取失败。先只试一条：

```bash
node scripts/export-content.mjs --out=./archive --limit=1
```

如果失败，查看 `meta.json` / 控制台错误；必要时更新 `scripts/extract-page.js`。

## 平台验证/限流

出现验证码、“访问过于频繁”、403 时：

1. 立即停止运行。
2. 在 Chrome 里手动完成验证。
3. 至少隔几个小时再试；不要换 IP、换账号或写重试循环来绕过。

## 路径问题

Windows 下路径含空格时用引号：

```powershell
node .\scripts\collect-content.mjs --out="D:\my archive"
```

macOS/Linux 同理。
