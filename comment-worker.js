'use strict';

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { getPlaywrightProxy } = require('./proxy-config.js');

const username = String(process.env.COMMENT_ACCOUNT || '').trim();
const authFile = String(process.env.COMMENT_AUTH_FILE || '').trim();
const rawPostUrl = String(process.env.COMMENT_POST_URL || '').trim();
const commentText = String(process.env.COMMENT_TEXT || '').trim();
const artifactsRoot = path.join(__dirname, 'artifacts');
const requestedStayMs = Number(process.env.COMMENT_STAY_MS || 35000);
const stayMs = Math.max(30000, Math.min(120000, Number.isFinite(requestedStayMs) ? requestedStayMs : 35000));

function result(payload) {
  console.log(`COMMENT_RESULT:${JSON.stringify(payload)}`);
}

function normalizeInstagramUrl(value) {
  const url = new URL(value);
  if (!/(^|\.)instagram\.com$/i.test(url.hostname)) {
    throw new Error('URL must use instagram.com.');
  }
  const match = url.pathname.match(/^\/(p|reel|reels|tv)\/([^/]+)/i);
  if (!match) throw new Error('Use a direct Instagram post or reel URL.');
  return `https://www.instagram.com/p/${match[2]}/`;
}

async function firstVisible(locators, timeout = 1500) {
  for (const locator of locators) {
    try {
      const first = locator.first();
      if (await first.isVisible({ timeout })) return first;
    } catch {}
  }
  return null;
}

async function hasSessionCookie(context) {
  const cookies = await context.cookies('https://www.instagram.com').catch(() => []);
  return cookies.some((c) => c.name === 'sessionid' && c.value);
}

async function isLoginUiVisible(page) {
  const url = page.url();
  if (url.includes('/accounts/login')) return true;
  return Boolean(await firstVisible([
    page.locator('input[name="username"]'),
    page.locator('input[name="password"]'),
    page.getByRole('heading', { name: /log in to instagram/i }),
    page.getByText(/log in to like or comment/i),
  ], 800));
}

async function isSuspended(page) {
  const url = page.url();
  if (/suspended|disabled|terms\/unblock/i.test(url)) return true;
  return Boolean(await firstVisible([
    page.getByText(/we suspended your account/i),
    page.getByText(/your account has been disabled/i),
    page.getByText(/account suspended/i),
    page.getByText(/your account has been locked/i),
  ], 800));
}

async function needsAttention(page) {
  const url = page.url();
  if (/checkpoint|challenge|suspended|disabled|terms\/unblock/i.test(url)) return true;
  return Boolean(await firstVisible([
    page.getByText(/confirm it'?s you/i),
    page.getByText(/suspicious login/i),
    page.getByText(/security code/i),
    page.getByText(/challenge required/i),
    page.getByText(/we suspended your account/i),
    page.getByText(/your account has been disabled/i),
    page.getByText(/account suspended/i),
    page.getByText(/help us confirm you own this account/i),
    page.getByText(/your account was compromised/i),
  ], 800));
}

async function dismissCommonDialog(page) {
  for (let i = 0; i < 4; i += 1) {
    const button = await firstVisible([
      page.getByRole('button', { name: /^not now$/i }),
      page.getByRole('button', { name: /^cancel$/i }),
      page.getByRole('button', { name: /decline optional cookies/i }),
      page.getByRole('button', { name: /allow all cookies/i }),
      page.getByRole('button', { name: /^close$/i }),
    ], 500);
    if (!button) break;
    await button.click().catch(() => {});
    await page.waitForTimeout(250);
  }
}

function commentBoxLocators(page) {
  return [
    page.locator('textarea[aria-label*="add a comment" i]'),
    page.locator('textarea[placeholder*="add a comment" i]'),
    page.locator('textarea[aria-label*="comment" i]'),
    page.locator('textarea[placeholder*="comment" i]'),
    page.locator('input[placeholder*="add a comment" i]'),
    page.locator('input[placeholder*="comment" i]'),
    page.locator('input[aria-label*="comment" i]'),
    page.locator('[contenteditable="true"][role="textbox"][aria-label*="comment" i]'),
    page.locator('[contenteditable="true"][role="textbox"]'),
    page.locator('form textarea'),
    page.locator('form [contenteditable="true"]'),
    page.locator('form input[type="text"]'),
    page.locator('[contenteditable="true"]'),
  ];
}

async function tryCommentBox(page, timeout = 1500) {
  for (const locator of commentBoxLocators(page)) {
    try {
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const item = locator.nth(i);
        if (await item.isVisible({ timeout: 300 }).catch(() => false)) {
          const ariaLabel = (await item.getAttribute('aria-label').catch(() => '')) || '';
          const placeholder = (await item.getAttribute('placeholder').catch(() => '')) || '';
          if (/search/i.test(ariaLabel) || /search/i.test(placeholder)) continue;
          return item;
        }
      }
    } catch {}
  }
  return null;
}

