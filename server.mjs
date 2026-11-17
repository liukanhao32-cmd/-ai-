import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_DIR = path.join(ROOT, 'config');
const MODELS_FILE = path.join(CONFIG_DIR, 'models.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const DATA_DIR = path.join(ROOT, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const CALLS_FILE = path.join(DATA_DIR, 'calls.jsonl');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ---------------- 文件读写 ---------------- */

async function ensureDirs() {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

/* ---------------- 基础数据 ---------------- */

function monthKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

async function getSettings() {
  const s = await readJson(SETTINGS_FILE, {});
  return {
    port: Number(s.port) || 7788,
    monthlyBudgetCNY: Number(s.monthlyBudgetCNY) || 100,
    temperature: Number.isFinite(s.temperature) ? s.temperature : 0.7,
    systemPrompt: typeof s.systemPrompt === 'string' ? s.systemPrompt : '',
  };
}

async function getModels() {
  const cfg = await readJson(MODELS_FILE, { models: [] });
  const keys = await readJson(KEYS_FILE, {});
  return (cfg.models || []).map((m) => ({
    ...m,
    key: keys[m.id] || '',
  }));
}

async function getUsage() {
  const u = await readJson(USAGE_FILE, null);
  const mk = monthKey();
  if (!u || u.month !== mk) return { month: mk, total: 0, count: 0, byModel: {} };
  u.byModel = u.byModel || {};
  u.total = Number(u.total) || 0;
  u.count = Number(u.count) || 0;
  return u;
}

async function addUsage(modelId, inputTok, outputTok, cost) {
  const u = await getUsage();
  u.total = Number((u.total + cost).toFixed(6));
  u.count += 1;
  const b = (u.byModel[modelId] ||= { input: 0, output: 0, cost: 0, count: 0 });
  b.input += inputTok;
  b.output += outputTok;
  b.cost = Number((b.cost + cost).toFixed(6));
  b.count += 1;
  await writeJson(USAGE_FILE, u);
  return u;
}

/** 字符数 → token 的粗略估算（中文约 1.5~2 字/token） */
function estTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 1.8));
}

function calcCost(model, inputTok, outputTok) {
  const ip = Number(model.inputPrice) || 0;
  const op = Number(model.outputPrice) || 0;
  return inputTok / 1e6 * ip + outputTok / 1e6 * op;
}

/* ---------------- 会话 ---------------- */

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const sessionFile = (id) => path.join(SESSIONS_DIR, id + '.json');

async function listSessions() {
  const files = await fsp.readdir(SESSIONS_DIR).catch(() => []);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const j = await readJson(path.join(SESSIONS_DIR, f), null);
    if (!j || !j.id) continue;
    out.push({
      id: j.id,
      title: j.title || '未命名对话',
      updatedAt: Number(j.updatedAt) || 0,
      count: (j.messages || []).length,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

async function appendCall(rec) {
  try {
    await fsp.appendFile(CALLS_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch (_) { /* 日志失败不影响主流程 */ }
}

async function readCalls(limit = 60) {
  try {
    const txt = await fsp.readFile(CALLS_FILE, 'utf8');
    const lines = txt.split('\n').filter(Boolean).slice(-limit);
    return lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/* ---------------- HTTP 工具 ---------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function sseSend(res, obj) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/* ---------------- 接口 ---------------- */

async function handleState(req, res) {
  const [settings, models, usage] = await Promise.all([getSettings(), getModels(), getUsage()]);
  sendJson(res, 200, {
    settings,
    usage,
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color || '#6b7280',
      model: m.model,
      baseUrl: m.baseUrl,
      note: m.note || '',
      hasKey: Boolean(m.key),
      inputPrice: m.inputPrice ?? 0,
      outputPrice: m.outputPrice ?? 0,
      contextWindow: m.contextWindow ?? 0,
    })),
    agents: [],
  });
}

async function handleSetKey(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: '请求格式错误' });
  }
  const id = String(body.id || '');
  const key = String(body.key || '').trim();
  if (!id) return sendJson(res, 400, { error: '缺少模型 id' });

  const keys = await readJson(KEYS_FILE, {});
  if (key) keys[id] = key;
  else delete keys[id];
  await writeJson(KEYS_FILE, keys);
  sendJson(res, 200, { ok: true, hasKey: Boolean(key) });
}

async function handleSetSettings(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: '请求格式错误' });
  }
  const s = await readJson(SETTINGS_FILE, {});
  if (Number.isFinite(Number(body.monthlyBudgetCNY))) s.monthlyBudgetCNY = Math.max(0, Number(body.monthlyBudgetCNY));
  if (Number.isFinite(Number(body.temperature))) s.temperature = Math.min(2, Math.max(0, Number(body.temperature)));
  if (typeof body.systemPrompt === 'string') s.systemPrompt = body.systemPrompt;
  await writeJson(SETTINGS_FILE, s);
  sendJson(res, 200, { ok: true, settings: await getSettings() });
}

