---
name: zhihu-personal-archive
description: 备份本人知乎回答/想法/文章，导出邀请与推荐问题，并抓取公开热榜。仅限本人账号、手动登录、低频使用。
version: 1.0.0
---

# 知乎个人内容归档

把**你自己账号**的知乎内容、邀请/推荐问题和公开热榜保存到本地，方便个人备份与复盘。

## 合规边界（先读）

- 只处理**本人账号**的创作内容；不要采集、保存或分发他人的回答、评论、私信。
- 需要登录的功能（邀请、推荐）依赖你在本机 Chrome 里**手动扫码登录**；本 Skill 不收集密码、不保存 Cookie 到代码里、不绕过验证码/风控。
- 不要高频运行，不要做定时批量抓取；建议每天最多一次，遇到 401/403/安全验证立即停止。
- 热榜是公开数据，但自动化访问仍可能受平台规则约束；邀请/推荐属于账号个性化数据，风险更高。
- **上传到知乎 Skill 市场前请先读 `references/compliance.md`。** 如果平台规则禁止自动化访问/数据采集，请不要上传或使用本 Skill；这份说明不构成法律意见。

## 适用场景

- 想定期备份自己写过的回答、想法、文章和图片。
- 想把自己收到的邀请、推荐问题整理成 Markdown 做选题分析。
- 想每天记录一次公开热榜，观察热点变化。

## 环境要求

- Node.js 20 或更高版本（不需要 npm install）。
- Google Chrome / Chromium。
- 本机可以打开 Chrome 窗口并扫码登录知乎。
- Windows、macOS、Linux 均可；脚本会自己找 Chrome。

## 首次使用

### 1. 启动专用 Chrome

```bash
node scripts/launch-chrome.mjs
```

脚本会在 `~/.zhihu-archive/chrome-profile` 创建独立配置并打开知乎。**请在弹出的 Chrome 窗口里扫码登录**，登录后保持窗口运行。

- 如果 Chrome 不在默认路径，设置 `CHROME_PATH`。
- 换调试端口：`ZHIHU_CDP_PORT=9333 node scripts/launch-chrome.mjs`。
- 专用配置目录：`ZHIHU_PROFILE_DIR=/path/to/profile node scripts/launch-chrome.mjs`。

### 2. 采集内容清单

```bash
node scripts/collect-content.mjs --out=./archive
```

写入 `archive/_lists/answer.json`、`pin.json`、`article.json`。

### 3. 导出正文和图片

```bash
node scripts/export-content.mjs --out=./archive
```

第一次会逐条导出；已有 `answer.md` 和 `meta.json` 的条目会自动跳过，可断点续跑。只想试跑 3 条：

```bash
node scripts/export-content.mjs --out=./archive --limit=3
```

### 4. 公开热榜（不需要登录）

```bash
node scripts/fetch-hot.mjs --out=./archive/hot
```

输出 `YYYY-MM-DD.md`、`.json` 和 `.raw.json`。

### 5. 邀请 + 推荐问题（需要登录）

```bash
node scripts/fetch-questions.mjs --out=./archive/questions
```

各取最新/前 30 条，输出 `invites-30.md`、`recommend-30.md`、`all-30.md` 和 JSON。

> 这一步读取的是账号个性化数据，建议只在本人电脑上低频运行；不要把它做成公开服务或定时任务。

## 输出结构

```text
archive/
├─ _lists/
│  ├─ answer.json
│  ├─ pin.json
│  ├─ article.json
│  └─ all-content.json
├─ answers/<id>/
│  ├─ answer.md
│  ├─ content.html
│  ├─ raw.html
│  ├─ meta.json
│  └─ images/
├─ pins/<id>/...
├─ articles/<id>/...
├─ index.html
├─ index.md
├─ index.json
├─ hot/
│  ├─ YYYY-MM-DD.md
│  ├─ YYYY-MM-DD.json
│  └─ YYYY-MM-DD.raw.json
└─ questions/
   ├─ invites-30.md / .json
   ├─ recommend-30.md / .json
   └─ all-30.md / .json
```

## 常用参数

| 参数 | 作用 |
|---|---|
| `--out=...` | 输出目录，默认 `./archive` |
| `--limit=N` | 只导出前 N 条（测试用） |
| `--force=true` | 重新导出已存在的条目 |
| `--types=answer,pin` | 只处理指定类型 |
| `--port=9222` | Chrome 调试端口 |
| `--lists=...` | 指定内容清单目录 |
| `--delay=800` | 每条之间的间隔毫秒数 |

## 运行原则

1. **只备份自己的内容。**
2. **手动登录，不保存密码。**
3. **低频：每天最多一次；不要并发、不要循环重试。**
4. **遇到 401/403、验证码、访问过于频繁，立即停止。**
5. **不公开分享导出的内容、Cookie、Chrome 配置目录。**
6. **不上传包含个人数据的 `archive/`、`.chrome-profile` 或 Cookie。**

## 故障排查

见 `references/troubleshooting.md`。最常见的问题是：

- Chrome 调试端口没开：先运行 `launch-chrome.mjs`。
- 登录失效：在专用 Chrome 窗口里重新扫码。
- 内容清单为空：确认当前页面是知乎个人创作中心，且账号已登录。

## 合规与免责声明

本 Skill 只提供本地导出工具，不托管任何账号数据，也不提供绕过平台限制的能力。使用者应自行确认知乎的服务条款、robots 规则和 Skill 平台规范；因使用本工具导致的账号限制、内容删除或数据风险，由使用者自行承担。
