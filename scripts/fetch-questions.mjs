import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, sleep } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const OUT = path.resolve(outArg || path.join(ROOT, 'archive', 'questions'));
const TZ = 'Asia/Shanghai';
const NOW = Date.now();
const INVITE_URL = 'https://www.zhihu.com/api/v4/notifications/v3/timeline/entry/invite?invite_with_time_slice=1&limit=20&offset=0&invite_domain_score_ab=1';
const RECOMMEND_URL = 'https://www.zhihu.com/api/v4/creators/question_route/author_related/recommend?limit=30&offset=0&page_source=web_author_recommend&recom_domain_score_ab=1';

const dtf = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const fmt = (ms) => dtf.format(new Date(ms)).replaceAll('/', '-');
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const stripHtml = (s) => String(s ?? '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const mdText = (s) => String(s ?? '').replace(/([\[\]])/g, '\\$1').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const mdLink = (title, url) => `[${mdText(title)}](${url})`;
const truncate = (s, n) => {
  const t = clean(s);
  return t.length > n ? `${t.slice(0, n).replace(/[，。；、\s]+$/, '')}…` : t;
};
const ageText = (ms) => {
  const h = Math.max(0, (NOW - ms) / 3600000);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分钟前`;
  if (h < 48) return `${Math.round(h * 10) / 10} 小时前`;
  return `${Math.round(h / 24)} 天前`;
};
function tokenNumber(token) {
  if (token == null) return null;
  const m = String(token).replace(/,/g, '').match(/([\d.]+)\s*(万|亿)?/);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2] === '万') n *= 1e4;
  if (m[2] === '亿') n *= 1e8;
  return Math.round(n);
}
function parseCounts(text) {
  const s = String(text || '');
  const answers = /([\d.]+(?:万|亿)?)\s*回答/.exec(s);
  const followers = /([\d.]+(?:万|亿)?)\s*关注/.exec(s);
  const visits = /([\d.]+(?:万|亿)?)\s*浏览/.exec(s);
  return {
    answerCount: answers ? tokenNumber(answers[1]) : null,
    followerCount: followers ? tokenNumber(followers[1]) : null,
    visitCount: visits ? tokenNumber(visits[1]) : null,
  };
}
function questionUrl(q, id) {
  return q?.url && /\/question\//.test(q.url) ? q.url : `https://www.zhihu.com/question/${id}`;
}

await fs.mkdir(OUT, { recursive: true });
const cdp = await CDP.connect(9222);
const pages = await cdp.listPages();
const page = pages.find((p) => p.type === 'page' && p.url.includes('zhihu.com'));
if (!page) throw new Error('没有找到已登录的知乎页面，请先打开专用 Chrome。');
const sessionId = await cdp.attach(page.id);

const fetchJson = async (url) => {
  const r = await cdp.eval(`(async () => {
    const res = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { return { __status: res.status, __error: 'not json', __text: text.slice(0, 300) }; }
    return { __status: res.status, data };
  })()`, sessionId, { timeoutMs: 60000 });
  if (r?.__error) throw new Error(`${url} -> ${r.__status}: ${r.__error} ${r.__text || ''}`);
  if (r?.__status === 401 || r?.__status === 403) throw new Error(`${url} -> HTTP ${r.__status}，登录状态可能失效`);
  return r;
};

// 邀请：不设 48 小时上限，取最新 30 条
const invites = [];
const inviteSeen = new Set();
let inviteUrl = INVITE_URL;
for (let i = 0; i < 6 && invites.length < 30; i++) {
  const r = await fetchJson(inviteUrl);
  const j = r.data;
  const arr = Array.isArray(j?.data) ? j.data : [];
  if (!arr.length) break;
  for (const d of arr) {
    if (!d || inviteSeen.has(d.id)) continue;
    inviteSeen.add(d.id);
    if (d.content?.is_deleted || d.target?.is_deleted) continue;
    const target = d.target || {};
    const counts = parseCounts(d.target_source?.sub_text || '');
    const qid = String(target.id || (d.content?.target_link || '').match(/question\/(\d+)/)?.[1] || '');
    const createdMs = Number(d.created) * 1000;
    invites.push({
      inviteId: d.id,
      inviteCreated: createdMs,
      inviteTime: fmt(createdMs),
      age: ageText(createdMs),
      inviter: clean(d.content?.title || ''),
      action: clean(d.content?.sub_title || ''),
      questionId: qid,
      title: clean(d.content?.text || target.title || d.target_source?.text || ''),
      url: d.content?.target_link || questionUrl(target, qid),
      answerCount: counts.answerCount,
      followerCount: counts.followerCount ?? (Number.isFinite(target.follow_num) ? target.follow_num : null),
      questionCreated: Number(target.created) ? Number(target.created) * 1000 : null,
      statsText: clean(d.target_source?.sub_text || ''),
      excerpt: truncate(target.excerpt || '', 300),
    });
    if (invites.length >= 30) break;
  }
  const next = j?.paging?.next;
  if (!next || next === inviteUrl) break;
  inviteUrl = next;
  await sleep(650);
}
invites.sort((a, b) => b.inviteCreated - a.inviteCreated);
invites.splice(30);

// 推荐：取前 30
const recommend = [];
const recommendSeen = new Set();
let recommendUrl = RECOMMEND_URL;
for (let i = 0; i < 3 && recommend.length < 30; i++) {
  const r = await fetchJson(recommendUrl);
  const j = r.data;
  const arr = Array.isArray(j?.data) ? j.data : [];
  if (!arr.length) break;
  for (const d of arr) {
    const q = d?.question;
    if (!q || q.is_deleted) continue;
    const id = String(q.id || q.id_str || '');
    if (!id || recommendSeen.has(id)) continue;
    recommendSeen.add(id);
    recommend.push({
      id,
      title: clean(q.title || ''),
      url: questionUrl(q, id),
      reason: stripHtml(d.reason || ''),
      reasonType: d.reason_type || '',
      answerCount: Number.isFinite(q.answer_count) ? q.answer_count : null,
      visitCount: Number.isFinite(q.visit_count) ? q.visit_count : null,
      followerCount: Number.isFinite(q.follower_count) ? q.follower_count : null,
      questionCreated: Number(q.created) ? Number(q.created) * 1000 : null,
      questionType: q.question_type || '',
      author: clean(q.author?.name || ''),
      excerpt: truncate(q.excerpt || stripHtml(q.detail || ''), 300),
    });
    if (recommend.length >= 30) break;
  }
  const next = j?.paging?.next;
  if (!next || next === recommendUrl) break;
  recommendUrl = next;
  await sleep(650);
}
recommend.splice(30);

const meta = {
  exportedAt: new Date(NOW).toISOString(),
  exportedAtLocal: fmt(NOW),
  timezone: TZ,
  counts: { invites: invites.length, recommend: recommend.length },
};
const writeJson = async (name, data) => fs.writeFile(path.join(OUT, name), JSON.stringify(data, null, 2), 'utf8');

await writeJson('invites-30.json', { meta, items: invites });
await writeJson('recommend-30.json', { meta, items: recommend });
await writeJson('all-30.json', { meta, invites, recommend });

const inviteMd = [
  '# 邀请回答（最新 30 条）',
  '',
  `- 采集时间：${meta.exportedAtLocal}（${TZ}）`,
  `- 共 ${invites.length} 条；不限于 48 小时，按邀请时间从新到旧`,
  '',
  '| # | 问题 | 回答 | 关注 | 邀请人 | 邀请时间 |',
  '|---:|---|---:|---:|---|---|',
  ...invites.map((x, i) => `| ${i + 1} | ${mdLink(x.title, x.url)} | ${x.answerCount ?? '—'} | ${x.followerCount ?? '—'} | ${mdText(x.inviter || '—')} | ${x.inviteTime}（${x.age}） |`),
  '',
].join('\n');
const recommendMd = [
  '# 推荐问题（前 30 条）',
  '',
  `- 采集时间：${meta.exportedAtLocal}（${TZ}）`,
  `- 共 ${recommend.length} 条，保留推荐流顺序`,
  '',
  '| # | 问题 | 浏览 | 回答 | 关注 | 推荐理由 |',
  '|---:|---|---:|---:|---:|---|',
  ...recommend.map((x, i) => `| ${i + 1} | ${mdLink(x.title, x.url)} | ${x.visitCount?.toLocaleString('en-US') ?? '—'} | ${x.answerCount ?? '—'} | ${x.followerCount ?? '—'} | ${mdText(x.reason || '—')} |`),
  '',
].join('\n');
const allMd = [
  '# 今日问题（邀请 30 + 推荐 30）',
  '',
  `- 采集时间：${meta.exportedAtLocal}（${TZ}）`,
  `- 邀请：${invites.length} 条；推荐：${recommend.length} 条`,
  '',
  inviteMd.split('\n').slice(4).join('\n'),
  '',
  recommendMd.split('\n').slice(4).join('\n'),
  '',
].join('\n');

await fs.writeFile(path.join(OUT, 'invites-30.md'), inviteMd, 'utf8');
await fs.writeFile(path.join(OUT, 'recommend-30.md'), recommendMd, 'utf8');
await fs.writeFile(path.join(OUT, 'all-30.md'), allMd, 'utf8');
await fs.writeFile(path.join(OUT, 'README.md'), [
  '# 邀请 30 / 推荐 30',
  '',
  `最后采集：${meta.exportedAtLocal}`,
  '',
  '- `invites-30.md` / `.json`：最新 30 条邀请（不限 48 小时）',
  '- `recommend-30.md` / `.json`：推荐流前 30 条',
  '- `all-30.md` / `.json`：合并版',
  '',
].join('\n'), 'utf8');

cdp.close();
console.log(JSON.stringify({ out: OUT, counts: meta.counts, firstInvite: invites[0]?.title, firstRecommend: recommend[0]?.title }, null, 2));
