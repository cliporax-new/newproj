'use strict';

const $ = (selector) => document.querySelector(selector);
const accountsEl = $('#accounts');
const pickerEl = $('#accountPicker');
const toastEl = $('#toast');
const commentsEl = $('#commentsBuilder');
let accounts = [];
let activeJobId = null;
let jobTimer = null;
let reelUsage = { usedAccounts: [], reservedAccounts: [] };

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function toast(message, type = 'info', timeout = 4500) {
  toastEl.textContent = message;
  toastEl.className = `toast ${type}`;
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.add('hidden'), timeout);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[ch]));
}

function prettyDate(value) {
  try { return new Date(value).toLocaleString(); }
  catch { return value || ''; }
}

function shortComment(value, max = 70) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function loadAccounts() {
  const data = await api('/api/accounts');
  accounts = data.accounts || [];
  renderAccounts();
  renderPicker();
  updateNeedText();
}

function formatLocation(ipInfo) {
  if (!ipInfo) return 'Location not checked';
  const parts = [ipInfo.city, ipInfo.region, ipInfo.country].filter(Boolean);
  return parts.length ? parts.join(', ') : 'India';
}

function renderAccounts() {
  const readyCount = accounts.filter((a) => a.healthy).length;
  $('#accountCount').innerHTML = `<span style="color: #4ade80; font-weight: 700;">${readyCount} Ready</span> <span style="opacity: 0.6; font-size: 13px;">(${accounts.length} total)</span>`;
  if (!accounts.length) {
    accountsEl.innerHTML = '<div class="empty-card">No Instagram accounts saved yet.</div>';
    return;
  }

  accountsEl.innerHTML = accounts.map((account) => {
    const ip = account.ipInfo;
    return `
      <article class="account-card" data-user="${escapeHtml(account.username)}">
        <div class="account-top">
          <div>
            <h3>${escapeHtml(account.username)}</h3>
            <div class="muted">Saved: ${escapeHtml(prettyDate(account.savedAt))}</div>
            <div class="muted" style="color: #8da4ff; font-weight: 600; margin-top: 3px;">
              🌐 ${account.proxyConfigured ? escapeHtml(account.proxyLabel || 'Dedicated Mobile IP') : 'Dedicated Mobile IP'}
            </div>
            ${account.accountStatus === 'suspended' ? `
              <div style="color: #f87171; font-size: 11px; font-weight: 700; margin-top: 3px;">
                ⚠️ Suspended by Instagram (Human verification challenge)
              </div>
            ` : (!account.healthy ? `
              <div style="color: #ffb86c; font-size: 11px; font-weight: 600; margin-top: 3px;">
                🔄 Session expired • Re-login needed
              </div>
            ` : '')}
          </div>
          <div class="account-actions">
            ${account.accountStatus === 'suspended' ? `
              <span class="badge bad" style="background: #ef4444; color: #fff; font-weight: 700;" title="Suspended / Challenge required">⚠️ Suspended</span>
            ` : (account.healthy ? `
              <span class="badge good" title="Ready to comment">Ready</span>
            ` : `
              <span class="badge" style="background: #f59e0b; color: #111; font-weight: 700;" title="Session expired, re-login needed">🔄 Re-login needed</span>
            `)}
            <button class="secondary relogin">Re-login</button>
            <button class="danger remove">Remove</button>
          </div>
        </div>

        <div class="account-ip-badge">
          ${ip && ip.ip ? `
            <div class="ip-info-box">
              <div class="ip-info-row">
                <span class="ip-flag">${ip.flag || '🇮🇳'}</span>
                <strong class="ip-address">${escapeHtml(ip.ip)}</strong>
                <span class="ip-location">${escapeHtml(formatLocation(ip))}</span>
              </div>
              <div class="ip-sub-row">
                <span class="ip-isp">🏢 <strong>ISP:</strong> ${escapeHtml(ip.isp || 'Reliance Jio / Airtel 4G/5G')}</span>
                ${ip.checkedAt ? `<span class="ip-checked-time">Verified ${escapeHtml(prettyDate(ip.checkedAt))}</span>` : ''}
              </div>
            </div>
          ` : `
            <div class="ip-info-box pending">
              <span>🌐 <strong>Real IP:</strong> Dedicated Indian Mobile IP assigned</span>
            </div>
          `}
        </div>
      </article>
    `;
  }).join('');

  accountsEl.querySelectorAll('.account-card').forEach((card) => {
    const user = card.dataset.user;
    card.querySelector('.relogin').addEventListener('click', () => startLogin(user));
    card.querySelector('.remove').addEventListener('click', async () => {
      if (!confirm(`Remove ${user}?`)) return;
      try {
        await api(`/api/accounts/${encodeURIComponent(user)}`, { method: 'DELETE' });
        toast(`Removed ${user}.`, 'info');
        await loadAccounts();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

function blockedAccounts() {
  return new Set([...(reelUsage.usedAccounts || []), ...(reelUsage.reservedAccounts || [])]);
}

function renderPicker() {
  const ready = accounts.filter((a) => a.healthy);
  const blocked = blockedAccounts();
  if (!ready.length) {
    pickerEl.className = 'account-picker empty';
    pickerEl.innerHTML = 'No ready accounts yet.';
    return;
  }
  pickerEl.className = 'account-picker';
  pickerEl.innerHTML = ready.map((account) => {
    const isBlocked = blocked.has(account.username);
    const blockedLabel = (reelUsage.usedAccounts || []).includes(account.username) ? 'Already used on this reel/post' : 'Reserved by active job';
    return `
      <label class="pick-account ${isBlocked ? 'pick-disabled' : ''}">
        <input type="checkbox" value="${escapeHtml(account.username)}" ${isBlocked ? 'disabled' : ''} />
        <span>
          <strong>${escapeHtml(account.username)}</strong>
          <small>${isBlocked ? escapeHtml(blockedLabel) : 'Ready · Dedicated Mobile IP'}</small>
        </span>
      </label>
    `;
  }).join('');
}

function selectedAccounts() {
  return [...pickerEl.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
}

async function startLogin(username) {
  if (!username) return toast('Enter an Instagram username / label.', 'error');
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ username }) });
    toast(`Browser window opening on your screen for ${username}... Enter login / OTP / 2FA manually.`, 'info', 10000);
    pollLogin(username);
  } catch (error) {
    toast(error.message, 'error', 7500);
  }
}

function pollLogin(username) {
  const timer = setInterval(async () => {
    try {
      const status = await api(`/api/login-status?username=${encodeURIComponent(username)}`);
      if (status.status === 'saved') {
        clearInterval(timer);
        toast(`✅ Account ${username} successfully logged in and saved!`, 'success', 8000);
        await loadAccounts();
      } else if (status.status === 'failed') {
        clearInterval(timer);
        toast(status.error || 'Login window closed before completing login.', 'error', 8000);
      }
    } catch (error) {
      clearInterval(timer);
      toast(error.message, 'error');
    }
  }, 1200);
}

// ─── Single Mode UI ───
function addCommentRow(initialText = '', initialGap = 5) {
  const count = commentsEl.children.length + 1;
  const row = document.createElement('div');
  row.className = 'comment-row';
  row.innerHTML = `
    <div class="comment-row-head">
      <div class="comment-number">${count}</div>
      <input class="comment-input" placeholder="Type custom comment..." value="${escapeHtml(initialText)}" />
      <button type="button" class="danger remove-comment" title="Remove comment">&times;</button>
    </div>
    <div class="comment-row-foot">
      <div class="row-char-count">0/1000</div>
      <div class="gap-wrap ${count === 1 ? 'first-gap' : ''}">
        <span><strong>Wait gap</strong><small>Minutes before posting</small></span>
        <input class="gap-input" type="number" min="0" max="1440" step="0.5" value="${count === 1 ? 0 : initialGap}" />
      </div>
    </div>
  `;
  const textInput = row.querySelector('.comment-input');
  const charCount = row.querySelector('.row-char-count');
  const updateCount = () => { charCount.textContent = `${textInput.value.length}/1000`; };
  textInput.addEventListener('input', updateCount);
  updateCount();

  row.querySelector('.remove-comment').addEventListener('click', () => {
    if (commentsEl.children.length <= 1) {
      toast('At least one comment is required.', 'error');
      return;
    }
    row.remove();
    renumberComments();
    updateNeedText();
  });

  commentsEl.appendChild(row);
  renumberComments();
  updateNeedText();
}

function renumberComments() {
  [...commentsEl.children].forEach((row, idx) => {
    row.querySelector('.comment-number').textContent = idx + 1;
    const gapWrap = row.querySelector('.gap-wrap');
    if (idx === 0) {
      gapWrap.classList.add('first-gap');
      row.querySelector('.gap-input').value = 0;
    } else {
      gapWrap.classList.remove('first-gap');
    }
  });
}

function collectComments() {
  return [...commentsEl.children].map((row) => ({
    text: row.querySelector('.comment-input').value.trim(),
    gapMinutes: Number(row.querySelector('.gap-input').value) || 0,
  }));
}

function accountMode() {
  return $('input[name="accountMode"]:checked')?.value || 'auto';
}

function updateAccountModeUi() {
  const isManual = accountMode() === 'manual';
  $('#manualAccounts').classList.toggle('hidden', !isManual);
  updateNeedText();
}

function updateNeedText() {
  const needed = commentsEl.children.length;
  const ready = accounts.filter((a) => a.healthy && !blockedAccounts().has(a.username)).length;
  $('#accountNeed').textContent = `Need ${needed} unused ready account(s). Currently available: ${ready}`;
}

async function refreshReelUsage() {
  const postUrl = $('#postUrl').value.trim();
  if (!postUrl) {
    $('#reelUsage').textContent = '';
    reelUsage = { usedAccounts: [], reservedAccounts: [] };
    renderPicker();
    updateNeedText();
    return;
  }
  try {
    const data = await api(`/api/reel-usage?postUrl=${encodeURIComponent(postUrl)}`);
    reelUsage = data;
    const used = data.usedAccounts || [];
    const reserved = data.reservedAccounts || [];
    const parts = [];
    if (used.length) parts.push(`Already used: ${used.join(', ')}`);
    if (reserved.length) parts.push(`Reserved by active job: ${reserved.join(', ')}`);
    $('#reelUsage').textContent = parts.join(' · ');
    renderPicker();
    updateNeedText();
  } catch (error) {
    $('#reelUsage').textContent = error.message;
    reelUsage = { usedAccounts: [], reservedAccounts: [] };
    renderPicker();
  }
}

// ─── Multi-Line Parser ───
function parseMultiLines(rawText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    const match = line.match(/(https?:\/\/[^\s]+)\s+(.+)/);
    if (match) {
      parsed.push({ url: match[1].trim(), comment: match[2].trim() });
    } else {
      const parts = line.split(/\s+/);
      if (parts[0] && parts[0].includes('instagram.com') && parts.length > 1) {
        parsed.push({ url: parts[0], comment: parts.slice(1).join(' ') });
      }
    }
  }
  return parsed;
}

// ─── Job Monitoring ───
function secondsUntil(value) {
  const ms = Date.parse(value || '') - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

function renderJob(job) {
  $('#jobStatus').textContent = job.status.replaceAll('_', ' ');
  $('#jobStatus').className = `badge ${job.status === 'completed' ? 'good' : job.status.includes('error') || job.status === 'failed' ? 'bad' : ''}`;
  $('#jobResults').innerHTML = job.items.map((item) => {
    const wait = item.status === 'waiting' ? secondsUntil(item.scheduledAt) : null;
    const detail = item.error ? ` · ${escapeHtml(item.error)}` : wait ? ` · starts in ${escapeHtml(wait)}` : '';
    return `
      <div class="job-row job-item">
        <div>
          <strong>#${item.index} · ${escapeHtml(item.account)}</strong>
          <small>${escapeHtml(shortComment(item.comment))}</small>
          ${item.postUrl ? `<small style="color: #65778f;">${escapeHtml(item.postUrl)}</small>` : ''}
        </div>
        <span class="${item.ok ? 'result-good' : item.status === 'running' ? 'result-running' : ['queued', 'waiting'].includes(item.status) ? '' : 'result-bad'}">
          ${escapeHtml(item.status || 'unknown')}${detail}
        </span>
      </div>
    `;
  }).join('');
}

function pollJob() {
  clearInterval(jobTimer);
  jobTimer = setInterval(async () => {
    if (!activeJobId) return;
    try {
      const data = await api(`/api/comment-jobs/${encodeURIComponent(activeJobId)}`);
      renderJob(data.job);
      const doneCount = (data.job.items || []).filter((it) => it.finishedAt).length;
      if (doneCount !== pollJob._lastDone) {
        pollJob._lastDone = doneCount;
        await loadAccounts().catch(() => {});
      }
      if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(data.job.status)) {
        clearInterval(jobTimer);
        $('#postBtn').disabled = false;
        $('#multiPostBtn').disabled = false;
        await loadAccounts().catch(() => {});
        await refreshReelUsage();
        if (data.job.status === 'completed') toast('All comments completed successfully.', 'success');
        else toast('Job finished with one or more errors. See the result list.', 'error', 7000);
      }
    } catch (error) {
      clearInterval(jobTimer);
      $('#postBtn').disabled = false;
      $('#multiPostBtn').disabled = false;
      toast(error.message, 'error');
    }
  }, 1000);
}

// ─── Tab Switching ───
$('#tabSingle').addEventListener('click', () => {
  $('#tabSingle').classList.add('active');
  $('#tabMulti').classList.remove('active');
  $('#singleModeBox').classList.remove('hidden');
  $('#multiModeBox').classList.add('hidden');
});

$('#tabMulti').addEventListener('click', () => {
  $('#tabMulti').classList.add('active');
  $('#tabSingle').classList.remove('active');
  $('#multiModeBox').classList.remove('hidden');
  $('#singleModeBox').classList.add('hidden');
});

// ─── Event Handlers ───
$('#loginBtn').addEventListener('click', async () => {
  const username = $('#newUsername').value.trim();
  if (!username) return toast('Enter an Instagram username / label.', 'error');
  const button = $('#loginBtn');
  button.disabled = true;
  try {
    await startLogin(username);
    $('#newUsername').value = '';
  } finally {
    button.disabled = false;
  }
});

$('#verifyAccountsBtn')?.addEventListener('click', async () => {
  const btn = $('#verifyAccountsBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Checking sessions...';
  try {
    toast('Checking Instagram session health for all accounts...', 'info');
    const res = await api('/api/accounts/verify-all', { method: 'POST' });
    await loadAccounts();
    toast(`Session check complete! ${res.readyCount ?? 0} active, ${res.deadCount ?? 0} suspended/expired.`, 'success');
  } catch (err) {
    toast(`Session check failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Verify All Sessions';
  }
});

$('#addCommentBtn').addEventListener('click', () => addCommentRow('', 5));
$('#postUrl').addEventListener('change', refreshReelUsage);
$('#postUrl').addEventListener('blur', refreshReelUsage);
document.querySelectorAll('input[name="accountMode"]').forEach((el) => el.addEventListener('change', updateAccountModeUi));

$('#selectAllBtn').addEventListener('click', () => {
  const checks = [...pickerEl.querySelectorAll('input[type="checkbox"]:not(:disabled)')];
  if (!checks.length) return;
  const allChecked = checks.every((c) => c.checked);
  checks.forEach((c) => { c.checked = !allChecked; });
  $('#selectAllBtn').textContent = allChecked ? 'Select all available accounts' : 'Clear selection';
});

// Start Single Reel Mode
$('#postBtn').addEventListener('click', async () => {
  const postUrl = $('#postUrl').value.trim();
  const comments = collectComments();
  const mode = accountMode();
  const selected = selectedAccounts();
  if (!postUrl) return toast('Paste an Instagram reel/post URL.', 'error');
  if (comments.some((c) => !c.text)) return toast('Every comment row must contain text.', 'error');
  const normalized = comments.map((c) => c.text.replace(/\s+/g, ' ').trim().toLowerCase());
  if (new Set(normalized).size !== normalized.length) return toast('Use a different comment in each row.', 'error');
  if (mode === 'manual' && selected.length < comments.length) return toast(`Select at least ${comments.length} unused ready account(s).`, 'error');

  const button = $('#postBtn');
  button.disabled = true;
  try {
    const data = await api('/api/comment-jobs', {
      method: 'POST',
      body: JSON.stringify({ postUrl, comments, accountMode: mode, accounts: selected }),
    });
    activeJobId = data.jobId;
    $('#jobBox').classList.remove('hidden');
    renderJob(data.job);
    toast('Single reel comment queue started.', 'success');
    pollJob();
  } catch (error) {
    toast(error.message, 'error', 8000);
    button.disabled = false;
  }
});

// Start Line-Wise Multi-Link Mode
$('#multiPostBtn').addEventListener('click', async () => {
  const text = $('#multiLinesInput').value.trim();
  if (!text) return toast('Paste links and comments (1 link + 1 comment per line).', 'error');

  const lines = parseMultiLines(text);
  if (!lines.length) return toast('Could not parse any valid lines. Format: URL Comment', 'error');

  const gapMinutes = Number($('#multiGap').value) >= 0 ? Number($('#multiGap').value) : 1;
  const button = $('#multiPostBtn');
  button.disabled = true;

  try {
    const data = await api('/api/comment-jobs', {
      method: 'POST',
      body: JSON.stringify({ mode: 'multi', lines, gapMinutes }),
    });
    activeJobId = data.jobId;
    $('#jobBox').classList.remove('hidden');
    renderJob(data.job);
    toast(`Line-Wise queue started with ${lines.length} tasks!`, 'success');
    pollJob();
  } catch (error) {
    toast(error.message, 'error', 8000);
    button.disabled = false;
  }
});

async function loadSmmInfo() {
  try {
    const data = await api('/api/smm-info');
    if (data && data.endpoint) {
      $('#smmEndpointText').textContent = data.endpoint;
      $('#smmKeyText').textContent = data.apiKey;
      $('#copySmmBtn').onclick = () => {
        navigator.clipboard.writeText(`URL: ${data.endpoint}\nAPI Key: ${data.apiKey}\nService ID: 1`);
        toast('SMM API URL and Key copied to clipboard!', 'success');
      };
    }
  } catch {}
}

// ─── Live Orders & Activity Tracking ───
const expandedOrders = new Set();

function formatOrderStatus(status) {
  if (status === 'running') return '<span class="badge" style="color: #60a5fa; background: rgba(96, 165, 250, 0.15); border-color: rgba(96, 165, 250, 0.3);">🟢 Posting Now</span>';
  if (status === 'waiting') return '<span class="badge" style="color: #f59e0b; background: rgba(245, 158, 11, 0.15); border-color: rgba(245, 158, 11, 0.3);">⏳ 5m Gap Waiting</span>';
  if (status === 'completed') return '<span class="badge good">✅ Completed</span>';
  if (status === 'completed_with_errors') return '<span class="badge warn" style="color: #fbbf24; background: rgba(251, 191, 36, 0.15); border-color: rgba(251, 191, 36, 0.3);">⚠️ Completed (Errors)</span>';
  if (status === 'failed') return '<span class="badge bad">❌ Failed</span>';
  return '<span class="badge">⏱️ Queued</span>';
}

function formatItemStatus(item) {
  if (item.ok || item.status === 'posted') return '<span style="color: #4fd18b; font-weight: 700;">✅ Posted</span>';
  if (item.status === 'running') return '<span style="color: #60a5fa; font-weight: 700;">🟢 Posting...</span>';
  if (item.status === 'waiting') return '<span style="color: #f59e0b;">⏳ Waiting 5m gap</span>';
  if (item.status === 'failed' || item.error) return `<span style="color: #ff6b74;" title="${escapeHtml(item.error || 'Failed')}">❌ Failed</span>`;
  return '<span style="color: #8f9baa;">⏱️ Queued</span>';
}

function renderOrders(orders = []) {
  const container = $('#ordersList');
  if (!container) return;

  if (!orders.length) {
    container.innerHTML = `
      <div class="empty-orders">
        <div style="font-size: 26px; margin-bottom: 8px;">📡</div>
        <strong style="color: #cbd5e1; font-size: 14px;">Waiting for incoming orders...</strong>
        <small style="color: var(--muted); display: block; margin-top: 4px;">Orders placed via SMM Panel API (Port 4620) or Dashboard queue will automatically appear here with real-time comments counter and link tracking.</small>
      </div>`;
    return;
  }

  container.innerHTML = orders.map((order) => {
    const total = order.totalComments || (order.items || []).length || 1;
    const posted = order.postedComments || 0;
    const pct = Math.min(100, Math.round((posted / total) * 100));
    const isSmm = order.source === 'smm';
    const isExpanded = expandedOrders.has(order.id);
    const cardClass = ['order-card', order.status].filter(Boolean).join(' ');

    const itemsHtml = (order.items || []).map((it, idx) => `
      <div class="order-item-row">
        <span style="color: var(--muted); font-weight: 700;">#${it.index || idx + 1}</span>
        <strong style="color: #8da4ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">@${escapeHtml(it.account || 'Auto')}</strong>
        <span style="color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(it.comment || '')}">${escapeHtml(shortComment(it.comment, 55))}</span>
        <div style="text-align: right;">${formatItemStatus(it)}</div>
      </div>
    `).join('');

    return `
      <article class="${cardClass}" data-order-id="${escapeHtml(order.id)}">
        <div class="order-top-row">
          <div class="order-id-group">
            <span class="source-tag ${isSmm ? 'smm' : 'manual'}">${isSmm ? '⚡ SMM API Order' : '💻 Manual Queue'} ${escapeHtml(order.orderNumber || order.id)}</span>
            ${formatOrderStatus(order.status)}
          </div>
          <div style="font-size: 12px; color: var(--muted);">
            ${prettyDate(order.createdAt)}
          </div>
        </div>

        <div class="order-link-row">
          <span style="font-size: 12px; color: var(--muted); font-weight: 700;">TARGET REEL:</span>
          ${order.postUrl ? `
            <a href="${escapeHtml(order.postUrl)}" target="_blank" rel="noopener noreferrer" class="order-link-anchor" title="${escapeHtml(order.postUrl)}">
              🔗 ${escapeHtml(order.postUrl)} ↗
            </a>
          ` : '<span style="color: var(--muted);">Multi-Link Queue</span>'}
        </div>

        <div class="order-progress-section">
          <div class="order-progress-info">
            <span><strong>${posted} / ${total} comments posted</strong></span>
            <span style="font-weight: 700; color: ${pct === 100 ? '#4fd18b' : '#8da4ff'};">${pct}%</span>
          </div>
          <div class="order-progress-track">
            <div class="order-progress-fill ${order.status}" style="width: ${pct}%;"></div>
          </div>
        </div>

        <div class="order-meta-row">
          <div>
            ${order.waitReason ? `<span style="color: #f59e0b;">⏳ ${escapeHtml(order.waitReason)}</span>` : ''}
            ${order.finishedAt ? `<span>Finished: ${prettyDate(order.finishedAt)}</span>` : ''}
          </div>
          <button type="button" class="order-details-toggle" data-toggle-id="${escapeHtml(order.id)}">
            ${isExpanded ? '▲ Hide Details' : `▼ View Comments & Accounts (${(order.items || []).length})`}
          </button>
        </div>

        <div id="details_${escapeHtml(order.id)}" class="order-items-table ${isExpanded ? '' : 'hidden'}">
          <div class="order-item-row head">
            <span>#</span>
            <span>Account</span>
            <span>Comment</span>
            <span style="text-align: right;">Status</span>
          </div>
          ${itemsHtml || '<div style="padding: 10px; color: var(--muted); text-align: center;">No comment logs recorded.</div>'}
        </div>
      </article>
    `;
  }).join('');
}

async function loadActivity() {
  try {
    const data = await api('/api/activity');
    if (!data || !data.ok) return;

    if (data.stats) {
      if ($('#statTotalOrders')) $('#statTotalOrders').textContent = data.stats.totalOrders || 0;
      if ($('#statActiveOrders')) $('#statActiveOrders').textContent = data.stats.activeOrders || 0;
      if ($('#statCommentsPosted')) $('#statCommentsPosted').textContent = data.stats.totalCommentsPosted || 0;
    }

    renderOrders(data.orders || []);
  } catch {}
}

// Delegate toggle clicks for order breakdown
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.order-details-toggle');
  if (!btn) return;
  const orderId = btn.getAttribute('data-toggle-id');
  if (!orderId) return;
  if (expandedOrders.has(orderId)) {
    expandedOrders.delete(orderId);
  } else {
    expandedOrders.add(orderId);
  }
  const detailsEl = $(`#details_${CSS.escape(orderId)}`);
  if (detailsEl) {
    const isNowExpanded = expandedOrders.has(orderId);
    detailsEl.classList.toggle('hidden', !isNowExpanded);
    btn.textContent = isNowExpanded ? '▲ Hide Details' : `▼ View Comments & Accounts`;
  }
});

addCommentRow('', 0);
updateAccountModeUi();
loadAccounts().then(refreshReelUsage).catch((error) => toast(error.message, 'error'));
loadSmmInfo();
loadActivity();
setInterval(loadActivity, 3000);