async function openCommentsPanel(page) {
  const candidates = [
    page.locator('svg[aria-label="Comment"], svg[aria-label="Comments"]').first(),
    page.getByRole('button', { name: /^comments?$/i }),
    page.getByRole('button', { name: /view comments?/i }),
    page.locator('button:has(svg[aria-label*="comment" i])'),
    page.locator('[role="button"]:has(svg[aria-label*="comment" i])'),
    page.getByText(/view all .* comments?/i),
    page.getByText(/view .* comments?/i),
  ];
  for (const candidate of candidates) {
    try {
      const first = candidate.first();
      if (await first.isVisible({ timeout: 1500 })) {
        await first.click({ timeout: 3000, force: true }).catch(() => {});
        await page.waitForTimeout(1200);
        if (await tryCommentBox(page, 2000)) return true;
      }
    } catch {}
  }
  return false;
}

async function waitForPostPageReady(page, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isSuspended(page)) return { status: 'suspended' };
    if (await needsAttention(page)) return { status: 'checkpoint' };
    if (await isLoginUiVisible(page)) return { status: 'logged_out' };

    const unavailable = await firstVisible([
      page.getByText(/sorry, this page isn't available/i),
      page.getByText(/the link you followed may be broken/i),
    ], 300);
    if (unavailable) return { status: 'unavailable' };

    const disabled = await firstVisible([
      page.getByText(/comments on this post have been limited/i),
      page.getByText(/comments are turned off/i),
      page.getByText(/comments have been turned off/i),
    ], 300);
    if (disabled) return { status: 'comments_disabled' };

    await dismissCommonDialog(page);

    // Look for actual post content (NOT the outer main container shell!)
    const content = await firstVisible([
      page.locator('article'),
      page.locator('svg[aria-label="Comment"], svg[aria-label="Comments"]'),
      page.locator('button:has(svg[aria-label*="comment" i])'),
      page.locator('[role="button"]:has(svg[aria-label*="comment" i])'),
      page.locator('textarea[placeholder*="comment" i]'),
      page.locator('textarea[aria-label*="comment" i]'),
      page.locator('[contenteditable="true"][role="textbox"]'),
    ], 800);

    if (content) {
      await page.waitForTimeout(2000);
      return { status: 'ready' };
    }

    await page.waitForTimeout(1000);
  }
  return { status: 'timeout' };
}

