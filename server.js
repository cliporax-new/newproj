'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const proxyConfig = require('./proxy-config.js');

const PORT = Number(process.env.PORT || 4610);
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const ACCOUNTS_DIR = path.join(ROOT, 'accounts_instagram');
const DATA_DIR = path.join(ROOT, 'data');
const PRIVATE_DIR = path.join(DATA_DIR, 'private');
const LOGIN_SCRIPT = path.join(ROOT, 'login-instagram.js');
const COMMENT_WORKER = path.join(ROOT, 'comment-worker.js');
const JOBS_FILE = path.join(DATA_DIR, 'comment-jobs.json');
const HISTORY_FILE = path.join(DATA_DIR, 'comment-history.json');
const USAGE_FILE = path.join(DATA_DIR, 'account-usage.json');
const COMMENT_STAY_MS = 35000;
const ACCOUNT_REST_MS = 5 * 60 * 1000; // 5 minutes rest cooldown per account

for (const dir of [ACCOUNTS_DIR, DATA_DIR, PRIVATE_DIR, path.join(ROOT, 'artifacts')]) {
  fs.mkdirSync(dir, { recursive: true });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  try { fs.rmSync(filePath, { force: true }); } catch {}
  fs.renameSync(temp, filePath);
}

function cleanUsername(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
}

function accountFile(username) {
  return path.join(ACCOUNTS_DIR, `${username}.json`);
}

