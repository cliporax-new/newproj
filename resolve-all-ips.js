'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { request } = require('playwright');
const { getPlaywrightProxy } = require('./proxy-config.js');

const ROOT = __dirname;
const ACCOUNTS_DIR = path.join(ROOT, 'accounts_instagram');
const DATA_DIR = path.join(ROOT, 'data');
const IP_FILE = path.join(DATA_DIR, 'account-ips.json');

async function resolveAllAccountIps() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let accountIps = {};
  try {
    accountIps = JSON.parse(fs.readFileSync(IP_FILE, 'utf8'));
  } catch {}

  const files = fs.readdirSync(ACCOUNTS_DIR).filter((f) => f.endsWith('.json'));
  console.log(`[IP_RESOLVER] Checking ${files.length} accounts...`);

  for (const file of files) {
    const username = file.replace(/\.json$/, '');
    if (accountIps[username] && accountIps[username].city) {
      console.log(`[IP_RESOLVER] @${username} already resolved: ${accountIps[username].city}, ${accountIps[username].region}`);
      continue;
    }

    try {
      console.log(`[IP_RESOLVER] Resolving IP for @${username}...`);
      const proxy = getPlaywrightProxy(username);
      const reqContext = await request.newContext({ proxy, timeout: 15000 });
      const res = await reqContext.get('http://ip-api.com/json');
      const data = await res.json();
      await reqContext.dispose();

      if (data && data.status === 'success') {
        accountIps[username] = {
          ip: data.query,
          country: data.country || 'India',
          countryCode: data.countryCode || 'IN',
          region: data.regionName || data.region,
          city: data.city,
          postal: data.zip,
          flag: '🇮🇳',
          isp: data.isp || 'Reliance Jio Infocomm Limited',
          org: data.org || data.isp,
          timezone: data.timezone || 'Asia/Kolkata',
          checkedAt: new Date().toISOString(),
        };
        console.log(`  -> @${username} resolved: ${data.city}, ${data.regionName} (${data.isp}) - ${data.query}`);
        fs.writeFileSync(IP_FILE, JSON.stringify(accountIps, null, 2), 'utf8');
      } else {
        console.log(`  -> @${username} failed: ${data && data.message}`);
      }
    } catch (err) {
      console.log(`  -> @${username} error: ${err.message}`);
    }

    // Small delay to be polite
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log('[IP_RESOLVER] Done! All accounts resolved.');
}

if (require.main === module) {
  resolveAllAccountIps().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { resolveAllAccountIps };
