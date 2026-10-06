'use strict';
// SecureVault browser vault.
// Crypto (PBKDF2 -> AES-256-GCM) is unchanged from the MVP. Everything below the
// crypto section is interface code. Plaintext only ever exists in this page's memory.

let vaultKey = null, epoch = 0, lockTimer, countdownTimer, lockDeadline = 0;
let entries = [];            // decrypted records for the current unlock only
const AUTO_LOCK_MS = 5 * 60 * 1000;
const $ = id => document.getElementById(id);
const marker = 'SecureVault key verification v1';

/* ===================== Crypto (unchanged behaviour) ===================== */
function toBase64(buffer) { return btoa(Array.from(new Uint8Array(buffer), b => String.fromCharCode(b)).join('')); }
function fromBase64(text) { return Uint8Array.from(atob(text), c => c.charCodeAt(0)); }
async function deriveVaultKey(password, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2', salt:new TextEncoder().encode(salt), iterations:600000, hash:'SHA-256'}, base,
        {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
}
async function encryptRecord(record, key) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv:nonce}, key, new TextEncoder().encode(JSON.stringify(record)));
    return {ciphertext:toBase64(ciphertext), nonce:toBase64(nonce)};
}
async function decryptRecord(envelope, key) {
    const data = await crypto.subtle.decrypt({name:'AES-GCM', iv:fromBase64(envelope.nonce)}, key, fromBase64(envelope.ciphertext));
    return JSON.parse(new TextDecoder().decode(data));
}
function generateStrongPassword(length = 20, options = {}) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const chars = options.symbols === false ? letters : letters + '!@#$%^&*()-_=+';
    let result = '';
    const limit = 256 - (256 % chars.length);   // rejection sampling keeps every character equally likely
    while (result.length < length) {
        for (const byte of crypto.getRandomValues(new Uint8Array(length)))
            if (byte < limit && result.length < length) result += chars[byte % chars.length];
    }
    return result;
}

/* ===================== Server API ===================== */
async function api(path = '', method = 'GET', data) {
    const response = await fetch('/api/vault' + path, {method, credentials:'same-origin',
        headers:{'Content-Type':'application/json', 'X-CSRFToken':document.querySelector('meta[name="csrf-token"]').content},
        body:data === undefined ? undefined : JSON.stringify(data)});
    if (!response.ok) {
        if (response.status === 401) lockVault(true);
        throw new Error(response.status === 409 ? 'Vault state changed. Lock and unlock again.'
            : response.status === 401 ? 'Your session expired. Please sign in again.'
            : 'Request failed. Your session may have expired.');
    }
    return response.status === 204 ? null : response.json();
}

/* ===================== UI helpers ===================== */
function message(text, kind = 'info') {
    const status = $('status');
    if (status) status.textContent = text;
    if (window.SV && SV.toast) SV.toast(text, kind, kind === 'error' ? 7000 : 4000);
}
function strength(pw) {
    return window.SV && SV.passwordStrength ? SV.passwordStrength(pw) : {score: 4, label: ''};
}
function icon(name) { return SV.icon(name); }
function toolButton(name, label, onClick, extra) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool-btn' + (extra ? ' ' + extra : '');
    b.setAttribute('aria-label', label);
    b.title = label;
    b.append(icon(name));
    b.addEventListener('click', onClick);
    return b;
}
function setBusy(busy, text) {
    const btn = $('unlockButton');
    btn.classList.toggle('is-loading', busy);
    btn.disabled = busy;
    $('lockHero').classList.toggle('busy', busy);
    if (text) $('unlockLabel').textContent = text;
}
function formatTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function colourFor(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return 'c' + (h % 6);
}

/* ===================== Auto-lock ===================== */
function updateCountdown() {
    const left = lockDeadline - Date.now();
    $('lockCountdown').textContent = formatTime(left);
    $('lockPill').classList.toggle('warn', left < 60000);
}
function resetLockTimer() {
    clearTimeout(lockTimer);
    lockTimer = setTimeout(() => { lockVault(); message('Vault locked after 5 minutes without activity.', 'warning'); }, AUTO_LOCK_MS);
    lockDeadline = Date.now() + AUTO_LOCK_MS;
    clearInterval(countdownTimer);
    countdownTimer = setInterval(updateCountdown, 1000);
    updateCountdown();
}

