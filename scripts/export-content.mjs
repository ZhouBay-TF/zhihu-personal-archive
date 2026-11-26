import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, sleep } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  const hit = args[i];
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : (args[i + 1] ?? 'true');
};
const port = Number(getArg('port', process.env.ZHIHU_CDP_PORT || 9222));
const typeFilter = (getArg('types', 'answer,article,pin') || '').split(',').filter(Boolean);
const limit = Number(getArg('limit', 0)) || 0;
const force = getArg('force', 'false') === 'true';
const outRoot = path.resolve(getArg('out', path.join(ROOT, 'archive')));
const delayMs = Number(getArg('delay', 550));
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const projectRoot = ROOT;
const listsDir = path.resolve(getArg('lists', path.join(outRoot, '_lists')));
const extractCode = await fs.readFile(path.join(HERE, 'extract-page.js'), 'utf8');

const typeInfo = {
  answer: { folder: 'answers', label: '回答', file: 'answer.md' },
  article: { folder: 'articles', label: '文章', file: 'article.md' },
  pin: { folder: 'pins', label: '想法', file: 'pin.md' }
};

await fs.mkdir(outRoot, { recursive: true });

let items = [];
for (const type of typeFilter) {
  const file = path.join(listsDir, `${type}.json`);
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const item of data.items || []) items.push({ ...item, type });
    console.log(`loaded ${data.items?.length || 0} ${type} items from ${file}`);
  } catch (e) {
    console.warn(`skip ${type}: cannot read ${file} (${e.message})`);
  }
}
items = items.filter((it) => typeInfo[it.type]);
if (limit > 0) items = items.slice(0, limit);
if (!items.length) {
  console.error('No items to export. Run collect.mjs first.');
  process.exit(2);
}

const cdp = await CDP.connect(port);
const existing = await cdp.listPages();
if (!existing.some((p) => p.type === 'page' && p.url.includes('zhihu.com'))) {
  console.error('Chrome is running but no Zhihu page is open. Log in first via start-chrome.ps1.');
  process.exit(3);
}

const { targetId, sessionId } = await cdp.createPage('about:blank');
// Use the already-open creator tab as the same-origin context for fetching answer/pin HTML.
const creatorPage = existing.find((p) => p.type === 'page' && p.url.includes('/creator/'));
let fetchSessionId = sessionId;
if (creatorPage) {
  fetchSessionId = await cdp.attach(creatorPage.id);
} else {
  await cdp.navigate('https://www.zhihu.com/robots.txt', sessionId, { waitMs: 500 });
}
// The extractor only needs the server-rendered DOM and data-original image URLs.
// Blocking media/fonts makes page loads much faster and avoids doubling image bandwidth.
await cdp.send('Network.enable', {}, sessionId);
await cdp.send('Network.setBlockedURLs', {
  urls: [
    '*.jpg*', '*.jpeg*', '*.png*', '*.webp*', '*.gif*', '*.avif*', '*.svg*',
    '*.woff*', '*.woff2*', '*.ttf*', '*.otf*',
    '*.mp4*', '*.webm*', '*.m3u8*', '*.mpd*'
  ]
}, sessionId);
const stats = { done: 0, skipped: 0, failed: 0, images: 0, imageFailed: 0 };
const errors = [];
let fatal = null;

function yamlStr(value) {
  return JSON.stringify(String(value ?? ''));
}

function htmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extFrom(contentType, url) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif'
  };
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (map[ct]) return map[ct];
  try {
    const m = new URL(url).pathname.match(/\.(jpe?g|png|gif|webp|avif|svg)$/i);
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  } catch { /* ignore */ }
  return 'jpg';
}

async function downloadImage(url, dir, index) {
  const res = await fetch(url, {
    headers: { Referer: 'https://www.zhihu.com/', 'User-Agent': ua },
    redirect: 'follow',
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty response');
  const ext = extFrom(res.headers.get('content-type'), url);
  const name = String(index + 1).padStart(3, '0') + '.' + ext;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), buf);
  return { name, bytes: buf.length, contentType: res.headers.get('content-type') };
}

