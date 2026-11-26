import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [m[1], m[2]] : [a, ''];
}));

const OUT_DIR = path.resolve(args.out || path.join(ROOT, 'archive', 'hot'));
const TZ = 'Asia/Shanghai';
const NOW = Date.now();
const API = 'https://api.zhihu.com/topstory/hot-lists/total?limit=50';

const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const fmtDateTime = (ms) => dateTimeFmt.format(new Date(ms)).replaceAll('/', '-');
const fmtDate = (ms) => dateFmt.format(new Date(ms)).replaceAll('/', '-');
const today = fmtDate(NOW);

const clean = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const mdText = (s) => String(s ?? '').replace(/([\[\]])/g, '\\$1').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const mdLink = (title, url) => `[${mdText(title)}](${url})`;

function parseHeat(text) {
  const s = String(text || '').replace(/,/g, '');
  const m = /([\d.]+)\s*(万|亿)?/.exec(s);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2] === '万') n *= 1e4;
  if (m[2] === '亿') n *= 1e8;
  return Math.round(n);
}

function fmtDelta(n) {
  if (!Number.isFinite(n)) return '—';
  return n > 0 ? `+${n}` : String(n);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`不是 JSON: ${text.slice(0, 200)}`);
  }
}

function normalize(j) {
  return (j.data || []).map((x, i) => {
    const t = x.target || {};
    const cardId = String(x.card_id || '');
    const qid = cardId.replace(/^Q_/, '') || (String(t.url || '').match(/questions\/(\d+)/) || [])[1] || '';
    return {
      rank: i + 1,
      questionId: qid,
      title: clean(t.title || ''),
      url: qid ? `https://www.zhihu.com/question/${qid}` : '',
      heatText: clean(x.detail_text || t.detail_text || ''),
      heatValue: parseHeat(x.detail_text || t.detail_text || ''),
      excerpt: clean(t.excerpt || ''),
      answerCount: Number.isFinite(t.answer_count) ? t.answer_count : null,
      followerCount: Number.isFinite(t.follower_count) ? t.follower_count : null,
      questionCreated: Number(t.created) ? Number(t.created) * 1000 : null,
      trend: x.trend ?? null,
      debut: !!x.debut,
      cardId,
    };
  }).filter((x) => x.title && x.url);
}

