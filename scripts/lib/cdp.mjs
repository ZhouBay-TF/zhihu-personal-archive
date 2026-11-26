// Minimal Chrome DevTools Protocol client. No third-party dependencies.
// Requires Node.js 22+ (global WebSocket + fetch).

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CDP {
  static async connect(port = 9222, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const info = await res.json();
        const ws = new WebSocket(info.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 5000);
          ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
          ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e); }, { once: true });
        });
        return new CDP(ws, info);
      } catch (e) {
        lastErr = e;
        await sleep(300);
      }
    }
    throw new Error(`Cannot connect to Chrome on port ${port}: ${lastErr?.message || lastErr}`);
  }

  constructor(ws, info = {}) {
    this.ws = ws;
    this.info = info;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    ws.addEventListener('message', (event) => {
      const text = typeof event.data === 'string'
        ? event.data
        : Buffer.from(event.data).toString('utf8');
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) {
        const key = msg.sessionId ? `${msg.sessionId}::${msg.method}` : msg.method;
        for (const cb of this.listeners.get(key) || []) cb(msg.params, msg);
      }
    });

    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP socket is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(event, cb, sessionId = undefined) {
    const key = sessionId ? `${sessionId}::${event}` : event;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(cb);
    return () => this.listeners.get(key)?.delete(cb);
  }

  waitEvent(event, timeoutMs = 30000, sessionId = undefined) {
    return new Promise((resolve, reject) => {
      const key = sessionId ? `${sessionId}::${event}` : event;
      const timer = setTimeout(() => {
        this.listeners.get(key)?.delete(cb);
        reject(new Error(`Timeout waiting for ${event}`));
      }, timeoutMs);
      const cb = (params) => {
        clearTimeout(timer);
        this.listeners.get(key)?.delete(cb);
        resolve(params);
      };
      if (!this.listeners.has(key)) this.listeners.set(key, new Set());
      this.listeners.get(key).add(cb);
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  async createPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const sessionId = await this.attach(targetId);
    return { targetId, sessionId };
  }

  async closePage(targetId) {
    try { await this.send('Target.closeTarget', { targetId }); } catch { /* already gone */ }
  }

  async eval(expression, sessionId, opts = {}) {
    const { awaitPromise = true, returnByValue = true, timeoutMs = 30000 } = opts;
    const r = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue, userGesture: true },
      sessionId,
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = d.exception?.description || d.text || 'Evaluation failed';
      throw new Error(msg);
    }
    return r.result?.value;
  }

  async waitFor(expression, sessionId, { timeoutMs = 30000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        const v = await this.eval(expression, sessionId, { timeoutMs: 5000 });
        if (v) return v;
      } catch (e) {
        lastErr = e;
      }
      await sleep(intervalMs);
    }
    throw new Error(`waitFor timeout: ${expression}${lastErr ? ` (${lastErr.message})` : ''}`);
  }

  async navigate(url, sessionId, { waitMs = 1500 } = {}) {
    await this.send('Page.enable', {}, sessionId);
    const loaded = this.waitEvent('Page.loadEventFired', 30000, sessionId).catch(() => null);
    await this.send('Page.navigate', { url }, sessionId);
    await loaded;
    await sleep(waitMs);
  }

  async screenshot(sessionId, path, opts = {}) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', ...opts }, sessionId);
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, Buffer.from(data, 'base64'));
    return path;
  }

  async listPages() {
    const res = await fetch(`http://127.0.0.1:${this.info.port || 9222}/json/list`);
    return res.json();
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

export async function pageInfo(port = 9222) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}
