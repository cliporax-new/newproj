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
  $('#accountCount').textContent = accounts.length;
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
            ${!account.healthy ? `
              <div style="color: #ffb86c; font-size: 11px; font-weight: 600; margin-top: 3px;">
                ✅ Not suspended • Re-login needed
              </div>
            ` : ''}
          </div>
          <div class="account-actions">
            <span class="badge ${account.healthy ? 'good' : 'bad'}" title="${account.healthy ? 'Ready' : 'Not suspended • Session expired, re-login needed'}">${account.healthy ? 'Ready' : '🔄 Re-login needed'}</span>
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

addCommentRow('', 0);
updateAccountModeUi();
loadAccounts().then(refreshReelUsage).catch((error) => toast(error.message, 'error'));
loadSmmInfo();