function normalizeInstagramTarget(value) {
  const input = String(value || '').trim();
  const url = new URL(input);
  if (!/(^|\.)instagram\.com$/i.test(url.hostname)) throw new Error('Use an Instagram URL.');
  const match = url.pathname.match(/^\/(p|reel|reels|tv)\/([^/?#]+)/i);
  if (!match) throw new Error('Use a direct Instagram reel/post URL.');
  const shortcode = match[2];
  return {
    shortcode,
    targetKey: `instagram:${shortcode}`,
    canonicalUrl: `https://www.instagram.com/p/${shortcode}/`,
  };
}

const ACCOUNT_IPS_FILE = path.join(DATA_DIR, 'account-ips.json');
let accountIps = readJsonFile(ACCOUNT_IPS_FILE, {});

function getAccountIpInfo(username) {
  accountIps = readJsonFile(ACCOUNT_IPS_FILE, {});
  return accountIps[username] || null;
}

function saveAccountIpInfo(username, ipInfo) {
  accountIps[username] = ipInfo;
  writeJsonAtomic(ACCOUNT_IPS_FILE, accountIps);
}

function handleAccountFailure(username, status, reason) {
  const file = accountFile(username);
  if (status === 'session_needs_attention' || status === 'suspended' || status === 'checkpoint') {
    // 1. Account is Suspended / Checkpointed:
    // Auto-remove completely from database & list so it never appears again
    try {
      if (fs.existsSync(file)) {
        const archiveDir = path.join(ROOT, 'suspended_accounts');
        fs.mkdirSync(archiveDir, { recursive: true });
        const dest = path.join(archiveDir, `${username}_${Date.now()}.json`);
        try { fs.renameSync(file, dest); }
        catch { fs.copyFileSync(file, dest); fs.unlinkSync(file); }
      }
      proxyConfig.clearProxy(username);
      console.log(`[AUTO_REMOVE] Suspended/checkpoint account @${username} was removed from database.`);
    } catch (err) {
      console.error(`[AUTO_REMOVE] Failed to remove @${username}:`, err.message);
    }
  } else if (status === 'logged_out') {
    // 2. Account is NOT suspended, just logged out / session expired:
    // Keep in list with "Re-login needed" icon
    try {
      if (fs.existsSync(file)) {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        state.cookies = (state.cookies || []).filter((c) => c.name !== 'sessionid');
        state.sessionInvalidated = true;
        state.suspended = false;
        state.invalidationReason = reason || 'Session expired (Not suspended, just re-login needed)';
        state.invalidatedAt = new Date().toISOString();
        writeJsonAtomic(file, state);
        console.log(`[RELOGIN_NEEDED] Account @${username} is not suspended, kept in list for re-login.`);
      }
    } catch (err) {
      console.error(`[RELOGIN_NEEDED] Failed to update @${username}:`, err.message);
    }
  }
}

// Health cache: session files are only re-parsed when they change on disk (scales to 1000s of accounts)
const accountHealthCache = new Map();

function readAccountHealth(full, stat) {
  const cached = accountHealthCache.get(full);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  let healthy = false;
  let accountStatus = 'ready';
  try {
    const state = JSON.parse(fs.readFileSync(full, 'utf8'));
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    const hasSession = cookies.some((c) => c.name === 'sessionid' && c.value);
    if (state.suspended) {
      healthy = false;
      accountStatus = 'suspended';
    } else if (state.sessionInvalidated || !hasSession) {
      healthy = false;
      accountStatus = 'logged_out';
    } else {
      healthy = true;
      accountStatus = 'ready';
    }
  } catch {}
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, healthy, accountStatus };
  accountHealthCache.set(full, entry);
  return entry;
}

function listAccounts() {
  if (!fs.existsSync(ACCOUNTS_DIR)) return [];
  accountIps = readJsonFile(ACCOUNT_IPS_FILE, {});
  const names = fs.readdirSync(ACCOUNTS_DIR).filter((name) => name.endsWith('.json'));
  const present = new Set();
  const list = [];
  for (const name of names) {
    const username = name.replace(/\.json$/, '');
    const full = path.join(ACCOUNTS_DIR, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    present.add(full);
    const { healthy, accountStatus } = readAccountHealth(full, stat);
    const proxy = proxyConfig.getProxySummary(username);
    list.push({
      username,
      healthy,
      accountStatus,
      savedAt: stat.mtime.toISOString(),
      proxyConfigured: proxy.configured,
      proxyLabel: proxy.label,
      ipInfo: accountIps[username] || null,
    });
  }
  for (const key of accountHealthCache.keys()) {
    if (!present.has(key)) accountHealthCache.delete(key);
  }
  return list.sort((a, b) => a.username.localeCompare(b.username));
}

// ─── Account Usage & Fair Rotation ───
let accountUsage = readJsonFile(USAGE_FILE, {});

function recordAccountUsage(username) {
  accountUsage[username] = Date.now();
  writeJsonAtomic(USAGE_FILE, accountUsage);
}

function getRotatedReadyAccounts(blockedSet = new Set(), excludeAccounts = new Set()) {
  const ready = listAccounts().filter((a) => a.healthy);
  const candidates = ready
    .map((a) => a.username)
    .filter((name) => !blockedSet.has(name) && !excludeAccounts.has(name));

  // Sort ascending by lastUsed timestamp: least recently used accounts first (fair round-robin)
  candidates.sort((a, b) => {
    const timeA = accountUsage[a] || 0;
    const timeB = accountUsage[b] || 0;
    return timeA - timeB;
  });

  return candidates;
}

// ─── Login Management ───
const activeLogins = new Map();

function loginErrorFromLog(log) {
  if (/PROXY_AUTH_FAILED/.test(log)) return 'Proxy authentication failed.';
  if (/PROXY_CONNECTION_FAILED/.test(log)) return 'Could not connect through the configured proxy.';
  if (/TARGET_UNREACHABLE/.test(log)) return 'Instagram login page could not be reached.';
  if (/BROWSER_CLOSED/.test(log)) return 'Login browser was closed before login completed.';
  if (/LOGIN_TIMEOUT/.test(log)) return 'Login was not completed within 10 minutes.';
  return 'Login did not finish.';
}

function startLogin(username) {
  // If a previous window process exists, clean up
  if (activeLogins.has(username)) {
    const existing = activeLogins.get(username);
    if (existing && existing.child) {
      try { existing.child.kill(); } catch {}
    }
    activeLogins.delete(username);
  }

  // Ensure dedicated Indian mobile proxy exists in config
  proxyConfig.getRawProxy(username);

  const state = { status: 'window_open', log: '', error: null };
  const startTime = Date.now();

  // Directly spawn node without cmd.exe or start so Windows Terminal NEVER opens
  const child = spawn(process.execPath, [LOGIN_SCRIPT, username, ACCOUNTS_DIR], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  activeLogins.set(username, { child, state, startTime });
  return { ok: true };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ─── History & Queue Management ───
const history = readJsonFile(HISTORY_FILE, { version: 1, targets: {} });
const jobs = new Map();
let jobCounter = 0;

function historyTarget(targetKey) {
  if (!history.targets[targetKey]) history.targets[targetKey] = { accounts: {}, updatedAt: null };
  return history.targets[targetKey];
}

function usedAccountsForTarget(targetKey) {
  return new Set(Object.keys((history.targets[targetKey] && history.targets[targetKey].accounts) || {}));
}

function markAccountUsed(targetKey, account, details = {}) {
  const target = historyTarget(targetKey);
  target.accounts[account] = {
    at: new Date().toISOString(),
    status: details.status || 'posted',
    jobId: details.jobId || null,
  };
  target.updatedAt = new Date().toISOString();
  writeJsonAtomic(HISTORY_FILE, history);
}

function terminalJobStatus(status) {
  return ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status);
}

function reservedAccountsForTarget(targetKey, excludeJobId = null) {
  const reserved = new Set();
  for (const job of jobs.values()) {
    if (job.id === excludeJobId || terminalJobStatus(job.status)) continue;
    for (const item of job.items || []) {
      const itemKey = item.targetKey || job.targetKey;
      if (itemKey === targetKey && item.account && !['failed_before_submit'].includes(item.status)) {
        reserved.add(item.account);
      }
    }
  }
  return reserved;
}

function persistJobs() {
  const recent = [...jobs.values()]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 100)
    .map((job) => {
      const clone = { ...job };
      delete clone._running;
      return clone;
    });
  writeJsonAtomic(JOBS_FILE, { version: 1, jobs: recent });
}

function loadJobs() {
  const saved = readJsonFile(JOBS_FILE, { version: 1, jobs: [] });
  for (const job of Array.isArray(saved.jobs) ? saved.jobs : []) {
    if (!job || !job.id) continue;
    delete job._running;
    let changed = false;
    for (const item of job.items || []) {
      if (item.status === 'running') {
        item.ok = false;
        item.status = 'uncertain_after_restart';
        item.error = 'Server restarted while comment was in progress.';
        item.finishedAt = item.finishedAt || new Date().toISOString();
        markAccountUsed(item.targetKey || job.targetKey, item.account, { status: item.status, jobId: job.id });
        changed = true;
      }
    }
    if (!terminalJobStatus(job.status)) {
      const next = (job.items || []).findIndex((item) => ['queued', 'waiting'].includes(item.status));
      if (next === -1) {
        job.status = (job.items || []).every((item) => item.ok) ? 'completed' : 'completed_with_errors';
        job.finishedAt = job.finishedAt || new Date().toISOString();
      } else {
        job.nextIndex = next;
        job.status = 'queued';
      }
      changed = true;
    }
    jobs.set(job.id, job);
    const suffix = Number(String(job.id).split('_').pop());
    if (Number.isFinite(suffix)) jobCounter = Math.max(jobCounter, suffix);
    if (changed) persistJobs();
  }
}

function spawnComment(username, postUrl, comment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMMENT_WORKER], {
      cwd: ROOT,
      env: {
        ...process.env,
        COMMENT_ACCOUNT: username,
        COMMENT_AUTH_FILE: accountFile(username),
        COMMENT_POST_URL: postUrl,
        COMMENT_TEXT: comment,
        COMMENT_STAY_MS: String(COMMENT_STAY_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });

    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('exit', (code) => {
      const matches = [...output.matchAll(/COMMENT_RESULT:(\{[^\r\n]+\})/g)];
      if (matches.length) {
        try { return resolve(JSON.parse(matches[matches.length - 1][1])); }
        catch {}
      }
      resolve({
        ok: false,
        account: username,
        status: code === 0 ? 'unknown' : 'worker_failed',
        error: 'Comment worker ended without a readable result.',
      });
    });
  });
}

async function runJob(job) {
  if (job._running) return;
  job._running = true;
  try {
    job.status = 'running';
    persistJobs();

    for (let i = Number(job.nextIndex || 0); i < job.items.length; i += 1) {
      if (job.status === 'cancelled') break;
      const item = job.items[i];
      job.nextIndex = i;

      if (item.status === 'uncertain_after_restart' || item.status === 'posted') {
        job.nextIndex = i + 1;
        continue;
      }

      if (i > 0) {
        if (!item.scheduledAt) {
          const previousBase = Date.parse(job.items[i - 1].postedAt || job.items[i - 1].finishedAt || '') || Date.now();
          item.scheduledAt = new Date(previousBase + Math.round(item.gapMinutes * 60000)).toISOString();
        }
        const waitMs = Date.parse(item.scheduledAt) - Date.now();
        if (waitMs > 0) {
          item.status = 'waiting';
          job.status = 'waiting';
          persistJobs();
          await sleep(waitMs);
        }
      }

      // Safe Account Rest / Cooldown Guard (Zero Ban Protection)
      const lastUsed = accountUsage[item.account] || 0;
      if (lastUsed > 0) {
        const elapsed = Date.now() - lastUsed;
        if (elapsed < ACCOUNT_REST_MS) {
          const targetKey = item.targetKey || job.targetKey;
          const blocked = usedAccountsForTarget(targetKey);
          const candidates = getRotatedReadyAccounts(blocked, new Set([item.account]));
          const restedCandidate = candidates.find((acc) => (Date.now() - (accountUsage[acc] || 0)) >= ACCOUNT_REST_MS);

          if (restedCandidate && job.accountMode === 'auto') {
            console.log(`[REST_GUARD] Account ${item.account} resting. Rotating to rested account ${restedCandidate}`);
            item.account = restedCandidate;
            persistJobs();
          } else {
            const restWaitMs = ACCOUNT_REST_MS - elapsed;
            console.log(`[REST_GUARD] Account ${item.account} cooling down. Waiting ${Math.round(restWaitMs / 1000)}s...`);
            item.status = 'waiting';
            job.status = 'waiting';
            persistJobs();
            await sleep(restWaitMs);
          }
        }
      }

      job.status = 'running';
      item.status = 'running';
      item.startedAt = new Date().toISOString();
      item.error = null;
      persistJobs();

      const targetUrl = item.postUrl || job.postUrl;
      const targetKey = item.targetKey || job.targetKey;
      const outcome = await spawnComment(item.account, targetUrl, item.comment);
      Object.assign(item, outcome, { finishedAt: new Date().toISOString() });

      if (outcome.ok === true || ['uncertain', 'uncertain_after_restart'].includes(outcome.status)) {
        markAccountUsed(targetKey, item.account, { status: outcome.status, jobId: job.id });
        recordAccountUsage(item.account);
      } else if (['session_needs_attention', 'suspended', 'checkpoint', 'logged_out'].includes(outcome.status)) {
        handleAccountFailure(item.account, outcome.status, outcome.error);
      }

      job.nextIndex = i + 1;
      persistJobs();
    }

    if (job.status !== 'cancelled') {
      job.status = job.items.every((item) => item.ok) ? 'completed' : 'completed_with_errors';
      job.finishedAt = new Date().toISOString();
      persistJobs();
    }
  } catch (error) {
    job.status = 'failed';
    job.error = String(error && error.message || error || 'Unknown job error');
    job.finishedAt = new Date().toISOString();
    persistJobs();
  } finally {
    delete job._running;
  }
}

function validateComments(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('Add at least one comment.');
  if (raw.length > 50) throw new Error('A single job can contain up to 50 comments.');
  const comments = raw.map((item, index) => {
    const text = String(item && item.text || '').trim();
    if (!text) throw new Error(`Comment ${index + 1} is empty.`);
    if (text.length > 1000) throw new Error(`Comment ${index + 1} must be 1000 characters or fewer.`);
    let gapMinutes = index === 0 ? 0 : Number(item && item.gapMinutes);
    if (!Number.isFinite(gapMinutes)) gapMinutes = 0;
    if (gapMinutes < 0 || gapMinutes > 1440) throw new Error(`Comment ${index + 1} gap must be between 0 and 1440 minutes.`);
    return { text, gapMinutes: Math.round(gapMinutes * 100) / 100 };
  });
  const keys = comments.map((c) => c.text.replace(/\s+/g, ' ').trim().toLocaleLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error('Use a different comment in each row. Duplicate comments are not allowed in the same job.');
  return comments;
}

function createCommentJob(body) {
  // ─── Mode: Multi-Link / Line-Wise ───
  if (body.mode === 'multi' || Array.isArray(body.lines)) {
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    const lines = rawLines
      .map((l) => ({
        url: String(l.url || '').trim(),
        comment: String(l.comment || '').trim(),
      }))
      .filter((l) => l.url && l.comment);

    if (!lines.length) throw new Error('Add at least one line with a valid Instagram URL and comment.');
    if (lines.length > 50) throw new Error('A single queue can contain up to 50 lines.');

    const defaultGap = Number(body.gapMinutes) >= 0 ? Number(body.gapMinutes) : 1;
    const items = [];
    const usedInThisQueue = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const target = normalizeInstagramTarget(line.url);
      const blocked = usedAccountsForTarget(target.targetKey);
      for (const account of reservedAccountsForTarget(target.targetKey)) blocked.add(account);

      let available = getRotatedReadyAccounts(blocked, new Set(usedInThisQueue));
      if (!available.length) {
        available = getRotatedReadyAccounts(blocked, new Set());
      }
      if (!available.length) {
        throw new Error(`Line ${i + 1} (${target.shortcode}): No ready account available that hasn't already commented on this post.`);
      }

      const assignedAccount = available[0];
      usedInThisQueue.push(assignedAccount);

      items.push({
        index: i + 1,
        account: assignedAccount,
        postUrl: target.canonicalUrl,
        shortcode: target.shortcode,
        targetKey: target.targetKey,
        comment: line.comment,
        gapMinutes: i === 0 ? 0 : defaultGap,
        ok: false,
        status: 'queued',
        scheduledAt: i === 0 ? new Date().toISOString() : null,
        startedAt: null,
        finishedAt: null,
        error: null,
      });
    }

    const id = `comment_${Date.now()}_${++jobCounter}`;
    const createdAt = new Date().toISOString();
    const job = {
      id,
      status: 'queued',
      mode: 'multi',
      postUrl: items[0].postUrl,
      shortcode: 'multi-line',
      targetKey: 'multi',
      accountMode: 'auto',
      createdAt,
      finishedAt: null,
      nextIndex: 0,
      staySeconds: COMMENT_STAY_MS / 1000,
      items,
    };
    jobs.set(id, job);
    persistJobs();
    runJob(job);
    return job;
  }

  // ─── Mode: Single Reel ───
  const target = normalizeInstagramTarget(body.postUrl);
  const comments = validateComments(body.comments);
  const accountMode = body.accountMode === 'manual' ? 'manual' : 'auto';
  const ready = listAccounts().filter((a) => a.healthy);
  const readyByName = new Map(ready.map((a) => [a.username, a]));
  const blocked = usedAccountsForTarget(target.targetKey);
  for (const account of reservedAccountsForTarget(target.targetKey)) blocked.add(account);

  let candidates;
  if (accountMode === 'manual') {
    const requested = [...new Set((Array.isArray(body.accounts) ? body.accounts : []).map(cleanUsername).filter(Boolean))];
    if (requested.length < comments.length) throw new Error(`Select at least ${comments.length} ready account(s) for ${comments.length} comments.`);
    const missing = requested.filter((name) => !readyByName.has(name));
    if (missing.length) throw new Error(`These accounts are not ready: ${missing.join(', ')}`);
    const repeated = requested.filter((name) => blocked.has(name));
    if (repeated.length) throw new Error(`These account(s) are already used or reserved for this reel/post: ${repeated.join(', ')}`);
    candidates = requested;
  } else {
    // Fair round-robin rotation: least recently used accounts first!
    candidates = getRotatedReadyAccounts(blocked);
    if (candidates.length < comments.length) {
      throw new Error(`Need ${comments.length} unused ready account(s) for this reel/post, but only ${candidates.length} are available.`);
    }
  }

  const assigned = candidates.slice(0, comments.length);

  const id = `comment_${Date.now()}_${++jobCounter}`;
  const createdAt = new Date().toISOString();
  const job = {
    id,
    status: 'queued',
    mode: 'single',
    postUrl: target.canonicalUrl,
    shortcode: target.shortcode,
    targetKey: target.targetKey,
    accountMode,
    createdAt,
    finishedAt: null,
    nextIndex: 0,
    staySeconds: COMMENT_STAY_MS / 1000,
    items: comments.map((entry, index) => ({
      index: index + 1,
      account: assigned[index],
      postUrl: target.canonicalUrl,
      shortcode: target.shortcode,
      targetKey: target.targetKey,
      comment: entry.text,
      gapMinutes: entry.gapMinutes,
      ok: false,
      status: 'queued',
      scheduledAt: index === 0 ? createdAt : null,
      startedAt: null,
      finishedAt: null,
      error: null,
    })),
  };
  jobs.set(id, job);
  persistJobs();
  runJob(job);
  return job;
}

function usageForTarget(postUrl) {
  const target = normalizeInstagramTarget(postUrl);
  const used = [...usedAccountsForTarget(target.targetKey)].sort();
  const reserved = [...reservedAccountsForTarget(target.targetKey)].sort();
  return { target, used, reserved };
}

function publicJob(job) {
  if (!job) return null;
  const clone = JSON.parse(JSON.stringify(job));
  delete clone._running;
  return clone;
}

loadJobs();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const route = url.pathname;

    if (route === '/' || route === '/index.html') return sendFile(res, path.join(PUBLIC, 'index.html'), 'text/html; charset=utf-8');
    if (route === '/app.js') return sendFile(res, path.join(PUBLIC, 'app.js'), 'text/javascript; charset=utf-8');
    if (route === '/styles.css') return sendFile(res, path.join(PUBLIC, 'styles.css'), 'text/css; charset=utf-8');

    if (route === '/api/accounts' && req.method === 'GET') {
      return sendJson(res, 200, { accounts: listAccounts() });
    }

    if (route === '/api/smm-info' && req.method === 'GET') {
      try {
        const smm = require('./smm-api.js');
        return sendJson(res, 200, smm.getSmmInfo());
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (route === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const username = cleanUsername(body.username);
      if (!username) return sendJson(res, 400, { ok: false, error: 'Enter an Instagram username/label.' });

      if (Object.prototype.hasOwnProperty.call(body, 'proxy') && String(body.proxy || '').trim()) {
        try {
          proxyConfig.setProxy(username, body.proxy);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: `Invalid proxy format: ${error.message}` });
        }
      } else {
        proxyConfig.getRawProxy(username); // ensures dedicated mobile proxy exists
      }

      const started = startLogin(username);
      return sendJson(res, started.ok ? 200 : 409, started);
    }

    if (route === '/api/login-status' && req.method === 'GET') {
      const username = cleanUsername(url.searchParams.get('username'));
      const file = accountFile(username);
      const active = activeLogins.get(username);

      if (fs.existsSync(file)) {
        const stats = fs.statSync(file);
        if (active && stats.mtimeMs >= (active.startTime || 0) - 2000) {
          activeLogins.delete(username);
          return sendJson(res, 200, { status: 'saved' });
        }
      }

      if (!active) {
        return sendJson(res, 200, { status: fs.existsSync(file) ? 'saved' : 'idle' });
      }

      if (Date.now() - (active.startTime || 0) > 15 * 60 * 1000) {
        activeLogins.delete(username);
        return sendJson(res, 200, { status: 'failed', error: 'Login timed out after 15 minutes.' });
      }

      return sendJson(res, 200, { status: 'window_open' });
    }

    if (route === '/api/account-proxy' && req.method === 'POST') {
      const body = await readBody(req);
      const username = cleanUsername(body.username);
      if (!username) return sendJson(res, 400, { ok: false, error: 'Missing account username.' });
      try {
        const result = body.clear === true ? proxyConfig.clearProxy(username) : proxyConfig.setProxy(username, body.proxy);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }

    if (route.startsWith('/api/accounts/') && req.method === 'DELETE') {
      const username = cleanUsername(decodeURIComponent(route.slice('/api/accounts/'.length)));
      if (!username) return sendJson(res, 400, { ok: false, error: 'Missing account username.' });
      try { fs.unlinkSync(accountFile(username)); } catch {}
      try { proxyConfig.clearProxy(username); } catch {}
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/reel-usage' && req.method === 'GET') {
      const postUrl = String(url.searchParams.get('postUrl') || '').trim();
      if (!postUrl) return sendJson(res, 200, { ok: true, usedAccounts: [], reservedAccounts: [] });
      try {
        const usage = usageForTarget(postUrl);
        return sendJson(res, 200, {
          ok: true,
          shortcode: usage.target.shortcode,
          usedAccounts: usage.used,
          reservedAccounts: usage.reserved,
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }

    if (route === '/api/comment-jobs' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const job = createCommentJob(body);
        return sendJson(res, 202, { ok: true, jobId: job.id, job: publicJob(job) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }

    if (route.startsWith('/api/comment-jobs/') && req.method === 'GET') {
      const id = decodeURIComponent(route.slice('/api/comment-jobs/'.length));
      const job = jobs.get(id);
      if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found.' });
      return sendJson(res, 200, { ok: true, job: publicJob(job) });
    }

    if (route.startsWith('/api/comment-jobs/') && route.endsWith('/cancel') && req.method === 'POST') {
      const id = decodeURIComponent(route.slice('/api/comment-jobs/'.length, -'/cancel'.length));
      const job = jobs.get(id);
      if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found.' });
      job.status = 'cancelled';
      persistJobs();
      return sendJson(res, 200, { ok: true, job: publicJob(job) });
    }

    return sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message || 'Server error.' });
  }
});

function openDashboard() {
  const url = `http://${HOST}:${PORT}`;
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

server.listen(PORT, HOST, () => {
  console.log(`Instagram Automation Server running at http://${HOST}:${PORT}`);
  openDashboard();
});

// ─── SMM Panel Provider API (isolated module, separate port) ───
try {
  require('./smm-api.js').start({ createCommentJob, runJob, jobs, listAccounts });
} catch (error) {
  console.error('[SMM_API] Failed to start:', error.message);
}
