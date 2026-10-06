'use strict';

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { getPlaywrightProxy } = require('./proxy-config.js');

const username = String(process.argv[2] || '').trim();
const accountsDir = String(process.argv[3] || '').trim();

if (!username || !accountsDir) {
  process.exit(1);
}

const authFile = path.join(accountsDir, `${username}.json`);
fs.mkdirSync(accountsDir, { recursive: true });
const MAX_WAIT_MS = 15 * 60 * 1000; // 15 minutes

(async () => {
  const proxy = getPlaywrightProxy(username);

  const browser = await chromium.launch({
    headless: false,
    proxy: proxy || undefined,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  await page.bringToFront().catch(() => {});

  try {
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'commit',
      timeout: 30000,
    });
  } catch (err) {
    // Page renders progressively
  }

  // Keep browser window open and monitor for user login
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (browser.contexts().length === 0 || context.pages().length === 0) {
      process.exit(1);
    }

    const cookies = await context.cookies('https://www.instagram.com').catch(() => []);
    const hasSession = cookies.some((c) => c.name === 'sessionid' && c.value);
    const hasUser = cookies.some((c) => c.name === 'ds_user_id' && c.value);

    if (hasSession && hasUser) {
      await page.waitForTimeout(2000);
      await context.storageState({ path: authFile, indexedDB: true });

      // Automatically fetch and record real proxy IP, location, and ISP details
      try {
        const ipPage = await context.newPage();
        const ipRes = await ipPage.goto('http://ip-api.com/json', { timeout: 10000 });
        if (ipRes && ipRes.ok()) {
          const bodyText = await ipPage.textContent('body');
          const data = JSON.parse(bodyText || '{}');
          if (data && data.status === 'success') {
            const ipFile = path.join(path.dirname(accountsDir), 'data', 'account-ips.json');
            let currentIps = {};
            try { currentIps = JSON.parse(fs.readFileSync(ipFile, 'utf8')); } catch {}
            currentIps[username] = {
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
            fs.mkdirSync(path.dirname(ipFile), { recursive: true });
            fs.writeFileSync(ipFile, JSON.stringify(currentIps, null, 2), 'utf8');
          }
        }
        await ipPage.close().catch(() => {});
      } catch {}

      await page.waitForTimeout(1000);
      await browser.close().catch(() => {});
      process.exit(0);
    }

    await page.waitForTimeout(1000);
  }

  await browser.close().catch(() => {});
  process.exit(1);
})().catch(() => {
  process.exit(1);
});
