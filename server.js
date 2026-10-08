'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const proxyConfig = require('./proxy-config.js');
const autoLogin = require('./auto-login.js');

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
const TARGET_COOLDOWN_FILE = path.join(DATA_DIR, 'target-cooldown.json');
const ACCOUNT_COOLDOWN_FILE = path.join(DATA_DIR, 'account-cooldown.json');
const COMMENT_STAY_MS = 35000;
const REEL_MIN_GAP_MS = 5 * 60 * 1000; // 5 minutes minimum between comments on the SAME reel
const ACCOUNT_REST_MS = 5 * 60 * 1000; // fallback rest cooldown
const inFlightAccounts = new Set(); // tracks accounts currently in an active browser session

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

// Auto-resolve missing IPs in background on startup
try {
  const { resolveAllAccountIps } = require('./resolve-all-ips.js');
  setTimeout(() => {
    resolveAllAccountIps().catch(() => {});
  }, 2500);
} catch {}

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
  if (!fs.existsSync(file)) return;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Always clear sessionid so this account cannot be selected for commenting
    state.cookies = (state.cookies || []).filter((c) => c.name !== 'sessionid');
    state.sessionInvalidated = true;
    state.invalidatedAt = new Date().toISOString();

    if (status === 'suspended' || status === 'session_needs_attention' || status === 'checkpoint') {
      state.suspended = true;
      state.invalidationReason = reason || 'Suspended by Instagram (Human verification / challenge required)';
      console.log(`[SUSPENDED] Account @${username} was logged out and marked as SUSPENDED in UI.`);
    } else {
      state.suspended = false;
      state.invalidationReason = reason || 'Session expired (Re-login needed)';
      console.log(`[RELOGIN_NEEDED] Account @${username} was logged out and marked as RE-LOGIN NEEDED in UI.`);
    }

    writeJsonAtomic(file, state);
    accountHealthCache.delete(file);
  } catch (err) {
    console.error(`[ACCOUNT_STATUS_UPDATE] Failed to update @${username}:`, err.message);
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

async function verifyAccountLive(username) {
  const file = accountFile(username);
  if (!fs.existsSync(file)) return { username, status: 'missing', healthy: false };
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { username, status: 'corrupt', healthy: false };
  }

  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  const sessionCookie = cookies.find((c) => c.name === 'sessionid' && c.value);
  if (!sessionCookie) {
    handleAccountFailure(username, 'logged_out', 'Session cookie missing (Re-login needed)');
    return { username, status: 'logged_out', healthy: false };
  }

  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const csrf = cookies.find((c) => c.name === 'csrftoken')?.value || '';

  try {
    const res = await fetch('https://www.instagram.com/api/v1/accounts/edit/web_form_data/', {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'X-IG-App-ID': '936619743392459',
        'X-CSRFToken': csrf,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.instagram.com/accounts/edit/',
      },
    });

    const location = res.headers.get('location') || '';

    if (res.status === 200) {
      if (state.suspended || state.sessionInvalidated) {
        state.suspended = false;
        state.sessionInvalidated = false;
        state.invalidationReason = null;
        writeJsonAtomic(file, state);
        accountHealthCache.delete(file);
      }
      return { username, status: 'ready', healthy: true };
    }

    if (res.status === 302) {
      if (location.includes('suspended') || location.includes('challenge') || location.includes('checkpoint')) {
        handleAccountFailure(username, 'suspended', 'Suspended by Instagram (Human verification / challenge required)');
        return { username, status: 'suspended', healthy: false, location };
      }
      handleAccountFailure(username, 'logged_out', 'Session expired (Re-login needed)');
      return { username, status: 'logged_out', healthy: false, location };
    }

    if (res.status === 401) {
      handleAccountFailure(username, 'logged_out', 'Session expired (Re-login needed)');
      return { username, status: 'logged_out', healthy: false };
    }

    if (res.status === 400 || res.status === 403) {
      handleAccountFailure(username, 'suspended', 'Suspended or restricted by Instagram');
      return { username, status: 'suspended', healthy: false };
    }

    return { username, status: `http_${res.status}`, healthy: false };
  } catch (err) {
    return { username, status: 'network_error', error: err.message, healthy: !state.suspended && !state.sessionInvalidated };
  }
}

