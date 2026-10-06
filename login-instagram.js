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