/* ===================== Lock / unlock ===================== */
function lockVault(quiet) {
    const wasOpen = !!vaultKey;
    epoch++; vaultKey = null; entries = [];
    clearTimeout(lockTimer); clearInterval(countdownTimer);
    for (const id of ['masterPassword', 'masterConfirm', 'entryLabel', 'entryUsername', 'entryPassword', 'searchInput']) {
        const el = $(id); if (el) el.value = '';
    }
    $('entryList').replaceChildren();
    const dialog = $('entryDialog');
    if (dialog.open) dialog.close();
    $('vaultArea').classList.add('hidden');
    $('lockedView').classList.remove('hidden');
    setBusy(false);
    if (wasOpen && quiet !== true) message('Vault locked.', 'info');
}

function showFirstTimeSetup() {
    $('confirmWrap').classList.remove('hidden');
    $('masterMeterWrap').classList.remove('hidden');
    $('unlockLabel').textContent = 'Create my vault';
    $('masterConfirm').focus();
}

async function unlockVault() {
    const password = $('masterPassword').value;
    const confirmation = $('masterConfirm').value;
    if (password.length < 12) { $('masterPassword').focus(); throw new Error('Use a master passphrase of at least 12 characters.'); }
    lockVault(true);
    const generation = epoch;
    setBusy(true, 'Checking…');
    try {
        const check = await api('/key-check');
        if (generation !== epoch) return;
        if (!check.ciphertext) {
            // First unlock creates the key-check record, so make the user type the passphrase twice.
            if ($('confirmWrap').classList.contains('hidden')) {
                $('masterPassword').value = password;
                showFirstTimeSetup();
                message('First unlock: confirm your new master passphrase to create the vault.', 'info');
                return;
            }
            if (confirmation !== password) {
                $('masterPassword').value = password;
                $('masterConfirm').value = '';
                $('masterConfirm').focus();
                throw new Error('The two passphrases do not match.');
            }
        }
        setBusy(true, 'Deriving key…');
        const key = await deriveVaultKey(password, check.salt);
        if (generation !== epoch) return;
        if (check.ciphertext) {
            let value;
            try { value = await decryptRecord(check, key); } catch { throw new Error('Incorrect master passphrase. Please try again.'); }
            if (value !== marker) throw new Error('Vault verification failed.');
        } else {
            const encrypted = await encryptRecord(marker, key);
            if (generation !== epoch) return;
            await api('/key-check', 'POST', encrypted);
        }
        if (generation !== epoch) return;
        vaultKey = key;
        $('confirmWrap').classList.add('hidden');
        $('masterMeterWrap').classList.add('hidden');
        $('lockedView').classList.add('hidden');
        $('vaultArea').classList.remove('hidden');
        resetLockTimer();
        message(check.ciphertext ? 'Vault unlocked.' : 'Your vault is ready.', 'success');
        await loadEntries(key, generation);
    } finally {
        if (generation === epoch && !vaultKey) setBusy(false, $('confirmWrap').classList.contains('hidden') ? 'Unlock vault' : 'Create my vault');
        else setBusy(false, 'Unlock vault');
    }
}

/* ===================== Entries ===================== */
async function loadEntries(key, generation) {
    const envelopes = await api();
    const list = [];
    for (const envelope of envelopes) {
        try {
            const record = await decryptRecord(envelope, key);
            list.push({id: envelope.id, label: String(record.label || ''), username: String(record.username || ''), password: String(record.password || '')});
        } catch {
            list.push({id: envelope.id, broken: true});
        }
    }
    // A pending decrypt must never repopulate plaintext after locking.
    if (generation === epoch && vaultKey === key) { entries = list; render(); }
}