let isVerifyingAccounts = false;
async function verifyAllAccountsLive() {
  if (isVerifyingAccounts) return listAccounts();
  isVerifyingAccounts = true;
  console.log('[VERIFY_SESSIONS] Checking live session validity for all accounts...');
  try {
    const names = fs.existsSync(ACCOUNTS_DIR) ? fs.readdirSync(ACCOUNTS_DIR).filter((n) => n.endsWith('.json')) : [];
    for (const name of names) {
      const username = name.replace(/\.json$/, '');
      await verifyAccountLive(username);
    }
    console.log('[VERIFY_SESSIONS] Live session check completed.');
  } catch (err) {
    console.error('[VERIFY_SESSIONS] Error during session verification:', err.message);
  } finally {
    isVerifyingAccounts = false;
  }
  return listAccounts();
}


// ─── Account Usage, Fair Rotation & Cooldown Guards ───
let accountUsage = readJsonFile(USAGE_FILE, {});
let accountCooldown = readJsonFile(ACCOUNT_COOLDOWN_FILE, {});
let targetCooldown = readJsonFile(TARGET_COOLDOWN_FILE, {});

function recordAccountUsage(username) {
  const now = Date.now();
  accountUsage[username] = now;
  writeJsonAtomic(USAGE_FILE, accountUsage);

  // Random 4 to 10 minutes cooldown per account (zero ban / human-like safety)
  const randomMinutes = 4 + Math.random() * 6; // between 4.0 and 10.0 minutes
  const cooldownMs = Math.round(randomMinutes * 60 * 1000);
  accountCooldown[username] = now + cooldownMs;
  writeJsonAtomic(ACCOUNT_COOLDOWN_FILE, accountCooldown);
  console.log(`[COOLDOWN] Account @${username} resting for ${randomMinutes.toFixed(1)} minutes.`);
}

