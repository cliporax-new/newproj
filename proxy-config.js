'use strict';

// Dedicated Indian Mobile Proxy per Instagram account (DataImpulse)
// Each account gets a sticky, dedicated session IP via `sid.<username>` and `sessttl.30`.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PRIVATE_DIR = path.join(ROOT, 'data', 'private');
const FILE = path.join(PRIVATE_DIR, 'account-proxies.json');
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'socks5:']);

// DataImpulse Indian Mobile Proxy Credentials
const MOBILE_PROXY_CONFIG = {
  host: 'gw.dataimpulse.com',
  port: 823,
  userBase: 'a844ed1d40c5bc2f5509',
  country: 'cr.in',
  pass: '2c16140c92906bea',
  ttlMinutes: 30,
};

function clean(value) {
  return String(value || '').trim();
}

function cleanUserTag(username) {
  return clean(username).replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'acc';
}

function accountKey(username) {
  const user = clean(username);
  if (!user) throw new Error('Missing Instagram account username.');
  return `instagram:${user}`;
}

let proxyCache = null; // { mtimeMs, data }

function loadAll() {
  try {
    const stat = fs.statSync(FILE);
    if (proxyCache && proxyCache.mtimeMs === stat.mtimeMs) return { ...proxyCache.data };
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    proxyCache = { mtimeMs: stat.mtimeMs, data };
    return { ...data };
  } catch {
    return {};
  }
}

function saveAll(data) {
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch {}
  proxyCache = null;
}

function generateIndianMobileProxy(username) {
  const tag = cleanUserTag(username);
  const user = `${MOBILE_PROXY_CONFIG.userBase}__${MOBILE_PROXY_CONFIG.country};sid.${tag};sessttl.${MOBILE_PROXY_CONFIG.ttlMinutes}`;
  return `http://${user}:${MOBILE_PROXY_CONFIG.pass}@${MOBILE_PROXY_CONFIG.host}:${MOBILE_PROXY_CONFIG.port}`;
}

function parseProxy(rawValue) {
  let raw = clean(rawValue);
  if (!raw) return null;

  // Provider-friendly format: host:port:user:password
  if (!raw.includes('://') && !raw.includes('@')) {
    const parts = raw.split(':');
    if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
      const [host, port, username, ...passwordParts] = parts;
      raw = `http://${encodeURIComponent(username)}:${encodeURIComponent(passwordParts.join(':'))}@${host}:${port}`;
    } else {
      raw = `http://${raw}`;
    }
  } else if (!raw.includes('://')) {
    raw = `http://${raw}`;
  }

  let url;
  try { url = new URL(raw); }
  catch { throw new Error('Invalid proxy format.'); }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error('Proxy must use http://, https://, or socks5://.');
  }
  if (!url.hostname || !url.port || !/^\d+$/.test(url.port)) {
    throw new Error('Proxy must include host/IP and port.');
  }

  const port = Number(url.port);
  if (port < 1 || port > 65535) throw new Error('Proxy port must be between 1 and 65535.');

  const username = url.username ? decodeURIComponent(url.username) : '';
  const password = url.password ? decodeURIComponent(url.password) : '';
  const host = url.hostname.includes(':') ? `[${url.hostname.replace(/^\[|\]$/g, '')}]` : url.hostname;
  const server = `${url.protocol}//${host}:${url.port}`;

  let label = `${url.protocol.replace(':', '')}://${url.hostname}:${url.port}`;
  if (username && username.includes('sid.')) {
    const match = username.match(/sid\.([^;:]+)/);
    const sid = match ? match[1] : '';
    label = `Mobile IP (IN · sid:${sid})`;
  }

  return { server, username, password, label };
}

function getRawProxy(username) {
  const entry = loadAll()[accountKey(username)];
  if (entry && typeof entry.raw === 'string' && entry.raw.trim()) {
    return entry.raw.trim();
  }
  // Auto-generate and save dedicated mobile proxy for this account
  const autoProxy = generateIndianMobileProxy(username);
  setProxy(username, autoProxy);
  return autoProxy;
}

function getProxySummary(username) {
  const raw = getRawProxy(username);
  if (!raw) return { configured: false, label: null };
  try {
    return { configured: true, label: parseProxy(raw).label };
  } catch {
    return { configured: true, label: 'Indian Mobile Proxy' };
  }
}

function getPlaywrightProxy(username) {
  const raw = getRawProxy(username);
  if (!raw) return null;
  const parsed = parseProxy(raw);
  const proxy = { server: parsed.server };
  if (parsed.username) proxy.username = parsed.username;
  if (parsed.password) proxy.password = parsed.password;
  return proxy;
}

function setProxy(username, rawValue) {
  const parsed = parseProxy(rawValue);
  if (!parsed) throw new Error('Enter a proxy first.');
  const data = loadAll();
  data[accountKey(username)] = {
    raw: clean(rawValue),
    updatedAt: new Date().toISOString(),
  };
  saveAll(data);
  return { configured: true, label: parsed.label };
}

function clearProxy(username) {
  const data = loadAll();
  delete data[accountKey(username)];
  saveAll(data);
  return { configured: false, label: null };
}

module.exports = {
  FILE,
  MOBILE_PROXY_CONFIG,
  generateIndianMobileProxy,
  parseProxy,
  getRawProxy,
  getProxySummary,
  getPlaywrightProxy,
  setProxy,
  clearProxy,
};
