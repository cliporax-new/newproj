'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SMM Panel Provider API (standard "API v2" format used by Perfect Panel etc.)
//
//   POST http://<server-ip>:4620/api/v2
//   key=<API_KEY>&action=services|add|status|balance|cancel
//
// Isolated module: runs on its OWN port (dashboard stays private on 127.0.0.1)
// and only CALLS the existing createCommentJob / runJob. It does not modify the
// comment worker, rotation, or dashboard logic.
// ─────────────────────────────────────────────────────────────────────────────

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PRIVATE_DIR = path.join(DATA_DIR, 'private');
const CONFIG_FILE = path.join(PRIVATE_DIR, 'smm-config.json');
const ORDERS_FILE = path.join(DATA_DIR, 'smm-orders.json');

const TERMINAL = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try { fs.rmSync(file, { force: true }); } catch {}
  fs.renameSync(tmp, file);
}

function defaultConfig() {
  return {
    enabled: true,
    apiKey: crypto.randomBytes(24).toString('hex'),
    host: '0.0.0.0',
    port: 4620,
    // How many SMM orders may run at the same time (each running order = 1 browser at a time).
    // Keep low on a small RDP/VPS: 1-2 for 4 GB RAM, 3-4 for 8 GB RAM.
    maxConcurrentOrders: 2,
    currency: 'USD',
    balance: '100000.00',
    services: [
      {
        service: 1,
        name: 'Instagram Custom Comments [Indian Mobile Accounts]',
        type: 'Custom Comments',
        category: 'Instagram Comments',
        rate: '50.00', // price per 1000
        min: 1,
        max: 100,
        refill: false,
        cancel: true,
        gapMinutes: 5, // 5 minutes delay between comments on same reel
      },
    ],
  };
}

function loadConfig() {
  const saved = readJson(CONFIG_FILE, null);
  if (saved && saved.apiKey) {
    const merged = { ...defaultConfig(), ...saved };
    if (!Array.isArray(merged.services) || !merged.services.length) merged.services = defaultConfig().services;
    for (const s of merged.services) {
      if (s.service === 1) {
        if (!s.max || s.max < 100) s.max = 100;
        if (!s.gapMinutes || s.gapMinutes < 5) s.gapMinutes = 5;
      }
    }
    return merged;
  }
  const fresh = defaultConfig();
  writeJson(CONFIG_FILE, fresh);
  return fresh;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function readRequestParams(req, url) {
  return new Promise((resolve) => {
    const params = Object.fromEntries(url.searchParams.entries());
    if (req.method !== 'POST') return resolve(params);
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      const type = String(req.headers['content-type'] || '');
      try {
        if (type.includes('application/json')) Object.assign(params, JSON.parse(data || '{}'));
        else Object.assign(params, Object.fromEntries(new URLSearchParams(data).entries()));
      } catch {}
      resolve(params);
    });
    req.on('error', () => resolve(params));
  });
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function money(value) {
  return (Math.round(Number(value || 0) * 100000) / 100000).toFixed(5);
}

function parseComments(raw) {
  let list;
  if (Array.isArray(raw)) list = raw;
  else list = String(raw || '').replace(/\r/g, '').split('\n');
  return list.map((c) => String(c || '').trim()).filter(Boolean);
}

