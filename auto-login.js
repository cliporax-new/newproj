'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium, firefox } = require('playwright');
const proxyConfig = require('./proxy-config.js');

const ROOT = __dirname;
const ACCOUNTS_DIR = path.join(ROOT, 'accounts_instagram');

function base32Decode(base32) {
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  let hex = '';
  const cleanBase32 = (base32 || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  for (let i = 0; i < cleanBase32.length; i++) {
    const val = base32chars.indexOf(cleanBase32.charAt(i));
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    const chunk = bits.substr(i, 4);
    hex += parseInt(chunk, 2).toString(16);
  }
  return Buffer.from(hex, 'hex');
}

function generateTOTP(secret) {
  try {
    const cleanSecret = (secret || '').trim().replace(/\s+/g, '');
    if (/^\d{6}$/.test(cleanSecret)) return cleanSecret;
    const key = base32Decode(cleanSecret);
    const epoch = Math.floor(Date.now() / 1000);
    const time = Buffer.alloc(8);
    time.writeUInt32BE(Math.floor(epoch / 30), 4);

    const hmac = crypto.createHmac('sha1', key);
    hmac.update(time);
    const digest = hmac.digest();

    const offset = digest[digest.length - 1] & 0xf;
    const code = (
      ((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)
    ) % 1000000;

    return String(code).padStart(6, '0');
  } catch (e) {
    return null;
  }
}

async function fetch2faLiveFallback(secret) {
  try {
    const clean = (secret || '').trim().replace(/\s+/g, '');
    const res = await fetch(`https://2fa.live/tok/${encodeURIComponent(clean)}`, { timeout: 6000 });
    const data = await res.json();
    if (data && data.token && /^\d{6}$/.test(String(data.token))) {
      return String(data.token);
    }
  } catch {}
  return null;
}

function parseBulkAccounts(rawText) {
  if (!rawText) return [];
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const accounts = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Delimited by : or |
    if (line.includes(':') || line.includes('|')) {
      const delim = line.includes(':') ? ':' : '|';
      const parts = line.split(delim).map((p) => p.trim());
      if (parts.length >= 2 && parts[0] && parts[1]) {
        accounts.push({
          username: parts[0].replace(/^@/, '').trim().toLowerCase(),
          password: parts[1],
          twoFactorKey: parts.slice(2).join('').replace(/\s+/g, ''),
        });
        continue;
      }
    }

    // Space delimited
    const tokens = line.split(/\s+/);
    if (tokens.length >= 2) {
      accounts.push({
        username: tokens[0].replace(/^@/, '').trim().toLowerCase(),
        password: tokens[1],
        twoFactorKey: tokens.slice(2).join('').replace(/\s+/g, ''),
      });
    }
  }

  return accounts;
}

async function loginSingleAccount(acc, options = {}) {
  const useProxy = options.useProxy !== false;
  // Visible browser window by default so the user sees it open and type!
  const showBrowser = options.showBrowser !== false;

  const username = String(acc.username || '').trim().toLowerCase();
  const password = String(acc.password || '').trim();
  const twoFactorKey = String(acc.twoFactorKey || '').trim();

  if (!username || !password) {
    return { ok: false, username, error: 'Missing username or password' };
  }

  let proxy = null;
  if (useProxy) {
    proxy = proxyConfig.getPlaywrightProxy(username);
  }

  const useFirefox = options.browserEngine !== 'chromium';
  const engine = useFirefox ? firefox : chromium;

  const launchOpts = {
    headless: !showBrowser,
  };

  if (!useFirefox) {
    launchOpts.args = [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ];
  }

  if (proxy && proxy.server) {
    launchOpts.proxy = proxy;
  }

  let browser = null;
  let context = null;

  try {
    browser = await engine.launch(launchOpts);
    const contextOpts = useFirefox
      ? { viewport: { width: 1280, height: 800 } }
      : {
          viewport: null,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        };
    context = await browser.newContext(contextOpts);

    const page = await context.newPage();

    // 1. Navigate to Instagram Login
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2000);

    // Auto-dismiss cookies prompt
    try {
      const allowBtn = page.getByRole('button', { name: /allow all cookies|accept|decline optional/i });
      if (await allowBtn.first().isVisible({ timeout: 2000 })) {
        await allowBtn.first().click().catch(() => {});
      }
    } catch {}

    // 2. Landing page check (If splash screen shows "Log in" link/button, click it!)
    try {
      const loginLinks = page.locator('a[href*="/accounts/login/"], a:has-text("Log in"), button:has-text("Log in"), span:has-text("Log in")');
      if (await loginLinks.first().isVisible({ timeout: 3000 })) {
        await loginLinks.first().click().catch(() => {});
        await page.waitForTimeout(3000);
      }
    } catch {}

    // 3. Fill credentials (support standard Instagram + Meta Accounts Center fields)
    const userSelector = 'input[name="username"], input[name="email"], input[aria-label*="username"], input[aria-label*="Phone"], input[type="text"]';
    const passSelector = 'input[name="password"], input[name="pass"], input[aria-label*="password"], input[type="password"]';

    await page.waitForSelector(userSelector, { timeout: 20000 });
    const userInput = page.locator(userSelector).first();
    const passInput = page.locator(passSelector).first();

    await userInput.click();
    await userInput.fill(username);
    await page.waitForTimeout(600);

    await passInput.click();
    await passInput.fill(password);
    await page.waitForTimeout(600);

    // 4. Submit login - click Log In button ONCE (never double-submit with Enter + button click)
    try {
      const submitBtn = page.locator('button[type="submit"], button:has-text("Log in")').first();
      if (await submitBtn.isVisible({ timeout: 3000 })) {
        await submitBtn.click();
      } else {
        await passInput.press('Enter');
      }
    } catch {
      await passInput.press('Enter');
    }

    await page.waitForTimeout(4000);

    // 5. Wait for outcome after submitting login (poll up to 60s for slow connections)
    let is2FA = false;
    let loginSucceeded = false;
    const twoFaSpecificSelectors = [
      'input[name="verificationCode"]',
      'input[name="security_code"]',
      'input[name="approvals_code"]',
      'input[name="code"]',
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]',
      'input[type="tel"]',
      'input[placeholder*="Security code" i]',
      'input[placeholder*="Security Code" i]',
      'input[placeholder*="6-digit" i]',
      'input[placeholder*="code" i]',
      'input[aria-label*="Security code" i]',
      'input[aria-label*="Security Code" i]',
      'input[aria-label*="6-digit" i]',
      'input[aria-label*="code" i]',
      'input[maxlength="6"]',
      'input[maxlength="8"]',
    ];

    for (let c = 0; c < 40; c++) {
      await page.waitForTimeout(1500);

      // Check if session already exists (logged in without 2FA)
      const cookies = await context.cookies('https://www.instagram.com').catch(() => []);
      if (cookies.some((ck) => ck.name === 'sessionid' && ck.value)) {
        loginSucceeded = true;
        break;
      }

      const url = page.url();
      const pageText = await page.evaluate(() => (document.body ? document.body.innerText.toLowerCase() : '')).catch(() => '');

      // Check for incorrect credentials / errors
      if (pageText.includes('sorry, your password was incorrect') || pageText.includes('password you entered is incorrect')) {
        throw new Error('Incorrect password for this account.');
      }
      if (pageText.includes('please wait a few minutes before you try again')) {
        throw new Error('Instagram rate-limited login attempt. Try again in a few minutes.');
      }
      if (url.includes('/accounts/suspended') || pageText.includes('your account has been suspended')) {
        throw new Error('Instagram account is suspended.');
      }

      // Check if password field is GONE (meaning login form submitted and transitioned)
      const hasPasswordField = (await page.locator('input[type="password"], input[name="password"]').count().catch(() => 0)) > 0;

      // 2FA URL or text detection
      const is2faUrl =
        url.includes('/two_factor') ||
        url.includes('/two_step_verification') ||
        url.includes('/challenge') ||
        url.includes('/onetap') ||
        url.includes('/auth');
      const is2faText =
        pageText.includes('security code') ||
        pageText.includes('6-digit') ||
        pageText.includes('two-factor') ||
        pageText.includes('authentication app') ||
        pageText.includes('confirm it\'s you') ||
        pageText.includes('check your authentication');

      // Check if any specific 2FA field is visible
      let has2FaField = false;
      for (const sel of twoFaSpecificSelectors) {
        if (await page.locator(sel).first().isVisible().catch(() => false)) {
          has2FaField = true;
          break;
        }
      }

      // We are on 2FA if url/text matches or specific field is visible, AND we are NOT still on password input
      if ((is2faUrl || is2faText || has2FaField) && !hasPasswordField) {
        is2FA = true;
        break;
      }
    }

    if (is2FA && !loginSucceeded) {
      if (!twoFactorKey) {
        throw new Error('Account requires 2FA security code, but no 2FA key was provided.');
      }

      await page.waitForTimeout(1500);

      // Handle optional "Use authentication app" option if presented
      try {
        const authAppOption = page.locator('div:has-text("Authentication app"), span:has-text("Authentication app"), label:has-text("Authentication app")').first();
        if (await authAppOption.isVisible({ timeout: 2000 })) {
          await authAppOption.click().catch(() => {});
          await page.waitForTimeout(1000);
          const contBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]').first();
          if (await contBtn.isVisible({ timeout: 2000 })) {
            await contBtn.click().catch(() => {});
            await page.waitForTimeout(2000);
          }
        }
      } catch {}

      // Locate the 2FA input field
      let targetInput = null;
      for (const sel of twoFaSpecificSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          targetInput = loc;
          break;
        }
      }

      // Fallback: any visible input on this 2FA screen
      if (!targetInput) {
        const visibleInputs = page.locator('input:visible:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])');
        if ((await visibleInputs.count().catch(() => 0)) > 0) {
          targetInput = visibleInputs.first();
        }
      }

      if (!targetInput) {
        throw new Error('2FA screen detected, but could not locate security code input field.');
      }

      // Generate FRESH 6-digit TOTP right now
      let code = generateTOTP(twoFactorKey);
      if (!code) {
        code = await fetch2faLiveFallback(twoFactorKey);
      }
      if (!code) {
        throw new Error('Could not generate 6-digit TOTP code from 2FA key.');
      }

      console.log(`[2FA] Entering TOTP code ${code} for @${username}`);

      await targetInput.click();
      await targetInput.fill('');
      await targetInput.fill(code);
      await page.waitForTimeout(600);
      await targetInput.press('Enter');

      // Click Confirm/Submit/Continue button if present
      try {
        const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Submit"), button:has-text("Continue"), button:has-text("Log In"), button:has-text("Log in"), button[type="submit"]').first();
        if (await confirmBtn.isVisible({ timeout: 2000 })) {
          await confirmBtn.click().catch(() => {});
        }
      } catch {}

      // Optional: Trust this device prompt
      try {
        const trustBtn = page.locator('button:has-text("Trust this device"), button:has-text("Trust"), button:has-text("Confirm")').first();
        if (await trustBtn.isVisible({ timeout: 2000 })) {
          await trustBtn.click().catch(() => {});
        }
      } catch {}

      await page.waitForTimeout(5000);
    }

    // 6. Dismiss post-login dialogs (Save Info / Not Now)
    for (let d = 0; d < 3; d++) {
      try {
        const notNow = page.locator('button:has-text("Not Now"), button:has-text("Not now"), button:has-text("Save Info"), button:has-text("Save info"), button:has-text("Cancel")').first();
        if (await notNow.isVisible({ timeout: 2000 })) {
          await notNow.click().catch(() => {});
          await page.waitForTimeout(1000);
        }
      } catch {}
    }

    // 6. Verify and save session
    let sessionCookie = null;
    for (let w = 0; w < 12; w++) {
      const cookies = await context.cookies('https://www.instagram.com').catch(() => []);
      sessionCookie = cookies.find((c) => c.name === 'sessionid');
      if (sessionCookie && sessionCookie.value) break;

      try {
        const notNow = page.locator('button:has-text("Not Now"), button:has-text("Not now"), button:has-text("Save Info"), button:has-text("Save info"), button:has-text("Cancel")').first();
        if (await notNow.isVisible({ timeout: 1000 })) {
          await notNow.click().catch(() => {});
        }
      } catch {}

      await page.waitForTimeout(1500);
    }

    if (!sessionCookie || !sessionCookie.value) {
      // Check if suspended or checkpoint
      const currentUrl = page.url();
      if (currentUrl.includes('/accounts/suspended') || currentUrl.includes('/challenge')) {
        throw new Error('Account requires human verification / challenge on Instagram.');
      }
      throw new Error('Login failed: sessionid cookie not received. Check password or 2FA key.');
    }

    // Save storage state to accounts_instagram/<username>.json
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    const targetFile = path.join(ACCOUNTS_DIR, `${username}.json`);
    await context.storageState({ path: targetFile, indexedDB: true });

    return {
      ok: true,
      username,
      savedFile: targetFile,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    if (context) {
      try { await context.close(); } catch {}
      context = null;
    }
    if (browser) {
      try { await browser.close(); } catch {}
      browser = null;
    }

    let msg = err.message || 'Unknown error';
    if (useProxy && (msg.includes('ERR_PROXY_CONNECTION_FAILED') || msg.includes('ERR_TUNNEL_CONNECTION_FAILED') || msg.includes('Proxy unreachable'))) {
      console.log(`[PROXY_FALLBACK] Proxy unreachable on local PC/Wi-Fi, auto-retrying @${username} via direct connection...`);
      return loginSingleAccount(acc, { ...options, useProxy: false });
    }

    if (msg.includes('ERR_PROXY_CONNECTION_FAILED')) {
      msg = 'Proxy unreachable. Uncheck proxy or run on RDP.';
    }
    return {
      ok: false,
      username,
      error: msg,
      timestamp: new Date().toISOString(),
    };
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

// Global Bulk Login Queue State
const bulkLoginState = {
  running: false,
  total: 0,
  processed: 0,
  successful: 0,
  failed: 0,
  logs: [],
  startedAt: null,
  finishedAt: null,
};

async function runBulkLogin(accountsList, options = {}) {
  if (bulkLoginState.running) throw new Error('A bulk login queue is already currently running.');
  bulkLoginState.running = true;
  bulkLoginState.total = accountsList.length;
  bulkLoginState.processed = 0;
  bulkLoginState.successful = 0;
  bulkLoginState.failed = 0;
  bulkLoginState.logs = [];
  bulkLoginState.startedAt = new Date().toISOString();
  bulkLoginState.finishedAt = null;

  (async () => {
    try {
      for (let i = 0; i < accountsList.length; i++) {
        const acc = accountsList[i];
        const logPrefix = `[${i + 1}/${accountsList.length}] @${acc.username}`;

        bulkLoginState.logs.unshift({
          text: `${logPrefix}: Logging in via Playwright...`,
          type: 'info',
          time: new Date().toLocaleTimeString(),
        });

        const res = await loginSingleAccount(acc, options);
        bulkLoginState.processed++;

        if (res.ok) {
          bulkLoginState.successful++;
          bulkLoginState.logs.unshift({
            text: `${logPrefix}: ✅ Logged in successfully! Session saved.`,
            type: 'success',
            time: new Date().toLocaleTimeString(),
          });
        } else {
          bulkLoginState.failed++;
          bulkLoginState.logs.unshift({
            text: `${logPrefix}: ❌ Failed: ${res.error}`,
            type: 'error',
            time: new Date().toLocaleTimeString(),
          });
        }

        if (bulkLoginState.logs.length > 50) bulkLoginState.logs.pop();

        // Safe cooldown between accounts
        if (i < accountsList.length - 1) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    } finally {
      bulkLoginState.running = false;
      bulkLoginState.finishedAt = new Date().toISOString();
    }
  })().catch((err) => {
    bulkLoginState.running = false;
    bulkLoginState.logs.unshift({
      text: `Bulk login error: ${err.message}`,
      type: 'error',
      time: new Date().toLocaleTimeString(),
    });
  });

  return bulkLoginState;
}

module.exports = {
  generateTOTP,
  parseBulkAccounts,
  loginSingleAccount,
  runBulkLogin,
  getBulkLoginState: () => ({ ...bulkLoginState }),
};
