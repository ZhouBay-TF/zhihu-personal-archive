# 知乎个人内容归档 Skill

一个无第三方依赖的本地 Skill，用于：

- 备份本人知乎回答 / 想法 / 文章（Markdown + HTML + 图片 + meta）
- 抓取公开热榜
- 导出本人邀请与推荐问题

## 打包

```bash
cd zhihu-personal-archive
zip -r ../zhihu-personal-archive.zip . -x ".DS_Store" -x "archive/*" -x ".chrome-profile/*"
```

Windows PowerShell：

```powershell
Compress-Archive -Path .\* -DestinationPath ..\zhihu-personal-archive.zip -Force
```

## 快速开始

```bash
node scripts/launch-chrome.mjs
# 扫码登录后
node scripts/collect-content.mjs --out=./archive
node scripts/export-content.mjs --out=./archive
node scripts/fetch-hot.mjs --out=./archive/hot
node scripts/fetch-questions.mjs --out=./archive/questions
```

详细说明见 `SKILL.md`，合规风险见 `references/compliance.md`。
