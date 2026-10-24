'use strict';
// Tiny LLM client shared by chat + the "brain". Providers: Gemini or Claude.
//  - Gemini keys that start with "AIza" are Google AI Studio keys; keys that start with "AQ." are Vertex AI (express mode) keys.
//    Both are tried automatically, with fallback models, and the working combination is remembered.
//  - Works on old Node versions without global fetch (falls back to the https module).
//  - Rate limiting: min gap between calls and a cool-down after HTTP 429. The key is only ever sent in a header.
const https = require('https');
const state = { lastCall: 0, coolUntil: 0, good: null, lastError: '' };

const provider = (cfg) => String((cfg.aiChat && cfg.aiChat.provider) || 'claude').toLowerCase();
const apiKey = (cfg) => String((cfg.aiChat && cfg.aiChat.apiKey) ||
  (provider(cfg) === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY) || '').trim();
const available = (cfg) => !!apiKey(cfg);
const waitMs = () => Math.max(0, state.coolUntil - Date.now());
const lastError = () => state.lastError;

/** POST JSON, returns { status, data }. Uses fetch when available, https otherwise. */
function post(url, headers, bodyObj, timeoutMs) {
  const body = JSON.stringify(bodyObj);
  if (typeof fetch === 'function') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, { method: 'POST', headers, body, signal: ctrl.signal })
      .then(async (res) => ({ status: res.status, data: await res.json().catch(() => ({})) }))
      .finally(() => clearTimeout(timer));
  }
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => { let data = {}; try { data = JSON.parse(raw); } catch (e) { /* not json */ } resolve({ status: res.statusCode, data }); });
    });
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const errText = (data, status) => String((data && data.error && (data.error.message || data.error.status)) || `HTTP ${status}`).replace(/key=[^&\s]+/gi, 'key=***').slice(0, 200);

const GEMINI_MODELS = (cfg) => [...new Set([(cfg.aiChat && cfg.aiChat.model) || 'gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'])];
function geminiUrls(key, model) {
  const m = encodeURIComponent(model);
  const vertex = `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:generateContent`;
  const studio = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
  return key.startsWith('AQ.') ? [vertex, studio] : [studio, vertex];
}

async function callGemini(cfg, key, { system, user, maxTokens, json, timeoutMs }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.5, ...(json ? { responseMimeType: 'application/json' } : {}) }
  };
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': key };
  // the combination that worked last time goes first
  const combos = [];
  for (const model of GEMINI_MODELS(cfg)) for (const url of geminiUrls(key, model)) combos.push({ url, model });
  if (state.good) combos.unshift(state.good);
  let last = 'no answer';
  for (const c of combos) {
    let r;
    try { r = await post(c.url, headers, body, timeoutMs); } catch (e) { last = e.message; continue; }
    if (r.status === 429) { state.coolUntil = Date.now() + 60000; throw new Error('AI rate limit / quota reached - pausing AI for 60s'); }
    if (r.status >= 200 && r.status < 300) {
      const parts = (r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts) || [];
      const text = parts.map((p) => p.text || '').join('').trim();
      if (text) { state.good = c; return text; }
      last = (r.data.promptFeedback && r.data.promptFeedback.blockReason) ? `blocked: ${r.data.promptFeedback.blockReason}` : 'empty answer';
      continue;
    }
    last = `${c.url.includes('aiplatform') ? 'vertex' : 'studio'}/${c.model}: ${errText(r.data, r.status)}`;
    // wrong key type / unknown model: try the next combination; other errors too (cheap)
  }
  throw new Error(last);
}

async function callClaude(cfg, key, { system, user, maxTokens, timeoutMs }) {
  const r = await post('https://api.anthropic.com/v1/messages', { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model: (cfg.aiChat && cfg.aiChat.model) || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }, timeoutMs);
  if (r.status === 429) { state.coolUntil = Date.now() + 60000; throw new Error('AI rate limit / quota reached - pausing AI for 60s'); }
  if (r.status < 200 || r.status >= 300) throw new Error(errText(r.data, r.status));
  return (r.data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/** Ask the model. Returns the reply text. Throws Error with a short message on failure. */
async function complete(cfg, { system, user, maxTokens = 500, json = false, timeoutMs = 25000, minGapMs = 3500 }) {
  const key = apiKey(cfg);
  if (!key) throw new Error('no API key (aiChat.apiKey or GEMINI_API_KEY)');
  if (Date.now() < state.coolUntil) throw new Error(`AI cooling down for ${Math.ceil(waitMs() / 1000)}s (rate limit)`);
  const gap = Date.now() - state.lastCall;
  if (gap < minGapMs) await new Promise((r) => setTimeout(r, minGapMs - gap));
  state.lastCall = Date.now();
  try {
    const out = provider(cfg) === 'gemini'
      ? await callGemini(cfg, key, { system, user, maxTokens, json, timeoutMs })
      : await callClaude(cfg, key, { system, user, maxTokens, timeoutMs });
    state.lastError = '';
    return out;
  } catch (e) {
    state.lastError = e.message;
    throw e;
  }
}

/** For the "aitest" chat command: one tiny request, tells exactly what is wrong. */
async function diagnose(cfg) {
  const key = apiKey(cfg);
  if (!key) return { ok: false, text: 'No key set. Put it in config.json -> aiChat.apiKey (or env GEMINI_API_KEY).' };
  try {
    const t0 = Date.now();
    const r = await complete(cfg, { system: 'Reply with the single word OK.', user: 'ping', maxTokens: 20, minGapMs: 0 });
    const g = state.good;
    return { ok: true, text: `AI works (${provider(cfg)}${g ? `, ${g.url.includes('aiplatform') ? 'vertex' : 'studio'}/${g.model}` : ''}, ${Date.now() - t0}ms): "${r.slice(0, 40)}"` };
  } catch (e) {
    return { ok: false, text: `AI failed: ${e.message}` };
  }
}

/** Pull the first JSON object out of a reply (models sometimes wrap it in ``` fences). */
function parseJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI did not return JSON');
  return JSON.parse(t.slice(a, b + 1));
}

module.exports = { complete, parseJson, available, provider, waitMs, diagnose, lastError };