async function findCommentBox(page) {
  // Step 1: Patiently wait up to 35 seconds for actual post elements (past loading spinner)
  const postLocators = [
    page.locator('article'),
    page.locator('svg[aria-label="Comment"], svg[aria-label="Comments"]'),
    page.locator('textarea[placeholder*="comment" i]'),
    page.locator('textarea[aria-label*="comment" i]'),
    page.locator('[contenteditable="true"][role="textbox"]'),
  ];
  const postWaitDeadline = Date.now() + 35000;
  while (Date.now() < postWaitDeadline) {
    let anyVisible = false;
    for (const loc of postLocators) {
      if (await loc.first().isVisible({ timeout: 400 }).catch(() => false)) {
        anyVisible = true;
        break;
      }
    }
    if (anyVisible) break;
    await dismissCommonDialog(page);
    await page.waitForTimeout(1000);
  }

  // Step 2: Try finding comment box directly
  let box = await tryCommentBox(page, 3000);
  if (box) return box;

  // Step 3: Open comments panel/drawer if it's a reel or collapsed post
  await openCommentsPanel(page);

  // Step 4: Try finding comment box with scrolling
  for (let i = 0; i < 10; i += 1) {
    box = await tryCommentBox(page, 1500);
    if (box) return box;
    await page.mouse.wheel(0, 350).catch(() => {});
    await page.waitForTimeout(800);
  }

  // Step 5: Fallback - try clicking comment icon explicitly
  const commentIcon = await firstVisible([
    page.locator('svg[aria-label="Comment"], svg[aria-label="Comments"]'),
    page.locator('button:has(svg[aria-label*="comment" i])'),
    page.locator('[role="button"]:has(svg[aria-label*="comment" i])'),
  ], 1500);
  if (commentIcon) {
    await commentIcon.click({ timeout: 2000, force: true }).catch(() => {});
    await page.waitForTimeout(1500);
    box = await tryCommentBox(page, 2000);
    if (box) return box;
  }

  return null;
}

async function fillLocator(locator, text) {
  const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'textarea' || tag === 'input') {
    await locator.fill(text);
    return;
  }
  await locator.click();
  await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await locator.fill(text).catch(async () => {
    await locator.evaluate((el, value) => {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }, text);
  });
}

async function isCommentBoxEmpty(locator) {
  try {
    const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'textarea' || tag === 'input') {
      return ((await locator.inputValue().catch(() => '')) || '').trim() === '';
    }
    return (((await locator.textContent().catch(() => '')) || '').trim() === '');
  } catch {
    return true;
  }
}

async function findPostButton(page) {
  return firstVisible([
    page.getByRole('button', { name: /^post$/i }),
    page.locator('button:has-text("Post")'),
  ], 1400);
}

async function commentTextVisible(page, text) {
  try {
    const locator = page.getByText(text, { exact: true });
    const count = Math.min(await locator.count(), 10);
    for (let i = 0; i < count; i += 1) {
      if (await locator.nth(i).isVisible({ timeout: 200 }).catch(() => false)) return true;
    }
  } catch {}
  return false;
}

async function submitComment(page, box, text) {
  let networkConfirmed = false;
  const responseHandler = async (response) => {
    try {
      if (response.request().method() !== 'POST') return;
      const request = response.request();
      const postData = String(request.postData() || '');
      const url = String(response.url() || '');
      if (/comment/i.test(url) || /comment_text|create_comment|xdt_create_comment/i.test(postData) || postData.includes(text)) {
        if (response.ok()) networkConfirmed = true;
      }
    } catch {}
  };
  page.on('response', responseHandler);

  try {
    const postButton = await findPostButton(page);
    if (postButton) await postButton.click({ timeout: 3500 });
    else await box.press('Enter');

    const deadline = Date.now() + 25000;
    let emptyChecks = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      if (networkConfirmed) return 'posted';
      if (await commentTextVisible(page, text)) return 'posted';
      if (await isCommentBoxEmpty(box)) {
        emptyChecks += 1;
        if (emptyChecks >= 2) return 'posted';
      } else {
        emptyChecks = 0;
      }
      if (await needsAttention(page) || await isSuspended(page)) return 'session_needs_attention';
    }
    return 'uncertain';
  } finally {
    page.off('response', responseHandler);
  }
}