async function handleResetUsage(req, res) {
  await writeJson(USAGE_FILE, { month: monthKey(), total: 0, count: 0, byModel: {} });
  sendJson(res, 200, { ok: true });
}

/* ---------------- 会话接口 ---------------- */

async function handleListSessions(req, res) {
  sendJson(res, 200, { sessions: await listSessions() });
}

async function handleSession(req, res, id) {
  if (!SAFE_ID.test(id)) return sendJson(res, 400, { error: '会话 id 不合法' });
  const file = sessionFile(id);

  if (req.method === 'GET') {
    const j = await readJson(file, null);
    if (!j) return sendJson(res, 404, { error: '没有这个会话' });
    return sendJson(res, 200, j);
  }

  if (req.method === 'POST') {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: '请求格式错误' });
    }
    const now = Date.now();
    const prev = await readJson(file, null);
    await writeJson(file, {
      id,
      title: String(body.title || '新对话').slice(0, 80),
      createdAt: prev?.createdAt || now,
      updatedAt: now,
      messages: Array.isArray(body.messages) ? body.messages : [],
      contexts: body.contexts && typeof body.contexts === 'object' ? body.contexts : {},
    });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'DELETE') {
    await fsp.rm(file, { force: true });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: '不支持的方法' });
}

async function handleStats(req, res) {
  const [usage, calls, settings] = await Promise.all([getUsage(), readCalls(60), getSettings()]);
  sendJson(res, 200, { usage, budget: settings.monthlyBudgetCNY, calls });
}