async function loadPrevious() {
  try {
    const names = (await fs.readdir(OUT_DIR)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
    const prior = names.filter((n) => n.slice(0, 10) < today).sort().at(-1);
    if (!prior) return null;
    const data = JSON.parse(await fs.readFile(path.join(OUT_DIR, prior), 'utf8'));
    return { file: prior, date: prior.slice(0, 10), data };
  } catch {
    return null;
  }
}

function compare(items, previous) {
  if (!previous) return { previousDate: '', matched: 0, newItems: [], missing: [], changes: [] };
  const map = new Map(previous.data.items.map((x) => [x.questionId, x]));
  const current = new Set(items.map((x) => x.questionId));
  const changes = [];
  for (const x of items) {
    const p = map.get(x.questionId);
    if (!p) continue;
    x.previous = {
      rank: p.rank,
      heatValue: p.heatValue,
      answerCount: p.answerCount,
      followerCount: p.followerCount,
    };
    x.delta = {
      rank: p.rank - x.rank,
      heatValue: Number.isFinite(p.heatValue) && Number.isFinite(x.heatValue) ? x.heatValue - p.heatValue : null,
      answerCount: Number.isFinite(p.answerCount) && Number.isFinite(x.answerCount) ? x.answerCount - p.answerCount : null,
      followerCount: Number.isFinite(p.followerCount) && Number.isFinite(x.followerCount) ? x.followerCount - p.followerCount : null,
    };
    changes.push(x);
  }
  return {
    previousDate: previous.date,
    previousFile: previous.file,
    matched: changes.length,
    newItems: items.filter((x) => !map.has(x.questionId)),
    missing: previous.data.items.filter((x) => !current.has(x.questionId)),
    changes,
  };
}

function render(items, meta, cmp) {
  const lines = [
    `# 知乎热榜 ${meta.date}`,
    '',
    `- 采集时间：${meta.collectedAt}（${TZ}）`,
    `- 共 ${items.length} 条，匿名接口采集，不登录、不带 Cookie`,
    `- 接口：\`${API}\``,
    '',
    '## 榜单',
    '',
    '| # | 问题 | 热度 | 回答 | 关注 | 排名变化 |',
    '|---:|---|---:|---:|---:|---:|',
  ];
  for (const x of items) {
    const rankDelta = x.delta ? (x.delta.rank > 0 ? `↑${x.delta.rank}` : x.delta.rank < 0 ? `↓${-x.delta.rank}` : '—') : '—';
    lines.push(`| ${x.rank} | ${mdLink(x.title, x.url)} | ${x.heatText || '—'} | ${x.answerCount ?? '—'} | ${x.followerCount ?? '—'} | ${rankDelta} |`);
  }
  lines.push('', '## 与上一份热榜对比', '');
  if (!cmp.previousDate) {
    lines.push('这是第一份热榜快照，暂无历史可比较。');
  } else {
    lines.push(`上一份：${cmp.previousDate}；同问题匹配 ${cmp.matched} 条，新上榜 ${cmp.newItems.length} 条，跌出 ${cmp.missing.length} 条。`, '');
    const changed = cmp.changes.filter((x) => x.delta.answerCount || x.delta.rank).sort((a, b) => Math.abs(b.delta.answerCount || 0) - Math.abs(a.delta.answerCount || 0)).slice(0, 20);
    if (changed.length) {
      lines.push('| 问题 | 排名（前 → 今） | 回答增量 | 热度变化 |', '|---|---:|---:|---:|');
      for (const x of changed) {
        lines.push(`| ${mdLink(x.title, x.url)} | ${x.previous.rank} → ${x.rank} | ${fmtDelta(x.delta.answerCount)} | ${fmtDelta(x.delta.heatValue)} |`);
      }
    } else {
      lines.push('没有可比较的数量变化。');
    }
    if (cmp.newItems.length) {
      lines.push('', '### 新上榜', '');
      for (const x of cmp.newItems) lines.push(`- ${mdLink(x.title, x.url)}（第 ${x.rank} 名，${x.heatText || '—'}）`);
    }
    if (cmp.missing.length) {
      lines.push('', '### 跌出榜单', '');
      for (const x of cmp.missing) lines.push(`- ${mdLink(x.title, x.url)}（上次第 ${x.rank} 名）`);
    }
  }
  lines.push('', '## 备注', '', '- 热榜是采集时快照，排名和热度会快速变化。', '- 该接口为公开 App 接口，不需要登录；仍建议每天只请求一次，避免频繁访问。', '');
  return lines.join('\n').trim() + '\n';
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const raw = await fetchJson(API);
  const items = normalize(raw);
  if (!items.length) throw new Error('热榜接口返回空数据');
  const previous = await loadPrevious();
  const cmp = compare(items, previous);
  const meta = {
    date: today,
    collectedAt: fmtDateTime(NOW),
    timezone: TZ,
    count: items.length,
    source: API,
    previousDate: cmp.previousDate || '',
    matched: cmp.matched,
    newCount: cmp.newItems.length,
    missingCount: cmp.missing.length,
  };
  const jsonPath = path.join(OUT_DIR, `${today}.json`);
  const mdPath = path.join(OUT_DIR, `${today}.md`);
  const rawPath = path.join(OUT_DIR, `${today}.raw.json`);
  await fs.writeFile(rawPath, JSON.stringify(raw, null, 2), 'utf8');
  await fs.writeFile(jsonPath, JSON.stringify({ meta, items }, null, 2), 'utf8');
  await fs.writeFile(mdPath, render(items, meta, cmp), 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'README.md'), [
    '# 知乎每日热榜',
    '',
    '匿名公开接口采集，不登录、不带 Cookie、不使用 Chrome。',
    '',
    '```powershell',
    'node ./scripts/fetch-hot.mjs',
    '```',
    '',
    '- 每天只请求一次；接口失败就跳过，不连续重试。',
    '- `YYYY-MM-DD.json`：结构化数据',
    '- `YYYY-MM-DD.md`：可读榜单',
    '- `YYYY-MM-DD.raw.json`：接口原始返回',
    '',
  ].join('\n'), 'utf8');
  console.log(JSON.stringify(meta, null, 2));
  console.log(`written to ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e.stack || e.message || String(e));
  process.exitCode = 1;
});
