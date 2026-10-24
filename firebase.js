'use strict';
// Firebase Realtime Database sync (REST, no extra packages). Gives the bot a MEMORY that survives restarts and lets you
// watch it from anywhere:   bots/<name>/status   (heartbeat)   bots/<name>/memory   (friends, goal, technique record)
//                           bots/<name>/events   (ring buffer of the last 100 kills / deaths / retreats / errors)
// NEVER stored: passwords, API keys, chat messages.
// SECURITY: in the Firebase console set Realtime Database RULES so only authenticated/known writers can read+write
// (rules like {".read": true, ".write": true} make your DB public). If you use a database secret / token put it in
// config.json -> firebase.authToken.
const https = require('https');

function createFirebase(cfg, info) {
  const fc = () => ({ enabled: false, url: '', authToken: '', syncSeconds: 60, ...(cfg.firebase || {}) });
  const base = () => fc().url.replace(/\/+$/, '');
  const on = () => fc().enabled && /^https:\/\/.+\.firebasedatabase\.app$|^https:\/\/.+\.firebaseio\.com$/.test(base());
  const safe = (s) => String(s || 'bot').replace(/[.$#\[\]\/]/g, '_').slice(0, 60);
  const root = () => `bots/${safe(info.name())}`;
  let evIdx = Math.floor(Date.now() / 1000) % 100;
  let failCount = 0;
  let lastFailLog = 0;
  let lastError = '';

  function request(method, path, body) {
    const q = fc().authToken ? `?auth=${encodeURIComponent(fc().authToken)}` : '';
    const url = `${base()}/${path}.json${q}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const timeoutMs = 8000;
    if (typeof fetch === 'function') {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      return fetch(url, { method, headers: { 'content-type': 'application/json' }, body: payload, signal: ctrl.signal })
        .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))
        .finally(() => clearTimeout(timer));
    }
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, timeout: timeoutMs, headers: { 'content-type': 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => { let data = null; try { data = JSON.parse(raw); } catch (e) { /* ignore */ } resolve({ status: res.statusCode, data }); });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Never throws. Returns { ok, data, error }. */
  async function call(method, path, body) {
    if (!on()) return { ok: false, error: 'firebase disabled / bad url' };
    try {
      const r = await request(method, path, body);
      if (r.status >= 200 && r.status < 300) { failCount = 0; lastError = ''; return { ok: true, data: r.data }; }
      lastError = r.status === 401 || r.status === 403 ? `HTTP ${r.status}: permission denied - fix your Realtime Database RULES or set firebase.authToken` : `HTTP ${r.status}${r.data && r.data.error ? ` ${String(r.data.error).slice(0, 80)}` : ''}`;
    } catch (e) { lastError = e.message; }
    failCount++;
    if (Date.now() - lastFailLog > 300000) { lastFailLog = Date.now(); if (info.report) info.report('E801', null, lastError); }
    return { ok: false, error: lastError };
  }

  const stamp = () => new Date().toISOString();
  return {
    enabled: on,
    lastError: () => lastError,
    status: (s) => (failCount < 8 ? call('PUT', `${root()}/status`, { ...s, lastSeen: stamp() }) : Promise.resolve({ ok: false })),
    event: (kind, data) => (failCount < 8 ? call('PUT', `${root()}/events/${evIdx++ % 100}`, { kind, at: stamp(), ...data }) : Promise.resolve({ ok: false })),
    saveMemory: (m) => call('PUT', `${root()}/memory`, { ...m, savedAt: stamp() }),
    loadMemory: async () => { const r = await call('GET', `${root()}/memory`); return r.ok && r.data && typeof r.data === 'object' ? r.data : null; },
    /** for the fbtest chat command */
    async test() {
      if (!on()) return { ok: false, text: 'Firebase is off or the url is wrong (config.json -> firebase).' };
      const w = await call('PUT', `${root()}/ping`, { at: stamp() });
      if (!w.ok) return { ok: false, text: `Firebase write failed: ${w.error}` };
      const r = await call('GET', `${root()}/ping`);
      return r.ok && r.data ? { ok: true, text: `Firebase OK: wrote and read bots/${safe(info.name())}.` } : { ok: false, text: `Firebase read failed: ${r.error || 'empty'}` };
    }
  };
}

module.exports = createFirebase;