async function handleChat(req, res) {
  const startedAt = Date.now();
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, { error: '请求格式错误' });
  }

  const modelId = String(payload.modelId || '');
  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages || !messages.length) return sendJson(res, 400, { error: '没有消息内容' });

  const models = await getModels();
  const m = models.find((x) => x.id === modelId);
  if (!m) return sendJson(res, 404, { error: '没有这个模型' });
  if (!m.key) return sendJson(res, 400, { error: `${m.name} 还没填密钥，点左侧「设置」填一下` });

  const [settings, usage] = await Promise.all([getSettings(), getUsage()]);
  if (usage.total >= settings.monthlyBudgetCNY) {
    return sendJson(res, 402, {
      error: `本月预算已用完（已花 ¥${usage.total.toFixed(2)}，上限 ¥${settings.monthlyBudgetCNY}）。可在设置里调整上限。`,
    });
  }

  sseHead(res);
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const sys = (settings.systemPrompt || '').trim();
  const outMessages = sys ? [{ role: 'system', content: sys }, ...messages] : messages;

  const body = {
    model: m.model,
    messages: outMessages,
    stream: true,
    temperature: settings.temperature,
    stream_options: { include_usage: true },
  };
  // 模型自带的额外参数（如 DeepSeek 的 thinking 开关）
  if (m.extraBody && typeof m.extraBody === 'object') Object.assign(body, m.extraBody);

  const url = String(m.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  let assistantText = '';
  let providerUsage = null;

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${m.key}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      sseSend(res, { type: 'error', message: `${m.name} 调用失败（HTTP ${r.status}）${shortErr(detail)}` });
      res.end();
      return;
    }

    const ctype = (r.headers.get('content-type') || '').toLowerCase();

    if (ctype.includes('application/json')) {
      // 某些服务商忽略 stream 参数，直接回整包
      const j = await r.json();
      const text = j?.choices?.[0]?.message?.content || '';
      providerUsage = j?.usage || null;
      assistantText = text;
      if (text) sseSend(res, { type: 'delta', text });
    } else {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || !line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          if (j.usage) providerUsage = j.usage;
          const delta = j?.choices?.[0]?.delta?.content;
          if (delta) {
            assistantText += delta;
            sseSend(res, { type: 'delta', text: delta });
          }
          const err = j?.error;
          if (err) {
            sseSend(res, { type: 'error', message: `${m.name} 返回错误：${err.message || JSON.stringify(err)}` });
          }
        }
      }
    }
  } catch (e) {
    if (ac.signal.aborted) {
      return; // 客户端主动断开，不计费
    }
    sseSend(res, { type: 'error', message: `${m.name} 请求异常：${e.message}` });
    res.end();
    return;
  }

  const inputTok = providerUsage?.prompt_tokens ?? estTokens(outMessages.map((x) => x.content).join('\n'));
  const outputTok = providerUsage?.completion_tokens ?? estTokens(assistantText);
  const cost = calcCost(m, inputTok, outputTok);
  const u = await addUsage(m.id, inputTok, outputTok, cost);
  await appendCall({
    t: Date.now(),
    modelId: m.id,
    name: m.name,
    input: inputTok,
    output: outputTok,
    cost: Number(cost.toFixed(6)),
    ms: Date.now() - startedAt,
  });

  sseSend(res, {
    type: 'done',
    usage: { input: inputTok, output: outputTok, estimated: !providerUsage },
    cost: Number(cost.toFixed(6)),
    monthTotal: Number(u.total.toFixed(6)),
    budget: settings.monthlyBudgetCNY,
  });
  res.end();
}

function shortErr(detail) {
  if (!detail) return '';
  const t = String(detail).replace(/\s+/g, ' ').slice(0, 200);
  return t ? `：${t}` : '';
}

/* ---------------- 静态文件 ---------------- */

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!target.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const buf = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
}

/* ---------------- 启动 ---------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (req.method === 'GET' && p === '/api/state') return await handleState(req, res);
      if (req.method === 'GET' && p === '/api/sessions') return await handleListSessions(req, res);
      if (p.startsWith('/api/sessions/')) return await handleSession(req, res, p.slice('/api/sessions/'.length));
      if (req.method === 'GET' && p === '/api/stats') return await handleStats(req, res);
      if (req.method === 'POST' && p === '/api/keys') return await handleSetKey(req, res);
      if (req.method === 'POST' && p === '/api/settings') return await handleSetSettings(req, res);
      if (req.method === 'POST' && p === '/api/usage/reset') return await handleResetUsage(req, res);
      if (req.method === 'POST' && p === '/api/chat') return await handleChat(req, res);
      if (req.method === 'GET' && p === '/api/health') return sendJson(res, 200, { ok: true });
      return sendJson(res, 404, { error: '接口不存在' });
    }
    return await serveStatic(req, res, p);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message || '服务器异常' });
    else res.end();
  }
});

await ensureDirs();
const settings = await getSettings();
const PORT = Number(process.env.PORT) || settings.port;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  多AI聊天台已启动  →  http://127.0.0.1:${PORT}\n`);
  console.log(`  配置文件: ${MODELS_FILE}`);
  console.log(`  密钥文件: ${KEYS_FILE}`);
  console.log(`  预算: ¥${settings.monthlyBudgetCNY}/月\n`);
});