async function main() {
  if (!username) throw new Error('Missing account username.');
  if (!authFile || !fs.existsSync(authFile)) throw new Error('Saved account session not found.');
  if (!commentText) throw new Error('Comment cannot be empty.');
  if (commentText.length > 1000) throw new Error('Comment must be 1000 characters or fewer.');

  const postUrl = normalizeInstagramUrl(rawPostUrl);
  const proxy = getPlaywrightProxy(username);
  const browser = await chromium.launch({
    headless: false,
    ...(proxy ? { proxy } : {}),
    args: [
      '--start-maximized',
      '--host-resolver-rules=MAP gw.dataimpulse.com 67.213.122.177',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const context = await browser.newContext({
    storageState: authFile,
    viewport: null,
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  try {
    // 1. Resilient navigation with retry for mobile proxies
    let navOk = false;
    let lastNavErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[Worker] Loading ${postUrl} (attempt ${attempt}/2)...`);
        await page.goto(postUrl, { waitUntil: 'commit', timeout: 90000 });
        navOk = true;
        break;
      } catch (err) {
        lastNavErr = err;
        console.log(`[Worker] Navigation attempt ${attempt} warning: ${err.message}`);
        if (attempt < 2) await page.waitForTimeout(3000);
      }
    }
    if (!navOk) {
      throw lastNavErr || new Error('Network timeout: Could not connect to Instagram through proxy.');
    }

    // 2. Patient page loading and account health verification
    const pageState = await waitForPostPageReady(page, 60000);

    if (pageState.status === 'suspended') {
      result({ ok: false, account: username, status: 'session_needs_attention', error: 'Instagram account is suspended. Verification required.' });
      return;
    }
    if (pageState.status === 'checkpoint') {
      result({ ok: false, account: username, status: 'session_needs_attention', error: 'Instagram requires account checkpoint / security confirmation.' });
      return;
    }
    if (pageState.status === 'logged_out' || !(await hasSessionCookie(context))) {
      result({ ok: false, account: username, status: 'logged_out', error: 'Saved Instagram session is logged out. Please re-login this account.' });
      return;
    }
    if (pageState.status === 'unavailable') {
      result({ ok: false, account: username, status: 'post_unavailable', error: 'Instagram post is broken, deleted, or unavailable.' });
      return;
    }
    if (pageState.status === 'comments_disabled') {
      result({ ok: false, account: username, status: 'comments_disabled', error: 'Comments are turned off or limited on this post.' });
      return;
    }

    // Double check session cookies and login state
    if (await needsAttention(page) || await isSuspended(page)) {
      result({ ok: false, account: username, status: 'session_needs_attention', error: 'Instagram requires manual verification for this account.' });
      return;
    }

    // 3. Find comment box
    const box = await findCommentBox(page);
    if (!box) {
      const dir = path.join(artifactsRoot, username);
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'comment-box-not-found.png'), fullPage: true }).catch(() => {});
      result({ ok: false, account: username, status: 'comment_box_not_found', error: 'Comment box was not found on this post. (Screenshot saved to artifacts)' });
      return;
    }

    // 4. Fill comment and submit
    await fillLocator(box, commentText);
    const outcome = await submitComment(page, box, commentText);
    const postedAt = new Date().toISOString();

    if (outcome === 'posted' || outcome === 'uncertain') {
      await page.waitForTimeout(stayMs).catch(() => {});
    }

    await context.storageState({ path: authFile, indexedDB: true }).catch(() => {});

    if (outcome === 'posted') {
      result({ ok: true, account: username, status: 'posted', postedAt, stayedSeconds: Math.round(stayMs / 1000) });
    } else if (outcome === 'session_needs_attention') {
      result({ ok: false, account: username, status: outcome, error: 'Instagram requires manual account verification.' });
    } else {
      result({ ok: false, account: username, status: outcome, postedAt, error: 'Comment submission could not be confirmed. It was not retried to avoid duplicates.' });
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  const message = String(error && error.message || error || 'Unknown error');
  let status = 'failed';
  if (/407|proxy authentication|ERR_PROXY_AUTH/i.test(message)) status = 'proxy_auth_failed';
  else if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|proxy/i.test(message)) status = 'proxy_connection_failed';
  result({ ok: false, account: username, status, error: message.slice(0, 500) });
  process.exitCode = 1;
});