function secretRow(labelText, value, masked, what) {
    const row = document.createElement('div');
    row.className = 'secret-row';
    const label = document.createElement('span'); label.className = 'label'; label.textContent = labelText;
    const val = document.createElement('span'); val.className = 'value';
    const hiddenText = '•'.repeat(Math.min(Math.max(value.length, 8), 16));
    val.textContent = masked ? hiddenText : (value || '—');
    row.append(label, val);
    if (masked) {
        let shown = false;
        const reveal = toolButton('eye', 'Show password', () => {
            shown = !shown;
            val.textContent = shown ? value : hiddenText;
            reveal.replaceChildren(icon(shown ? 'eye-off' : 'eye'));
            reveal.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
            reveal.title = reveal.getAttribute('aria-label');
        });
        row.append(reveal);
    }
    if (value) row.append(toolButton('copy', 'Copy ' + what.toLowerCase(), e => SV.copy(value, what, e.currentTarget)));
    return row;
}

function entryCard(entry, reusedSet) {
    const card = document.createElement('article');
    if (entry.broken) {
        card.className = 'entry broken';
        card.append(icon('alert'));
        const t = document.createElement('span');
        t.textContent = 'This record failed its integrity check. It may have been modified.';
        card.append(t);
        return card;
    }
    card.className = 'entry';
    const s = strength(entry.password);

    const head = document.createElement('div'); head.className = 'entry-head';
    const avatar = document.createElement('span');
    avatar.className = 'entry-avatar ' + colourFor(entry.label);
    avatar.textContent = (entry.label.trim()[0] || '?');
    const titles = document.createElement('div');
    const title = document.createElement('div'); title.className = 'entry-title'; title.textContent = entry.label;
    const sub = document.createElement('div'); sub.className = 'entry-sub'; sub.textContent = entry.username || 'No username';
    titles.append(title, sub);
    const badge = document.createElement('span'); badge.className = 'badge s' + s.score; badge.textContent = s.label;
    head.append(avatar, titles, badge);

    card.append(head);
    if (reusedSet.has(entry.password)) {
        const reused = document.createElement('span');
        reused.className = 'badge reused';
        reused.append(icon('refresh'), document.createTextNode('Reused elsewhere in your vault'));
        card.append(reused);
    }
    card.append(secretRow('Username', entry.username, false, 'Username'));
    card.append(secretRow('Password', entry.password, true, 'Password'));

    const foot = document.createElement('div'); foot.className = 'entry-foot';
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'btn btn-secondary btn-sm';
    del.append(icon('trash'), document.createTextNode('Delete'));
    let armed = false, timer;
    del.addEventListener('click', () => {
        if (!armed) {
            armed = true;
            del.className = 'btn btn-danger btn-sm';
            del.replaceChildren(icon('trash'), document.createTextNode('Click again to delete'));
            timer = setTimeout(() => { armed = false; del.className = 'btn btn-secondary btn-sm'; del.replaceChildren(icon('trash'), document.createTextNode('Delete')); }, 4000);
            return;
        }
        clearTimeout(timer);
        run(async () => {
            const key = vaultKey, generation = epoch;
            if (!key) return;
            del.disabled = true;
            await api('/' + entry.id, 'DELETE');
            message('"' + entry.label + '" deleted.', 'success');
            await loadEntries(key, generation);
        });
    });
    foot.append(del);
    card.append(foot);
    return card;
}

function render() {
    const query = $('searchInput').value.trim().toLowerCase();
    const good = entries.filter(e => !e.broken);
    const counts = new Map();
    good.forEach(e => counts.set(e.password, (counts.get(e.password) || 0) + 1));
    const reusedSet = new Set([...counts].filter(([, n]) => n > 1).map(([p]) => p));

    // Stats (computed locally; never sent anywhere)
    const strong = good.filter(e => strength(e.password).score >= 3).length;
    const reusedCount = good.filter(e => reusedSet.has(e.password)).length;
    $('statTotal').textContent = String(entries.length);
    $('statStrong').textContent = String(strong);
    $('statWeak').textContent = String(good.length - strong);
    $('statReused').textContent = String(reusedCount);
    const healthy = good.filter(e => strength(e.password).score >= 3 && !reusedSet.has(e.password)).length;
    const pct = good.length ? Math.round(100 * healthy / good.length) : 0;
    const fill = $('healthFill');
    fill.style.width = pct + '%';
    fill.className = 'health-fill' + (pct < 50 ? ' low' : pct < 80 ? ' mid' : '');
    $('healthScore').textContent = good.length ? pct + '% · ' + (pct >= 80 ? 'Good' : pct >= 50 ? 'Needs work' : 'At risk') : 'No logins yet';
    $('healthRow').classList.toggle('hidden', !good.length);

    const visible = entries.filter(e => !query || e.broken ||
        e.label.toLowerCase().includes(query) || e.username.toLowerCase().includes(query));
    const fragment = document.createDocumentFragment();
    visible.forEach(e => fragment.append(entryCard(e, reusedSet)));
    $('entryList').replaceChildren(fragment);
    $('emptyState').classList.toggle('hidden', entries.length > 0);
    $('noMatches').classList.toggle('hidden', !(entries.length > 0 && visible.length === 0));
}