const css = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f6f6; color: #121212; font: 16px/1.8 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 36px 22px 80px; background: #fff; min-height: 100vh; }
header h1 { font-size: 30px; line-height: 1.35; margin: 0 0 12px; }
.meta { color: #646464; font-size: 14px; margin-bottom: 8px; }
.meta span + span::before { content: " · "; }
.source a { color: #056de8; font-size: 13px; text-decoration: none; }
article.content { margin-top: 28px; font-size: 17px; line-height: 1.85; word-wrap: break-word; }
article.content p { margin: 0 0 1em; }
article.content img { max-width: 100%; height: auto; display: block; margin: 1.2em auto; border-radius: 4px; }
article.content figure { margin: 1.2em 0; }
article.content figcaption { text-align: center; color: #999; font-size: 13px; }
article.content blockquote { margin: 1em 0; padding: 0.2em 1em; border-left: 3px solid #d3d3d3; color: #555; background: #fafafa; }
article.content pre { background: #f6f8fa; padding: 14px 16px; overflow: auto; border-radius: 6px; font-size: 14px; line-height: 1.5; }
article.content code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: #f2f2f2; padding: 0.1em 0.3em; border-radius: 3px; }
article.content pre code { background: none; padding: 0; }
article.content table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 15px; }
article.content th, article.content td { border: 1px solid #ddd; padding: 6px 10px; }
article.content th { background: #f6f6f6; }
article.content hr { border: 0; border-top: 1px solid #eee; margin: 2em 0; }
article.content .ztext-math { font-family: ui-monospace, Consolas, monospace; color: #333; background: #f7f7f7; padding: 0.1em 0.25em; border-radius: 3px; }
footer { margin-top: 48px; color: #999; font-size: 12px; border-top: 1px solid #eee; padding-top: 14px; }
`;

function contentPage(data, meta) {
  const metaBits = [
    typeInfo[data.type]?.label || data.type,
    data.author,
    data.published,
    data.location
  ].filter(Boolean).map((x) => `<span>${htmlEscape(x)}</span>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(data.title)}</title>
<style>${css}</style>
</head>
<body>
<main>
<header>
<h1>${htmlEscape(data.title)}</h1>
<div class="meta">${metaBits}</div>
<div class="source"><a href="${htmlEscape(data.url)}" target="_blank" rel="noopener noreferrer">查看知乎原文</a></div>
</header>
<article class="content">${meta.contentHtml}</article>
<footer>导出于 ${htmlEscape(meta.exportedAt)} · 仅供个人备份使用</footer>
</main>
</body>
</html>`;
}

function rawPage(data) {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${htmlEscape(data.title)} (原始 HTML)</title>
<style>body{max-width:820px;margin:30px auto;padding:0 20px;font:16px/1.8 -apple-system,"Microsoft YaHei",sans-serif}img{max-width:100%;height:auto}</style>
</head>
<body><h1>${htmlEscape(data.title)}</h1><div class="RichText">${data.rawHtml}</div></body></html>`;
}

function frontMatter(data, meta) {
  const lines = ['---'];
  lines.push(`title: ${yamlStr(data.title)}`);
  lines.push(`type: ${data.type}`);
  lines.push(`id: ${yamlStr(data.id)}`);
  lines.push(`url: ${yamlStr(data.url)}`);
  if (data.question) lines.push(`question: ${yamlStr(data.question)}`);
  if (data.questionId) lines.push(`question_id: ${yamlStr(data.questionId)}`);
  if (data.author) lines.push(`author: ${yamlStr(data.author)}`);
  if (data.authorUrl) lines.push(`author_url: ${yamlStr(data.authorUrl)}`);
  if (data.published) lines.push(`published: ${yamlStr(data.published)}`);
  if (data.location) lines.push(`location: ${yamlStr(data.location)}`);
  if (data.voteup != null) lines.push(`voteup: ${data.voteup}`);
  if (data.comments != null) lines.push(`comments: ${data.comments}`);
  if (meta.imageCount) lines.push(`images: ${meta.imageCount}`);
  lines.push(`exported_at: ${yamlStr(meta.exportedAt)}`);
  lines.push('---', '');
  return lines.join('\n');
}

for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const info = typeInfo[item.type];
  const dir = path.join(outRoot, info.folder, item.id);
  const mdFile = path.join(dir, info.file);
  const metaFile = path.join(dir, 'meta.json');
  const tag = `[${i + 1}/${items.length}] ${item.type} ${item.id}`;

  try {
    if (!force) {
      try {
        await fs.access(mdFile);
        await fs.access(metaFile);
        stats.skipped++;
        console.log(`${tag} skip (already exported)`);
        continue;
      } catch { /* not exported yet */ }
    }

    console.log(`${tag} ${item.title || ''}`.slice(0, 120));

    let data;
    if (item.type === 'article') {
      // Articles live on zhuanlan.zhihu.com; navigate rather than cross-origin fetch.
      await cdp.navigate(item.url, sessionId, { waitMs: 700 });
      await cdp.waitFor("document.querySelector('.Post-RichText, .RichText') !== null", sessionId, { timeoutMs: 25000 });
      await sleep(500);
      const state = await cdp.eval(`({url: location.href, title: document.title})`, sessionId);
      if (state.url.includes('signin')) throw new Error('登录状态已失效，请重新扫码登录');
      if (/安全验证|访问过于频繁/.test(state.title)) throw new Error(`触发页面验证/限流：${state.title}`);
      data = await cdp.eval(`(${extractCode})(document, location.href)`, sessionId, { timeoutMs: 45000 });
    } else {
      data = await cdp.eval(`(async () => {
        const url = ${JSON.stringify(item.url)};
        let res;
        try {
          res = await fetch(url, { credentials: 'include', headers: { 'Accept': 'text/html,application/xhtml+xml' }, redirect: 'follow' });
        } catch (e) {
          return { __error: 'fetch failed: ' + e.message };
        }
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const title = doc.title || '';
        const bodyText = (doc.body && doc.body.textContent || '').slice(0, 800);
        if (res.url.includes('/signin') || /安全验证|访问过于频繁|验证码/.test(title + ' ' + bodyText)) {
          return { __error: '触发页面验证/限流：' + (title || bodyText.slice(0, 120)), __finalUrl: res.url };
        }
        if (!res.ok) return { __error: 'HTTP ' + res.status, __finalUrl: res.url };
        return (${extractCode})(doc, url);
      })()`, fetchSessionId, { timeoutMs: 60000 });
    }
    if (data.__error) throw new Error(data.__error);
    if (!data.ok) throw new Error(`${data.error || 'extraction failed'} ${data.body ? '| ' + data.body.slice(0, 200) : ''}`);

    const published = data.published || (item.dateText || '').replace(/^发布于\s*/, '') || '';
    data.published = published;
    data.title = data.title || item.title || '无标题';
    if (data.voteup == null && item.stats?.['赞同'] != null) data.voteup = Number(String(item.stats['赞同']).replace(/[^\d.]/g, '')) || 0;
    if (data.comments == null && item.stats?.['评论'] != null) data.comments = Number(String(item.stats['评论']).replace(/[^\d.]/g, '')) || 0;

    const imageResults = [];
    const successPaths = new Map();
    for (const img of data.images) {
      try {
        const r = await downloadImage(img.url, path.join(dir, 'images'), img.index);
        imageResults.push({ ...img, file: 'images/' + r.name, bytes: r.bytes, contentType: r.contentType, ok: true });
        successPaths.set(img.index, 'images/' + r.name);
        stats.images++;
      } catch (e) {
        imageResults.push({ ...img, ok: false, error: e.message });
        stats.imageFailed++;
        console.warn(`  image ${img.index} failed: ${e.message}`);
      }
    }

    let markdown = data.markdown;
    let contentHtml = data.contentHtml;
    for (const img of imageResults) {
      const alt = (img.alt || img.caption || '图片').replace(/\]/g, '\\]');
      const local = img.ok ? img.file : img.url;
      markdown = markdown.replaceAll(`{{IMG:${img.index}}}`, `![${alt}](${local})`);
      contentHtml = contentHtml.replaceAll(`__ZHIHU_IMG_${img.index}__`, local);
    }
    if (data.hasVideo) {
      markdown += `\n\n> 本条包含视频，视频文件未下载；请打开[知乎原文](${data.url})观看。\n`;
      contentHtml += `<p class="video-note">本条包含视频，视频文件未下载；<a href="${htmlEscape(data.url)}" target="_blank" rel="noopener noreferrer">打开知乎原文观看</a></p>`;
    }
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim() + '\n';

    const exportedAt = new Date().toISOString();
    const meta = {
      ok: true,
      type: data.type,
      id: data.id,
      title: data.title,
      url: data.url,
      question: data.question,
      questionId: data.questionId,
      author: data.author,
      authorUrl: data.authorUrl,
      published,
      location: data.location,
      hasVideo: !!data.hasVideo,
      voteup: data.voteup,
      comments: data.comments,
      imageCount: data.images.length,
      images: imageResults,
      listItem: item,
      exportedAt
    };

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(mdFile, frontMatter(data, meta) + markdown, 'utf8');
    await fs.writeFile(path.join(dir, 'content.html'), contentPage(data, { ...meta, contentHtml }), 'utf8');
    await fs.writeFile(path.join(dir, 'raw.html'), rawPage(data), 'utf8');
    await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8');

    stats.done++;
    if (stats.done % 5 === 0) {
      await fs.writeFile(path.join(outRoot, '_progress.json'), JSON.stringify({ ...stats, updatedAt: new Date().toISOString(), total: items.length }, null, 2), 'utf8');
    }
  } catch (e) {
    stats.failed++;
    errors.push({ type: item.type, id: item.id, title: item.title, url: item.url, error: e.message });
    console.error(`  FAILED: ${e.message}`);
    if (/登录状态已失效|安全验证|访问过于频繁|验证码/.test(e.message)) {
      fatal = e.message;
      break;
    }
  }
  await sleep(delayMs + Math.floor(Math.random() * 350));
}

await fs.writeFile(path.join(outRoot, '_progress.json'), JSON.stringify({ ...stats, updatedAt: new Date().toISOString(), total: items.length }, null, 2), 'utf8');
await fs.writeFile(path.join(outRoot, '_errors.json'), JSON.stringify(errors, null, 2), 'utf8');

// Build index from whatever is on disk, including previously exported items.
const records = [];
for (const type of typeFilter) {
  const folder = typeInfo[type].folder;
  const base = path.join(outRoot, folder);
  let ids = [];
  try { ids = await fs.readdir(base); } catch { continue; }
  for (const id of ids) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(base, id, 'meta.json'), 'utf8'));
      if (meta.ok) records.push(meta);
    } catch { /* skip incomplete */ }
  }
}
records.sort((a, b) => {
  const da = a.deletedFromZhihu ? 1 : 0;
  const db = b.deletedFromZhihu ? 1 : 0;
  if (da !== db) return da - db;
  return String(b.published || '').localeCompare(String(a.published || ''));
});
const deletedCount = records.filter((r) => r.deletedFromZhihu).length;

await fs.writeFile(path.join(outRoot, 'index.json'), JSON.stringify(records, null, 2), 'utf8');

const groupCounts = {};
for (const r of records) groupCounts[r.type] = (groupCounts[r.type] || 0) + 1;
const totalImages = records.reduce((n, r) => n + (r.images || []).filter((i) => i.ok).length, 0);
const totalImageFailed = records.reduce((n, r) => n + (r.images || []).filter((i) => !i.ok).length, 0);
const stamp = new Date().toLocaleString('zh-CN', { hour12: false });

const indexMd = [
  '# 知乎内容备份',
  '',
  `导出时间：${stamp}`,
  '',
  ...Object.entries(typeInfo).filter(([t]) => groupCounts[t]).map(([t, v]) => `- ${v.label}：${groupCounts[t]} 条`),
  '',
  ...Object.entries(typeInfo).filter(([t]) => groupCounts[t]).flatMap(([t, v]) => [
    `## ${v.label}`,
    '',
    ...records.filter((r) => r.type === t).map((r) =>
      `- [${r.title || '(无标题)'}](${v.folder}/${r.id}/${v.file}) — ${r.published || ''}${r.published ? ' · ' : ''}[原文](${r.url})${r.deletedFromZhihu ? ` — ⚠️ 已从知乎删除/不可见${r.deletedPreviouslyFolded ? '（原列表已标被折叠）' : ''}` : ''}`
    ),
    ''
  ])
].join('\n');
await fs.writeFile(path.join(outRoot, 'index.md'), indexMd, 'utf8');

const cards = records.map((r) => {
  const info = typeInfo[r.type];
  const excerpt = (r.listItem?.excerpt || '').slice(0, 130);
  const deleted = !!r.deletedFromZhihu;
  const deletedLabel = r.deletedPreviouslyFolded ? ' · 已折叠/不可见' : ' · 已删除';
  return `<a class="card${deleted ? ' deleted' : ''}" href="${info.folder}/${r.id}/content.html">
  <div class="badge${deleted ? ' badge-deleted' : ''}">${htmlEscape(info.label)}${deleted ? deletedLabel : ''}</div>
  <h3>${htmlEscape(r.title || '(无标题)')}</h3>
  <p>${htmlEscape(excerpt)}</p>
  <div class="foot">${htmlEscape(r.published || '')}${r.imageCount ? ` · ${r.imageCount} 张图片` : ''}${deleted ? ` · 已从知乎删除/不可见${r.deletedPreviouslyFolded ? '（原列表已标被折叠）' : ''}` : ''}</div>
</a>`;
}).join('\n');

const indexHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>知乎内容备份</title>
<style>
body{margin:0;background:#f5f5f5;color:#111;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
header{max-width:1100px;margin:0 auto;padding:38px 22px 10px}
h1{margin:0 0 6px;font-size:32px}
.sub{color:#666;font-size:14px}
.search{width:100%;max-width:460px;margin:20px 0 0;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:15px}
.grid{max-width:1100px;margin:0 auto;padding:22px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.card{display:block;background:#fff;border:1px solid #eee;border-radius:10px;padding:16px 18px;text-decoration:none;color:inherit;transition:.15s}
.card:hover{box-shadow:0 6px 22px rgba(0,0,0,.09);transform:translateY(-1px)}
.card.deleted{opacity:.72;border-style:dashed;background:#fffafa}
.badge{display:inline-block;background:#eef4ff;color:#056de8;border-radius:4px;padding:1px 7px;font-size:12px;margin-bottom:8px}
.badge-deleted{background:#fdecec;color:#c0392b}
.card h3{margin:0 0 8px;font-size:17px;line-height:1.45}
.card p{margin:0 0 10px;color:#666;font-size:13px;line-height:1.6;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.foot{color:#999;font-size:12px}
.empty{max-width:1100px;margin:0 auto;padding:20px 22px;color:#888}
</style>
</head>
<body>
<header>
<h1>知乎内容备份</h1>
<div class="sub">${stamp} · 共 ${records.length} 条${deletedCount ? ` · 其中 ${deletedCount} 条已从知乎删除/不可见` : ''} · ${totalImages} 张本地图片</div>
<input class="search" id="q" placeholder="搜索标题或摘要…">
</header>
<div class="grid" id="grid">${cards}</div>
<div class="empty" id="empty" style="display:none">没有匹配的内容</div>
<script>
const q=document.getElementById('q'), cards=[...document.querySelectorAll('.card')], empty=document.getElementById('empty');
q.addEventListener('input',()=>{const s=q.value.trim().toLowerCase();let n=0;for(const c of cards){const hit=!s||c.innerText.toLowerCase().includes(s);c.style.display=hit?'':'none';if(hit)n++;}empty.style.display=n?'none':'block';});
</script>
</body>
</html>`;
await fs.writeFile(path.join(outRoot, 'index.html'), indexHtml, 'utf8');

const readme = `# 知乎内容备份

这是通过本机 Chrome 会话导出的知乎个人内容备份。

## 统计

${Object.entries(typeInfo).filter(([t]) => groupCounts[t]).map(([t, v]) => `- ${v.label}：${groupCounts[t]} 条`).join('\n')}
${deletedCount ? `- 其中已从知乎删除/不可见：${deletedCount} 条（\`meta.json\` 中 \`deletedFromZhihu: true\`，目录内有 \`DELETED.md\`）` : ''}
- 图片：${totalImages} 张下载成功${totalImageFailed ? `，${totalImageFailed} 张失败` : ''}

## 使用

- 打开 \`index.html\`：卡片式索引，可按标题/摘要搜索。
- 打开 \`index.md\`：Markdown 版目录，可跳转到每条内容。
- 每条内容目录中包含：
  - \`answer.md\` / \`article.md\` / \`pin.md\`：正文（Markdown，图片为本地相对路径）
  - \`content.html\`：带样式的离线阅读版
  - \`raw.html\`：知乎原始正文 HTML
  - \`meta.json\`：标题、作者、发布时间、原文链接、图片清单等
  - \`images/\`：本地图片

## 说明

- 导出使用你已经登录的专用 Chrome 配置，导出过程不会上传账号信息。
- 仅备份本人创作内容，请遵守知乎协议，不要公开分发他人内容。
`;
await fs.writeFile(path.join(outRoot, 'README.md'), readme, 'utf8');

await cdp.closePage(targetId);
cdp.close();

console.log('\n=== summary ===');
console.log(JSON.stringify({ ...stats, total: items.length, fatal, errors: errors.length, records: records.length }, null, 2));
if (fatal) console.error(`STOPPED: ${fatal}`);
if (errors.length) console.error(`errors saved to ${path.join(outRoot, '_errors.json')}`);
