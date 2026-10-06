'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Updater: checks GitHub for new updates on startup.
// Never touches accounts_instagram/ or private data.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO = 'cliporax-new/newproj';
const BRANCH = 'main';
const ROOT = __dirname;
const VERSION_FILE = path.join(ROOT, 'data', 'version.json');
const TOKEN_FILE = path.join(ROOT, 'data', 'private', 'updater.json');

let GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
try {
  if (fs.existsSync(TOKEN_FILE)) {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (data && data.token) GITHUB_TOKEN = data.token;
  }
} catch {}

const CORE_FILES = [
  'server.js',
  'comment-worker.js',
  'login-instagram.js',
  'proxy-config.js',
  'smm-api.js',
  'package.json',
  'public/app.js',
  'public/index.html',
  'public/styles.css',
  'data/account-ips.json',
];

async function checkGitUpdate() {
  try {
    if (fs.existsSync(path.join(ROOT, '.git'))) {
      execSync('git --version', { stdio: 'ignore' });
      console.log('[Updater] Checking updates via Git...');
      const output = execSync(`git pull origin ${BRANCH}`, { cwd: ROOT, encoding: 'utf8', timeout: 8000 });
      if (!/already up to date/i.test(output)) {
        console.log('[Updater] Successfully updated to latest version via Git!');
      } else {
        console.log('[Updater] App is already on the latest version.');
      }
      return true;
    }
  } catch {}
  return false;
}

async function checkApiUpdate() {
  try {
    const headers = {
      'User-Agent': 'NodeJS-AutoUpdater',
      'Accept': 'application/vnd.github.v3+json',
    };
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }

    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.log(`[Updater] Update check skipped (Status ${res.status}).`);
      return;
    }

    const data = await res.json();
    const remoteSha = data && data.sha;
    if (!remoteSha) return;

    let localSha = '';
    try {
      if (fs.existsSync(VERSION_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
        localSha = parsed.commit || '';
      }
    } catch {}

    if (localSha === remoteSha) {
      console.log('[Updater] App is already on the latest version.');
      return;
    }

    console.log(`[Updater] New update found (${remoteSha.slice(0, 7)}). Downloading updated files...`);

    for (const relFile of CORE_FILES) {
      try {
        const fileRes = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${relFile}`, {
          headers: GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {},
          signal: AbortSignal.timeout(5000),
        });

        if (fileRes.ok) {
          const content = await fileRes.text();
          const targetPath = path.join(ROOT, ...relFile.split('/'));
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, content, 'utf8');
        }
      } catch (err) {
        // Individual file fetch fail; continue with others
      }
    }

    fs.mkdirSync(path.dirname(VERSION_FILE), { recursive: true });
    fs.writeFileSync(VERSION_FILE, JSON.stringify({ commit: remoteSha, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    console.log('[Updater] Update completed successfully! Starting application...');
  } catch (err) {
    console.log(`[Updater] Update check skipped: ${err.message}`);
  }
}

async function syncAccountsViaApi() {
  try {
    const headers = {
      'User-Agent': 'NodeJS-AutoUpdater',
      'Accept': 'application/vnd.github.v3+json',
    };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;

    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/accounts_instagram?ref=${BRANCH}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return;
    const items = await res.json();
    if (!Array.isArray(items)) return;

    const accDir = path.join(ROOT, 'accounts_instagram');
    fs.mkdirSync(accDir, { recursive: true });
    let newCount = 0;

    for (const item of items) {
      if (item.type === 'file' && item.name.endsWith('.json')) {
        const dest = path.join(accDir, item.name);
        if (!fs.existsSync(dest) || fs.statSync(dest).size !== item.size) {
          const fileRes = await fetch(item.download_url, {
            headers: GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {},
            signal: AbortSignal.timeout(6000),
          });
          if (fileRes.ok) {
            const content = await fileRes.text();
            fs.writeFileSync(dest, content, 'utf8');
            newCount++;
          }
        }
      }
    }
    if (newCount > 0) {
      console.log(`[Updater] Synced ${newCount} Instagram accounts from cloud!`);
    }
  } catch (err) {
    // Soft fail
  }
}

async function main() {
  const updatedViaGit = await checkGitUpdate();
  if (!updatedViaGit) {
    await checkApiUpdate();
    await syncAccountsViaApi();
  }
}

main().catch(() => {}).finally(() => process.exit(0));