function start(deps) {
  const { createCommentJob, runJob, jobs, listAccounts } = deps;
  const config = loadConfig();
  if (!config.enabled) {
    console.log('[SMM_API] Disabled in data/private/smm-config.json');
    return null;
  }

  const store = readJson(ORDERS_FILE, { version: 1, nextId: 1000, orders: {} });
  if (!store.orders) store.orders = {};
  if (!store.nextId) store.nextId = 1000;

  let dirty = false;
  const save = () => { dirty = true; };
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try { writeJson(ORDERS_FILE, store); } catch (err) { console.error('[SMM_API] save failed:', err.message); }
  }, 2000).unref();

  const serviceById = (id) => config.services.find((s) => String(s.service) === String(id));

  // ── Order progress snapshot (kept in our own store, so status survives job pruning/restarts) ──
  function syncOrder(order) {
    if (!order.jobId || order.final) return;
    const job = jobs.get(order.jobId);
    if (!job) return;
    const items = job.items || [];
    const posted = items.filter((it) => it.ok).length;
    order.posted = posted;
    order.jobStatus = job.status;
    if (TERMINAL.includes(job.status)) {
      order.final = true;
      order.finishedAt = job.finishedAt || new Date().toISOString();
      order.errors = items.filter((it) => !it.ok && it.error).map((it) => `${it.account}: ${it.error}`).slice(0, 10);
    }
    save();
  }

  function orderStatus(order) {
    syncOrder(order);
    const qty = order.quantity;
    const posted = order.posted || 0;
    const remains = Math.max(0, qty - posted);
    let status;
    if (order.state === 'pending') status = 'Pending';
    else if (order.state === 'rejected') status = 'Canceled';
    else if (order.state === 'cancelled') status = posted > 0 ? 'Partial' : 'Canceled';
    else if (!order.final) status = posted > 0 ? 'In progress' : 'Processing';
    else if (posted >= qty) status = 'Completed';
    else if (posted > 0) status = 'Partial';
    else status = 'Canceled';
    return {
      charge: money(order.charge),
      start_count: '0',
      status,
      remains: String(remains),
      currency: config.currency,
    };
  }

  // ── Scheduler: start pending orders, max N running at once ──
  function activeCount() {
    let n = 0;
    for (const order of Object.values(store.orders)) {
      if (order.state !== 'running') continue;
      syncOrder(order);
      if (!order.final) n += 1;
    }
    return n;
  }

  function startOrder(order) {
    const service = serviceById(order.service) || {};
    const gap = Number(service.gapMinutes) >= 0 ? Number(service.gapMinutes) : 5;
    try {
      const job = createCommentJob({
        postUrl: order.link,
        accountMode: 'auto',
        comments: order.comments.map((text, i) => ({ text, gapMinutes: i === 0 ? 0 : gap })),
      });
      job.source = 'smm';
      job.smmOrderId = order.id;
      order.jobId = job.id;
      order.state = 'running';
      order.startedAt = new Date().toISOString();
      console.log(`[SMM_API] Order #${order.id} started as ${job.id} (${order.quantity} comments)`);
    } catch (err) {
      const msg = String(err && err.message || err);
      // Not enough free accounts right now -> keep waiting instead of failing the order
      if (/only \d+ are available|No ready account/i.test(msg) && (Date.now() - Date.parse(order.createdAt)) < 6 * 3600 * 1000) {
        order.waitReason = msg;
      } else {
        order.state = 'rejected';
        order.final = true;
        order.errors = [msg];
        console.log(`[SMM_API] Order #${order.id} rejected: ${msg}`);
      }
    }
    save();
  }

  function tick() {
    try {
      let free = Math.max(1, Number(config.maxConcurrentOrders) || 1) - activeCount();
      if (free <= 0) return;
      const now = Date.now();
      const pending = Object.values(store.orders)
        .filter((o) => o.state === 'pending' && (!o.nextTryAt || o.nextTryAt <= now))
        .sort((a, b) => a.id - b.id)
        .slice(0, 5);
      for (const order of pending) {
        if (free <= 0) break;
        startOrder(order);
        if (order.state === 'running') free -= 1;
        else if (order.state === 'pending') order.nextTryAt = now + 60 * 1000;
      }
    } catch (err) {
      console.error('[SMM_API] scheduler error:', err.message);
    }
  }

  // Resume SMM jobs that were queued/running before a restart
  for (const order of Object.values(store.orders)) {
    if (order.state !== 'running' || !order.jobId) continue;
    const job = jobs.get(order.jobId);
    if (job && !TERMINAL.includes(job.status)) {
      try { runJob(job); } catch {}
    } else if (!job) {
      order.final = true; // job record no longer available; keep last snapshot
    }
  }
  setInterval(tick, 5000).unref();
  setTimeout(tick, 1000).unref();

  // ── Actions ──
  function actionServices() {
    return config.services.map((s) => ({
      service: s.service,
      name: s.name,
      type: s.type,
      category: s.category,
      rate: String(s.rate),
      min: String(s.min),
      max: String(s.max),
      refill: Boolean(s.refill),
      cancel: Boolean(s.cancel),
    }));
  }

  function actionAdd(p) {
    const service = serviceById(p.service);
    if (!service) return { error: 'Incorrect service ID' };
    const link = String(p.link || '').trim();
    if (!/^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[^/?#]+/i.test(link)) {
      return { error: 'Incorrect link. Use a direct Instagram post/reel URL.' };
    }
    const comments = parseComments(p.comments);
    if (!comments.length) return { error: 'Comments are required (one comment per line).' };
    const qty = comments.length;
    if (qty < Number(service.min)) return { error: `Minimum quantity is ${service.min}` };
    if (qty > Number(service.max)) return { error: `Maximum quantity is ${service.max}` };
    if (comments.some((c) => c.length > 1000)) return { error: 'Each comment must be 1000 characters or fewer.' };
    const keys = comments.map((c) => c.replace(/\s+/g, ' ').toLocaleLowerCase());
    if (new Set(keys).size !== keys.length) return { error: 'Duplicate comments are not allowed in one order.' };
    const ready = listAccounts().filter((a) => a.healthy).length;
    if (qty > ready) return { error: `Not enough accounts. Max ${ready} comments per link right now.` };

    const id = store.nextId++;
    store.orders[id] = {
      id,
      service: service.service,
      link,
      comments,
      quantity: qty,
      charge: (Number(service.rate) * qty) / 1000,
      state: 'pending',
      createdAt: new Date().toISOString(),
      jobId: null,
      posted: 0,
      final: false,
    };
    save();
    setImmediate(tick);
    console.log(`[SMM_API] New order #${id}: ${qty} comments -> ${link}`);
    return { order: id };
  }

  function actionStatus(p) {
    if (p.orders) {
      const out = {};
      for (const raw of String(p.orders).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100)) {
        const order = store.orders[raw];
        out[raw] = order ? orderStatus(order) : { error: 'Incorrect order ID' };
      }
      return out;
    }
    const order = store.orders[String(p.order || '').trim()];
    if (!order) return { error: 'Incorrect order ID' };
    return orderStatus(order);
  }

  function cancelOne(id) {
    const order = store.orders[id];
    if (!order) return { order: Number(id) || id, cancel: { error: 'Incorrect order ID' } };
    if (order.state === 'pending') {
      order.state = 'cancelled';
      order.final = true;
    } else if (order.state === 'running' && !order.final) {
      const job = jobs.get(order.jobId);
      if (job && !TERMINAL.includes(job.status)) job.status = 'cancelled';
      order.state = 'cancelled';
    } else {
      return { order: Number(id), cancel: { error: 'Order cannot be canceled' } };
    }
    save();
    return { order: Number(id), cancel: 1 };
  }

  function actionCancel(p) {
    const ids = String(p.orders || p.order || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    if (!ids.length) return { error: 'Order ID required' };
    return ids.map(cancelOne);
  }

  // ── Simple per-IP rate limit (protects the server from floods) ──
  const hits = new Map();
  setInterval(() => hits.clear(), 60 * 1000).unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!['/api/v2', '/api/v2/'].includes(url.pathname)) return send(res, 404, { error: 'Not found' });

      const ip = req.socket.remoteAddress || 'x';
      const count = (hits.get(ip) || 0) + 1;
      hits.set(ip, count);
      if (count > 300) return send(res, 429, { error: 'Too many requests' });

      const p = await readRequestParams(req, url);
      if (!safeEqual(p.key, config.apiKey)) return send(res, 200, { error: 'Invalid API key' });

      const action = String(p.action || '').toLowerCase();
      if (action === 'services') return send(res, 200, actionServices());
      if (action === 'add') return send(res, 200, actionAdd(p));
      if (action === 'status') return send(res, 200, actionStatus(p));
      if (action === 'balance') return send(res, 200, { balance: String(config.balance), currency: config.currency });
      if (action === 'cancel') return send(res, 200, actionCancel(p));
      if (action === 'refill' || action === 'refill_status') return send(res, 200, { error: 'Refill is not available for this service' });
      return send(res, 200, { error: 'Incorrect request' });
    } catch (err) {
      return send(res, 500, { error: 'Server error' });
    }
  });

  server.on('error', (err) => console.error(`[SMM_API] Could not start on port ${config.port}: ${err.message}`));
  server.listen(config.port, config.host, async () => {
    let publicIp = 'YOUR_RDP_IP';
    try {
      const res = await fetch('https://api64.ipify.org?format=json', { signal: AbortSignal.timeout(3500) });
      const data = await res.json();
      if (data && data.ip) publicIp = data.ip;
    } catch {}

    config.detectedIp = publicIp;

    console.log('\n============================================================');
    console.log('   INSTAGRAM AUTOMATION & SMM PROVIDER READY!');
    console.log('============================================================');
    console.log(`   Local Dashboard : http://localhost:4610`);
    console.log(`   SMM API Endpoint: http://${publicIp}:${config.port}/api/v2`);
    console.log(`   Your SMM API Key: ${config.apiKey}`);
    console.log('============================================================\n');
  });
  return server;
}

function getSmmInfo() {
  const config = loadConfig();
  return {
    enabled: config.enabled,
    port: config.port,
    apiKey: config.apiKey,
    detectedIp: config.detectedIp || 'localhost',
    endpoint: `http://${config.detectedIp || 'YOUR_RDP_IP'}:${config.port}/api/v2`,
    maxConcurrentOrders: config.maxConcurrentOrders,
    services: config.services,
  };
}

module.exports = { start, loadConfig, getSmmInfo, CONFIG_FILE };
