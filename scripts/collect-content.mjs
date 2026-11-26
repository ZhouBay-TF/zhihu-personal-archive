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
const types = (getArg('types', 'answer,article,pin') || '').split(',').filter(Boolean);
const outDir = path.resolve(getArg('out', path.join(ROOT, 'archive')));
const listsDir = path.resolve(getArg('lists', path.join(outDir, '_lists')));
await fs.mkdir(listsDir, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function normalize(type, entry) {
  const d = entry?.data || {};
  const id = String(d.id || d.url_token || '');
  if (!id) return null;
  const created = Number(d.created_time) ? Number(d.created_time) * 1000 : null;
  const url = type === 'answer'
    ? `https://www.zhihu.com/answer/${id}`
    : type === 'article'
      ? `https://zhuanlan.zhihu.com/p/${id}`
      : `https://www.zhihu.com/pin/${id}`;
  let title = d.title || '';
  let excerpt = d.excerpt || '';
  if (type === 'pin') {
    const blocks = Array.isArray(d.content) ? d.content : [];
    title = blocks
      .map((b) => b.title || b.content || b.own_text || '')
      .filter(Boolean)
      .join('\n\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || excerpt || `想法 ${id}`;
    excerpt = '';
  }
  const reaction = entry.reaction || {};
  return {
    type,
    id,
    url,
    editUrl: type === 'pin' ? null : `${url}#write`,
    title: clean(title),
    excerpt: clean(excerpt),
    dateText: created ? `发布于 ${fmtDate(created)}` : null,
    createdTime: created,
    stats: type === 'pin'
      ? {
        被浏览: reaction.view_count ?? reaction.read_count ?? 0,
        赞同: reaction.vote_up_count ?? 0,
        喜欢: reaction.like_count ?? 0,
        评论: reaction.comment_count ?? 0,
        转发: reaction.repin_count ?? 0,
      }
      : {
        阅读: reaction.read_count ?? 0,
        赞同: reaction.vote_up_count ?? 0,
        评论: reaction.comment_count ?? 0,
        收藏: reaction.collect_count ?? 0,
        喜欢: reaction.like_count ?? 0,
      },
  };
}

const cdp = await CDP.connect(port);
const pages = await cdp.listPages();
let page = pages.find((p) => p.type === 'page' && p.url.includes('zhihu.com/creator'))
  || pages.find((p) => p.type === 'page' && p.url.includes('zhihu.com'));
if (!page) {
  console.error('没有找到知乎页面。请先运行 node scripts/launch-chrome.mjs 并登录。');
  process.exit(2);
}
const sessionId = await cdp.attach(page.id);

const all = {};
for (const type of types) {
  console.log(`\n=== ${type} ===`);
  const seen = new Map();
  let total = null;
  let offset = 0;
  for (let round = 0; round < 50; round++) {
    const url = `https://www.zhihu.com/api/v4/creators/creations/v2/${type}?limit=20&offset=${offset}&need_co_creation=1&sort_type=created`;
    const r = await cdp.eval(`(async () => {
      const res = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { accept: 'application/json' } });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { return { __status: res.status, __error: 'not json', __text: text.slice(0, 300) }; }
      return { __status: res.status, json };
    })()`, sessionId, { timeoutMs: 60000 });
    if (r?.__error) throw new Error(`${type} HTTP ${r.__status}: ${r.__error} ${r.__text || ''}`);
    if (r?.__status === 401 || r?.__status === 403) throw new Error(`${type} HTTP ${r.__status}：登录状态可能失效`);
    const arr = Array.isArray(r.json?.data) ? r.json.data : [];
    total = r.json?.paging?.totals ?? total;
    for (const entry of arr) {
      const item = normalize(type, entry);
      if (item && !seen.has(item.id)) seen.set(item.id, item);
    }
    console.log(`offset=${offset} got=${arr.length} unique=${seen.size}${total != null ? '/' + total : ''}`);
    if (!arr.length || r.json?.paging?.is_end) break;
    if (total != null && seen.size >= total) break;
    offset += 20;
    await sleep(300);
  }
  const items = [...seen.values()];
  all[type] = { total, items };
  await fs.writeFile(path.join(listsDir, `${type}.json`), JSON.stringify({ type, total, collectedAt: new Date().toISOString(), items }, null, 2), 'utf8');
  console.log(`saved ${items.length} ${type} -> ${path.join(listsDir, `${type}.json`)}`);
}
await fs.writeFile(path.join(listsDir, 'all-content.json'), JSON.stringify({
  collectedAt: new Date().toISOString(),
  counts: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.items.length])),
  lists: all,
}, null, 2), 'utf8');
cdp.close();
console.log('\n完成。内容清单在：' + listsDir);