/* ===================== Add dialog ===================== */
function openDialog() {
    if (!vaultKey) return;
    for (const id of ['entryLabel', 'entryUsername', 'entryPassword']) $(id).value = '';
    $('entryPassword').type = 'password';
    $('entryPassword').dispatchEvent(new Event('input'));
    const dialog = $('entryDialog');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    $('entryLabel').focus();
}
function closeDialog() {
    const dialog = $('entryDialog');
    for (const id of ['entryLabel', 'entryUsername', 'entryPassword']) $(id).value = '';
    if (dialog.open) dialog.close();
}
async function saveEntry() {
    const key = vaultKey, generation = epoch;
    if (!key) throw new Error('Unlock the vault first.');
    const record = {label:$('entryLabel').value.trim(), username:$('entryUsername').value.trim(), password:$('entryPassword').value};
    if (!record.label) { $('entryLabel').focus(); throw new Error('Give this login a name.'); }
    if (!record.password) { $('entryPassword').focus(); throw new Error('Enter or generate a password.'); }
    if (JSON.stringify(record).length > 16000) throw new Error('Record is too large.');
    const btn = $('saveButton');
    btn.classList.add('is-loading'); btn.disabled = true;
    try {
        const encrypted = await encryptRecord(record, key);
        if (generation !== epoch || vaultKey !== key) return;
        await api('', 'POST', encrypted);
        if (generation !== epoch) return;
        closeDialog();
        message('"' + record.label + '" encrypted and saved.', 'success');
        await loadEntries(key, generation);
    } finally {
        btn.classList.remove('is-loading'); btn.disabled = false;
    }
}

async function run(action) { try { await action(); } catch (error) { message(error.message, 'error'); } }

/* ===================== Wire up ===================== */
if (typeof document !== 'undefined') {
    $('unlockForm').addEventListener('submit', e => { e.preventDefault(); run(unlockVault); });
    $('lockButton').addEventListener('click', () => lockVault());
    $('newEntryButton').addEventListener('click', openDialog);
    $('emptyAddButton').addEventListener('click', openDialog);
    $('closeDialog').addEventListener('click', closeDialog);
    $('cancelDialog').addEventListener('click', closeDialog);
    $('entryDialog').addEventListener('cancel', () => {
        for (const id of ['entryLabel', 'entryUsername', 'entryPassword']) $(id).value = '';
    });
    $('entryForm').addEventListener('submit', e => { e.preventDefault(); run(saveEntry); });
    $('genLength').addEventListener('input', () => { $('genLengthValue').textContent = $('genLength').value; });
    $('generateButton').addEventListener('click', () => {
        const input = $('entryPassword');
        input.value = generateStrongPassword(Number($('genLength').value), {symbols: $('genSymbols').checked});
        input.dispatchEvent(new Event('input'));
        message('Strong password generated. Use the eye button to view it.', 'success');
    });
    $('searchInput').addEventListener('input', render);
    ['keydown', 'click', 'input'].forEach(name => document.addEventListener(name, () => { if (vaultKey) resetLockTimer(); }));
    window.addEventListener('pagehide', () => lockVault(true));
    window.addEventListener('pageshow', event => { if (event.persisted) lockVault(true); });
    document.querySelector('form[action$="/logout"]').addEventListener('submit', () => lockVault(true));
}
if (typeof module !== 'undefined') module.exports = {deriveVaultKey, encryptRecord, decryptRecord, generateStrongPassword};
