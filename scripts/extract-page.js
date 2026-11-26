((doc, pageUrl) => {
  const document = doc;
  const location = new URL(pageUrl || doc.URL || 'https://www.zhihu.com/');
  const clean = (s) => (s || '').replace(/\u200b/g, '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const textOf = (el) => {
    if (!el) return '';
    const inner = el.innerText;
    if (inner && inner.trim() && !/\.css-[\w-]+\s*\{/.test(inner)) return inner.replace(/\u200b/g, '');
    const copy = el.cloneNode(true);
    copy.querySelectorAll('style, script, svg, noscript').forEach((n) => n.remove());
    return (copy.textContent || '').replace(/\u200b/g, '');
  };
  const abs = (u) => {
    try { return new URL(u, location.href).href; } catch { return u || ''; }
  };
  const parseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };

  const path = location.pathname;
  let type = null;
  let id = null;
  let m = null;
  if ((m = path.match(/\/answer\/(\d+)/))) { type = 'answer'; id = m[1]; }
  else if ((m = path.match(/\/pin\/(\d+)/))) { type = 'pin'; id = m[1]; }
  else if ((m = path.match(/\/p\/(\d+)/))) { type = 'article'; id = m[1]; }
  if (!type) return { ok: false, error: 'unknown page type', url: location.href, title: document.title };

  const zopOf = (e) => parseJSON(e?.getAttribute('data-zop') || '');
  let root = null;
  let rich = null;

  if (type === 'answer') {
    const items = [...document.querySelectorAll('.AnswerItem')];
    root = items.find((e) => zopOf(e)?.itemId === id)
      || items.find((e) => e.getAttribute('name') === id)
      || items[0] || null;
    rich = root?.querySelector('.RichText[itemprop="text"]') || root?.querySelector('.RichText') || null;
  } else if (type === 'pin') {
    const items = [...document.querySelectorAll('.PinItem')];
    root = items.find((e) => zopOf(e)?.itemId === id) || items[0] || null;
    rich = root?.querySelector('.PinItem-content .RichText')
      || root?.querySelector('.RichText[itemprop="text"]')
      || root?.querySelector('.RichText')
      || document.querySelector('.PinItem-content .RichText')
      || null;
  } else {
    rich = document.querySelector('.Post-RichText')
      || document.querySelector('article .RichText')
      || document.querySelector('.RichText[itemprop="text"]')
      || null;
    root = rich?.closest('article') || rich?.parentElement || null;
  }

  if (!rich) {
    return {
      ok: false,
      error: 'content not found',
      type, id,
      url: location.href,
      title: document.title,
      body: textOf(document.body).slice(0, 500)
    };
  }

  const zop = zopOf(root) || {};
  const rawHtml = rich.innerHTML;
  const rootText = (textOf(root) || textOf(rich) || '').replace(/\u200b/g, '');
  const timeText = textOf(root?.querySelector('.ContentItem-time')) || rootText;
  const timeMatch = timeText.match(/(?:发布于|编辑于)\s*([0-9]{4}-[0-9]{2}-[0-9]{2}(?:\s+[0-9]{2}:[0-9]{2})?)/);
  const published = timeMatch ? timeMatch[1].replace(/\s+/g, ' ') : null;
  const locMatch = timeText.match(/[・·]\s*(?:IP\s*属地\s*)?([^\s・·|]{1,12})/)
    || rootText.match(/[・·]\s*(?:IP\s*属地\s*)?([^\s・·|]{1,12})/);
  const locationText = locMatch && /[\u4e00-\u9fa5]/.test(locMatch[1]) ? clean(locMatch[1]) : null;

  const extra = parseJSON(root?.getAttribute('data-za-extra-module') || '') || {};
  const extraContent = extra.card?.content || {};
  const voteText = clean(textOf(root?.querySelector('.VoteButton--up'))).replace(/[^\d]/g, '');
  const voteup = extraContent.upvote_num ?? (voteText ? Number(voteText) : null);
  const comments = extraContent.comment_num ?? null;

  let title = '';
  if (type === 'answer') title = clean(zop.title || textOf(document.querySelector('h1')) || document.title);
  else if (type === 'article') title = clean(textOf(document.querySelector('.Post-Title')) || textOf(document.querySelector('h1')) || document.title);
  else {
    const leading = [...rich.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.nodeValue || '')
      .join(' ');
    const first = clean(
      [leading, rich.querySelector('p')?.textContent || ''].filter(Boolean).join(' ')
    )
      || (textOf(rich) || '').split('\n').map(clean).find(Boolean)
      || '';
    const parts = first.split('|').map(clean).filter(Boolean);
    const left = parts[0] || '';
    const right = parts.slice(1).join(' | ');
    if (right && !right.startsWith('#') && (left.startsWith('#') || left.length <= 12)) {
      title = right.slice(0, 60);
    } else {
      title = left.slice(0, 60);
      if (!right) {
        const stripped = left.replace(/^#[^\s#]+\s+/, '').trim();
        if (stripped) title = stripped.slice(0, 60);
      }
    }
    if (!title) title = '想法 ' + (published || '').slice(0, 10);
  }

  const author = clean(
    textOf(root?.querySelector('.AuthorInfo-name'))
    || zop.authorName
    || textOf(document.querySelector('.AuthorInfo-name'))
    || ''
  );
  const hasVideo = !!root?.querySelector('.VideoAnswerPlayer, video, [class*="VideoAnswer"]');
  const authorUrl = abs(
    root?.querySelector('.AuthorInfo-name a')?.getAttribute('href')
    || document.querySelector('.AuthorInfo-name a')?.getAttribute('href')
    || ''
  );

  const clone = rich.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, svg, button, .RichContent-EntityWord svg, .ContentItem-actions, .RichContent-actions, .RichText-actions').forEach((e) => e.remove());

  const images = [];
  const imageIndex = new Map();
  const formula = (tex) => {
    const t = clean(tex);
    if (!t) return null;
    return t.includes('\\begin') || t.includes('\n') ? `$$${t}$$` : `$${t}$`;
  };

  for (const img of [...clone.querySelectorAll('img')]) {
    const src = abs(img.getAttribute('data-original') || img.getAttribute('data-actualsrc') || img.getAttribute('src') || '');
    const isFormula = /\/equation\?/.test(src) || img.classList.contains('ztext-math') || img.hasAttribute('data-tex');
    if (isFormula) {
      let tex = img.getAttribute('data-tex') || img.getAttribute('alt') || '';
      if (!tex) {
        try { tex = new URL(src).searchParams.get('tex') || ''; } catch { /* ignore */ }
      }
      const f = formula(tex);
      if (f) {
        const span = document.createElement('span');
        span.className = 'ztext-math';
        span.setAttribute('data-tex', tex);
        span.textContent = f;
        img.replaceWith(span);
      } else {
        img.remove();
      }
      continue;
    }
    if (!src || src.startsWith('data:')) { img.remove(); continue; }
    let idx = imageIndex.get(src);
    if (idx == null) {
      idx = images.length;
      imageIndex.set(src, idx);
      const fig = img.closest('figure');
      images.push({
        index: idx,
        url: src,
        alt: clean(img.getAttribute('alt') || ''),
        caption: clean(textOf(fig?.querySelector('figcaption')))
      });
    }
    img.setAttribute('src', `__ZHIHU_IMG_${idx}__`);
    img.setAttribute('alt', images[idx].alt || images[idx].caption || '');
    img.removeAttribute('srcset');
    img.removeAttribute('data-original');
    img.removeAttribute('data-actualsrc');
    img.removeAttribute('data-default');
    img.removeAttribute('data-lazy-status');
    img.removeAttribute('data-original-token');
    img.classList.remove('lazy');
  }

  const blockTags = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'figure', 'figcaption', 'table', 'ul', 'ol', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']);
  const skipTags = new Set(['script', 'style', 'noscript', 'svg', 'button', 'input', 'textarea', 'select', 'canvas']);

  const escapePipe = (s) => (s || '').replace(/\|/g, '\\|');

  function convertChildren(node, ctx = {}) {
    let out = '';
    for (const child of node.childNodes) out += convertNode(child, ctx);
    return out;
  }

  function convertList(node, ordered, depth) {
    let out = '';
    let n = 1;
    for (const li of node.children) {
      if (li.tagName?.toLowerCase() !== 'li') continue;
      let content = convertChildren(li, { list: true, depth }).trim();
      content = content.replace(/\n{3,}/g, '\n\n');
      const lines = content.split('\n');
      const prefix = (ordered ? `${n}. ` : '- ');
      const indent = '  '.repeat(depth);
      out += indent + prefix + (lines[0] || '') + '\n';
      for (const line of lines.slice(1)) out += indent + '  ' + line + '\n';
      n++;
    }
    return out + '\n';
  }

  function convertTable(node) {
    const rows = [...node.querySelectorAll('tr')];
    if (!rows.length) return convertChildren(node);
    const grid = rows.map((tr) => [...tr.querySelectorAll('th,td')].map((td) => clean(convertChildren(td)).replace(/\n+/g, ' ')));
    const width = Math.max(...grid.map((r) => r.length));
    const line = (r) => '| ' + Array.from({ length: width }, (_, i) => escapePipe(r[i] || '')).join(' | ') + ' |';
    const out = [line(grid[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...grid.slice(1).map(line)];
    return '\n' + out.join('\n') + '\n\n';
  }

  function convertNode(node, ctx = {}) {
    if (node.nodeType === 3) {
      const raw = node.nodeValue || '';
      if (ctx.pre) return raw;
      return raw.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (skipTags.has(tag)) return '';
    if (node.classList?.contains('ztext-math')) {
      return formula(node.getAttribute('data-tex') || node.textContent || '') || clean(node.textContent);
    }

    switch (tag) {
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';
      case 'p': {
        const c = convertChildren(node, ctx).trim();
        return c ? c + '\n\n' : '';
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = Number(tag[1]);
        const c = clean(convertChildren(node, ctx));
        return c ? '#'.repeat(level) + ' ' + c + '\n\n' : '';
      }
      case 'strong': case 'b': {
        const c = convertChildren(node, ctx);
        return c.trim() ? `**${c.trim()}**` : '';
      }
      case 'em': case 'i': {
        const c = convertChildren(node, ctx);
        return c.trim() ? `*${c.trim()}*` : '';
      }
      case 'del': case 's': case 'strike': {
        const c = convertChildren(node, ctx);
        return c.trim() ? `~~${c.trim()}~~` : '';
      }
      case 'code': {
        if (ctx.pre) return node.textContent || '';
        const c = node.textContent || '';
        if (!c) return '';
        const ticks = c.includes('`') ? '``' : '`';
        return ticks + c + ticks;
      }
      case 'pre': {
        const codeEl = node.querySelector('code');
        const source = (codeEl || node).textContent || '';
        const cls = (codeEl?.className || node.className || '') + '';
        const lang = (cls.match(/language-([\w+-]+)/) || [])[1] || node.getAttribute('data-lang') || '';
        const fence = source.includes('```') ? '````' : '```';
        return `\n${fence}${lang}\n${source.replace(/\n$/, '')}\n${fence}\n\n`;
      }
      case 'blockquote': {
        const c = convertChildren(node, ctx).trim();
        if (!c) return '';
        return c.split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      }
      case 'ul': return convertList(node, false, ctx.depth || 0);
      case 'ol': return convertList(node, true, ctx.depth || 0);
      case 'li': return convertChildren(node, ctx);
      case 'a': {
        const href = abs(node.getAttribute('href') || '');
        const c = convertChildren(node, ctx).trim();
        if (!href || !c) return c;
        if (/zhida\.zhihu\.com\/search/.test(href)) return c;
        if (href.includes('link.zhihu.com/?target=')) {
          try { return `[${c}](${decodeURIComponent(new URL(href).searchParams.get('target') || href)})`; } catch { /* ignore */ }
        }
        return `[${c}](${href})`;
      }
      case 'img': {
        const src = node.getAttribute('src') || '';
        if (/^__ZHIHU_IMG_\d+__$/.test(src)) return `\n\n{{IMG:${src.match(/\d+/)[0]}}}\n\n`;
        return '';
      }
      case 'figure': {
        const c = convertChildren(node, ctx).trim();
        const cap = clean(textOf(node.querySelector('figcaption')));
        return (c ? c + '\n\n' : '') + (cap ? `*${cap}*\n\n` : '');
      }
      case 'figcaption': return '';
      case 'table': return convertTable(node);
      case 'video': {
        const src = abs(node.getAttribute('src') || node.querySelector('source')?.getAttribute('src') || '');
        return src ? `\n\n[视频](${src})\n\n` : '';
      }
      case 'iframe': {
        const src = abs(node.getAttribute('src') || '');
        return src ? `\n\n[嵌入内容](${src})\n\n` : '';
      }
      case 'sup': return `<sup>${convertChildren(node, ctx)}</sup>`;
      case 'sub': return `<sub>${convertChildren(node, ctx)}</sub>`;
      case 'div': case 'section': case 'article': case 'header': case 'footer': {
        const c = convertChildren(node, ctx);
        return blockTags.has(tag) ? c + '\n' : c;
      }
      default:
        return convertChildren(node, ctx);
    }
  }

  let markdown = convertChildren(clone).trim();
  markdown = markdown.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // Clean HTML for offline reading: drop site-only attributes, keep structure.
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const n = attr.name;
      if (/^on/i.test(n) || n.startsWith('data-za-') || n === 'contenteditable' || n === 'spellcheck' || n === 'data-pid' || n === 'data-first-child') {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'IMG') {
      el.removeAttribute('width');
      el.removeAttribute('height');
      el.removeAttribute('style');
    }
    if (el !== clone) {
      const cls = el.getAttribute('class') || '';
      if (!/ztext-math|language-|highlight/.test(cls)) el.removeAttribute('class');
      el.removeAttribute('style');
    }
  }

  const contentHtml = clone.innerHTML.trim();

  return {
    ok: true,
    type, id,
    url: location.href,
    title,
    question: type === 'answer' ? clean(zop.title || '') : '',
    questionId: (path.match(/\/question\/(\d+)/) || [])[1] || null,
    author,
    authorUrl,
    published,
    location: locationText,
    hasVideo,
    voteup,
    comments,
    images,
    markdown,
    contentHtml,
    rawHtml,
    warnings: []
  };
})