function getAccountRemainingCooldown(username) {
  const until = accountCooldown[username] || 0;
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

function recordTargetCommentTime(targetKey) {
  if (!targetKey || targetKey === 'multi') return;
  targetCooldown[targetKey] = Date.now();
  writeJsonAtomic(TARGET_COOLDOWN_FILE, targetCooldown);
}

function getTargetRemainingCooldown(targetKey) {
  if (!targetKey || targetKey === 'multi') return 0;
  const lastTime = targetCooldown[targetKey] || 0;
  if (!lastTime) return 0;
  const elapsed = Date.now() - lastTime;
  return Math.max(0, REEL_MIN_GAP_MS - elapsed);
}

function getRotatedReadyAccounts(blockedSet = new Set(), excludeAccounts = new Set()) {
  const ready = listAccounts().filter((a) => a.healthy);
  const candidates = ready
    .map((a) => a.username)
    .filter((name) => !blockedSet.has(name) && !excludeAccounts.has(name));

  // Sort ascending: least recently used accounts first (fair round-robin)
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
      const lastLine = output.trim() ? output.trim().split(/\r?\n/).filter(Boolean).pop() : '';
      resolve({
        ok: false,
        account: username,
        status: code === 0 ? 'unknown' : 'worker_failed',
        error: lastLine ? `Worker error: ${lastLine.slice(0, 300)}` : 'Comment worker ended without a readable result.',
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
          const gapMin = Number(item.gapMinutes) >= 0 ? Number(item.gapMinutes) : 5;
          item.scheduledAt = new Date(previousBase + Math.round(gapMin * 60000)).toISOString();
        }
        const waitMs = Date.parse(item.scheduledAt) - Date.now();
        if (waitMs > 0) {
          item.status = 'waiting';
          job.status = 'waiting';
          persistJobs();
          await sleep(waitMs);
        }
      }

      const targetUrl = item.postUrl || job.postUrl;
      const targetKey = item.targetKey || job.targetKey;

      // 1. Reel Guard: Enforce at least 5 minutes between comments on the SAME reel across all orders
      const reelRemainingMs = getTargetRemainingCooldown(targetKey);
      if (reelRemainingMs > 0) {
        console.log(`[REEL_GUARD] Target ${targetKey} commented recently. Waiting ${Math.round(reelRemainingMs / 1000)}s for 5m reel gap...`);
        item.status = 'waiting';
        job.status = 'waiting';
        persistJobs();
        await sleep(reelRemainingMs);
      }

      // 2. Safe Account Rest / Random 4-10m Cooldown Guard (Zero Ban Protection)
      const coolRemainingMs = getAccountRemainingCooldown(item.account);
      if (coolRemainingMs > 0) {
        const blocked = usedAccountsForTarget(targetKey);
        const candidates = getRotatedReadyAccounts(blocked, new Set([item.account]));
        const restedCandidate = candidates.find((acc) => getAccountRemainingCooldown(acc) === 0);

        if (restedCandidate && job.accountMode === 'auto') {
          console.log(`[REST_GUARD] Account @${item.account} cooling down. Rotating to rested account @${restedCandidate}`);
          item.account = restedCandidate;
          persistJobs();
        } else {
          console.log(`[REST_GUARD] Account @${item.account} cooling down. Waiting ${Math.round(coolRemainingMs / 1000)}s...`);
          item.status = 'waiting';
          job.status = 'waiting';
          persistJobs();
          await sleep(coolRemainingMs);
        }
      }

      // Check if account is currently healthy; if not, auto-replace with a fresh healthy account
      const readyAccounts = listAccounts().filter((a) => a.healthy);
      const isHealthy = readyAccounts.some((a) => a.username === item.account);
      if (!isHealthy && job.accountMode === 'auto') {
        const blocked = usedAccountsForTarget(targetKey);
        const candidates = getRotatedReadyAccounts(blocked, new Set([item.account]));
        const replacement = candidates.find((acc) => getAccountRemainingCooldown(acc) === 0) || candidates[0];
        if (replacement) {
          console.log(`[FAILOVER_GUARD] Account @${item.account} is not ready. Auto-replacing with @${replacement}`);
          item.account = replacement;
          persistJobs();
        }
      }

      // Concurrency guard: if this account is currently running in another browser, wait or switch
      if (inFlightAccounts.has(item.account)) {
        if (job.accountMode === 'auto') {
          const blocked = usedAccountsForTarget(targetKey);
          for (const a of inFlightAccounts) blocked.add(a);
          const candidates = getRotatedReadyAccounts(blocked);
          const freeCandidate = candidates.find((acc) => getAccountRemainingCooldown(acc) === 0) || candidates[0];
          if (freeCandidate && !inFlightAccounts.has(freeCandidate)) {
            console.log(`[CONCURRENCY] Account @${item.account} busy in another task. Switching to free account @${freeCandidate}`);
            item.account = freeCandidate;
            persistJobs();
          } else {
            while (inFlightAccounts.has(item.account)) {
              await sleep(1500);
            }
          }
        } else {
          while (inFlightAccounts.has(item.account)) {
            await sleep(1500);
          }
        }
      }

      job.status = 'running';
      item.status = 'running';
      item.startedAt = new Date().toISOString();
      item.error = null;
      persistJobs();

      inFlightAccounts.add(item.account);
      let outcome;
      try {
        outcome = await spawnComment(item.account, targetUrl, item.comment);
      } finally {
        inFlightAccounts.delete(item.account);
      }
      Object.assign(item, outcome, { finishedAt: new Date().toISOString() });

      if (outcome.ok === true || ['uncertain', 'uncertain_after_restart'].includes(outcome.status)) {
        markAccountUsed(targetKey, item.account, { status: outcome.status, jobId: job.id });
        recordAccountUsage(item.account);
        recordTargetCommentTime(targetKey);
      } else if (['session_needs_attention', 'suspended', 'checkpoint', 'logged_out'].includes(outcome.status)) {
        handleAccountFailure(item.account, outcome.status, outcome.error);

        // Auto-failover: immediately retry with an active account so the queue never stops!
        if (job.accountMode === 'auto') {
          const blocked = usedAccountsForTarget(targetKey);
          for (let k = 0; k < job.items.length; k++) {
            if (job.items[k].account) blocked.add(job.items[k].account);
          }
          const candidates = getRotatedReadyAccounts(blocked);
          const replacement = candidates.find((acc) => getAccountRemainingCooldown(acc) === 0 && !inFlightAccounts.has(acc)) || candidates[0];
          if (replacement) {
            console.log(`[AUTO_FAILOVER] Retrying comment with active account @${replacement}...`);
            item.account = replacement;
            item.status = 'running';
            persistJobs();

            inFlightAccounts.add(item.account);
            let retryOutcome;
            try {
              retryOutcome = await spawnComment(item.account, targetUrl, item.comment);
            } finally {
              inFlightAccounts.delete(item.account);
            }
            Object.assign(item, retryOutcome, { finishedAt: new Date().toISOString() });
            if (retryOutcome.ok === true || ['uncertain', 'uncertain_after_restart'].includes(retryOutcome.status)) {
              markAccountUsed(targetKey, item.account, { status: retryOutcome.status, jobId: job.id });
              recordAccountUsage(item.account);
              recordTargetCommentTime(targetKey);
            }
          }
        }
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
  if (raw.length > 100) throw new Error('A single job can contain up to 100 comments.');
  const comments = raw.map((item, index) => {
    const text = String(item && item.text || '').trim();
    if (!text) throw new Error(`Comment ${index + 1} is empty.`);
    if (text.length > 1000) throw new Error(`Comment ${index + 1} must be 1000 characters or fewer.`);
    let gapMinutes = index === 0 ? 0 : Number(item && item.gapMinutes);
    if (!Number.isFinite(gapMinutes) || gapMinutes <= 0) gapMinutes = 5;
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
    if (lines.length > 100) throw new Error('A single queue can contain up to 100 lines.');

    const defaultGap = Number(body.gapMinutes) >= 0 ? Number(body.gapMinutes) : 5;
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
        const ready = listAccounts().filter((a) => a.healthy);
        if (!ready.length) throw new Error('No ready accounts available.');
        available = ready.map((a) => a.username);
        available.sort((a, b) => (accountUsage[a] || 0) - (accountUsage[b] || 0));
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
    if (!candidates.length) {
      // If all healthy accounts have already commented on this post, allow recycling ready accounts
      candidates = ready.map((a) => a.username);
      candidates.sort((a, b) => (accountUsage[a] || 0) - (accountUsage[b] || 0));
    }
    if (!candidates.length) {
      throw new Error('No ready accounts available.');
    }
  }

  // Cycle assignment: if comments.length > candidates.length, wrap around!
  // e.g. 40 comments with 30 accounts -> uses all 30 accounts, then wraps around to the first 10 accounts!
  const assigned = [];
  for (let i = 0; i < comments.length; i++) {
    assigned.push(candidates[i % candidates.length]);
  }

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

function getActivitySummary() {
  const allJobs = [...jobs.values()]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  let totalCommentsPosted = 0;
  let activeCount = 0;
  let completedCount = 0;
  const seenSmmOrderIds = new Set();
  const seenJobIds = new Set();

  const formattedJobs = allJobs.slice(0, 50).map((job) => {
    seenJobIds.add(job.id);
    if (job.smmOrderId) seenSmmOrderIds.add(String(job.smmOrderId));

    const items = job.items || [];
    const posted = items.filter((it) => it.ok || it.status === 'posted').length;
    const running = items.filter((it) => it.status === 'running').length;
    const isCompleted = ['completed', 'completed_with_errors'].includes(job.status);
    const isActive = ['running', 'waiting', 'queued'].includes(job.status);

    totalCommentsPosted += posted;
    if (isCompleted) completedCount++;
    if (isActive) activeCount++;

    return {
      id: job.id,
      orderNumber: job.smmOrderId ? `#${job.smmOrderId}` : job.id.replace(/^comment_/, ''),
      source: job.source || (job.smmOrderId ? 'smm' : 'manual'),
      postUrl: job.postUrl,
      shortcode: job.shortcode || 'reel',
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      totalComments: items.length,
      postedComments: posted,
      runningComments: running,
      items: items.map((it) => ({
        index: it.index,
        account: it.account,
        comment: it.comment,
        status: it.status,
        ok: it.ok,
        error: it.error,
        finishedAt: it.finishedAt || it.startedAt,
      })),
    };
  });

  // Check smm-orders.json for pending or unlinked SMM orders
  const smmOrdersFile = path.join(DATA_DIR, 'smm-orders.json');
  const smmStore = readJsonFile(smmOrdersFile, null);
  const extraSmmOrders = [];
  if (smmStore && smmStore.orders) {
    for (const [id, ord] of Object.entries(smmStore.orders)) {
      if (seenSmmOrderIds.has(String(id)) || (ord.jobId && seenJobIds.has(ord.jobId))) {
        continue;
      }
      const isPending = ord.state === 'pending';
      const isRunning = ord.state === 'running';
      const isDone = ['completed', 'partial'].includes(ord.state) || ord.final;
      if (isPending || isRunning) activeCount++;
      if (isDone) completedCount++;
      totalCommentsPosted += (ord.posted || 0);

      extraSmmOrders.push({
        id: ord.jobId || `smm_${id}`,
        orderNumber: `#${id}`,
        source: 'smm',
        postUrl: ord.link,
        shortcode: 'reel',
        status: isPending ? 'queued' : (ord.jobStatus || ord.state),
        createdAt: ord.createdAt,
        finishedAt: ord.finishedAt || null,
        totalComments: ord.quantity || (ord.comments || []).length,
        postedComments: ord.posted || 0,
        runningComments: isRunning ? 1 : 0,
        waitReason: ord.waitReason || null,
        items: (ord.comments || []).map((text, idx) => ({
          index: idx + 1,
          account: 'Auto-assigned',
          comment: text,
          status: isPending ? 'queued' : (idx < (ord.posted || 0) ? 'posted' : 'waiting'),
          ok: idx < (ord.posted || 0),
        })),
      });
    }
  }

  const allOrders = [...extraSmmOrders, ...formattedJobs]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  return {
    ok: true,
    stats: {
      totalOrders: allOrders.length,
      activeOrders: activeCount,
      completedOrders: completedCount,
      totalCommentsPosted,
    },
    orders: allOrders.slice(0, 50),
  };
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

    if (route === '/api/accounts/verify-all' && (req.method === 'POST' || req.method === 'GET')) {
      const accounts = await verifyAllAccountsLive();
      const readyCount = accounts.filter((a) => a.healthy).length;
      const deadCount = accounts.length - readyCount;
      return sendJson(res, 200, { ok: true, accounts, readyCount, deadCount });
    }

    if ((route === '/api/activity' || route === '/api/comment-jobs') && req.method === 'GET') {
      return sendJson(res, 200, getActivitySummary());
    }

    if (route === '/api/smm-info' && req.method === 'GET') {
      try {
        const smm = require('./smm-api.js');
        return sendJson(res, 200, smm.getSmmInfo());
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // Bulk Auto-Login endpoint (username:password:2FA)
    if (route === '/api/accounts/bulk-auto-login' && req.method === 'POST') {
      const body = await readBody(req);
      const rawText = String(body.text || '');
      const parsed = autoLogin.parseBulkAccounts(rawText);
      if (!parsed.length) {
        return sendJson(res, 400, { ok: false, error: 'No valid accounts found. Enter format: username:password:2FA_KEY (one per line).' });
      }
      try {
        const state = await autoLogin.runBulkLogin(parsed, {
          useProxy: body.useProxy !== false,
          showBrowser: body.showBrowser === true,
        });
        return sendJson(res, 202, { ok: true, count: parsed.length, state });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // Bulk Auto-Login live status
    if (route === '/api/accounts/bulk-auto-login-status' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, state: autoLogin.getBulkLoginState() });
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

    if (route === '/api/accounts/remove-suspended' && req.method === 'POST') {
      const all = listAccounts();
      const removed = [];
      for (const acc of all) {
        if (acc.accountStatus === 'suspended') {
          try { fs.unlinkSync(accountFile(acc.username)); } catch {}
          try { proxyConfig.clearProxy(acc.username); } catch {}
          accountHealthCache.delete(accountFile(acc.username));
          removed.push(acc.username);
        }
      }
      return sendJson(res, 200, { ok: true, removedCount: removed.length, removed });
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
  setTimeout(() => {
    verifyAllAccountsLive().catch((e) => console.error('[VERIFY_STARTUP_ERR]', e.message));
  }, 4000);
  setInterval(() => {
    verifyAllAccountsLive().catch((e) => console.error('[VERIFY_INTERVAL_ERR]', e.message));
  }, 15 * 60 * 1000);
});

// ─── SMM Panel Provider API (isolated module, separate port) ───
try {
  require('./smm-api.js').start({ createCommentJob, runJob, jobs, listAccounts });
} catch (error) {
  console.error('[SMM_API] Failed to start:', error.message);
}
