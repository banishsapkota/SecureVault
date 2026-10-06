// SecureVault shared interface helpers (toasts, icons, password fields, 2FA input, admin filters).
// Loaded on every page. No inline scripts are used because the CSP only allows 'self'.
'use strict';

(function () {
    const SV = (window.SV = window.SV || {});
    const NS = 'http://www.w3.org/2000/svg';

    /* ---------- Icons ---------- */
    SV.icon = function (name, extraClass) {
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'icon' + (extraClass ? ' ' + extraClass : ''));
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(NS, 'use');
        use.setAttribute('href', '#i-' + name);
        svg.append(use);
        return svg;
    };

    /* ---------- Toasts ---------- */
    const toastIcons = {info: 'info', success: 'check', error: 'alert', warning: 'alert'};
    function dismiss(toast) {
        if (!toast.isConnected || toast.classList.contains('leaving')) return;
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 220);
    }
    function decorate(toast, timeout) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'toast-close';
        close.setAttribute('aria-label', 'Dismiss');
        close.append(SV.icon('x'));
        close.addEventListener('click', () => dismiss(toast));
        toast.append(close);
        if (timeout) setTimeout(() => dismiss(toast), timeout);
    }
    SV.toast = function (text, kind = 'info', timeout = 5000) {
        const region = document.getElementById('toastRegion');
        if (!region) return;
        const toast = document.createElement('div');
        toast.className = 'toast toast-' + kind;
        toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        const span = document.createElement('span');
        span.textContent = text;
        toast.append(SV.icon(toastIcons[kind] || 'info'), span);
        decorate(toast, timeout);
        region.append(toast);
        while (region.children.length > 4) region.firstElementChild.remove();
    };

    /* ---------- Password strength (runs only in the browser) ---------- */
    SV.strengthLabels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
    SV.passwordStrength = function (pw) {
        if (!pw) return {score: 0, label: 'Empty', bits: 0};
        let pool = 0;
        if (/[a-z]/.test(pw)) pool += 26;
        if (/[A-Z]/.test(pw)) pool += 26;
        if (/[0-9]/.test(pw)) pool += 10;
        if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
        let bits = pw.length * Math.log2(Math.max(pool, 2));
        if (/^(.)\1*$/.test(pw)) bits = Math.min(bits, 8);
        if (/(password|passw0rd|qwerty|123456|letmein|admin|welcome|iloveyou)/i.test(pw)) bits = Math.min(bits * 0.5, 30);
        if (new Set(pw).size <= 3) bits = Math.min(bits, 20);
        const score = bits < 28 ? 0 : bits < 45 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
        return {score, label: SV.strengthLabels[score], bits: Math.round(bits)};
    };

    /* ---------- Clipboard ---------- */
    let clipTimer;
    SV.copy = async function (text, what = 'Text', button) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            SV.toast('Copy failed. Your browser blocked clipboard access.', 'error');
            return;
        }
        SV.toast(what + ' copied. Clipboard clears in 30 seconds.', 'success', 3500);
        if (button) {
            button.classList.add('done');
            setTimeout(() => button.classList.remove('done'), 1200);
        }
        clearTimeout(clipTimer);
        clipTimer = setTimeout(() => { navigator.clipboard.writeText('').catch(() => {}); }, 30000);
    };

    /* ---------- Wire up page widgets ---------- */
    function onReady(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    function initTheme() {
        const btn = document.getElementById('themeToggle');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            try { localStorage.setItem('sv-theme', next); } catch (e) { /* storage unavailable */ }
        });
    }

    function initFlashes() {
        document.querySelectorAll('.toast.flash').forEach(t => decorate(t, 8000));
    }

    function initPasswordToggles(root = document) {
        root.querySelectorAll('[data-toggle-password]').forEach(btn => {
            if (btn.dataset.bound) return;
            btn.dataset.bound = '1';
            const input = document.getElementById(btn.dataset.togglePassword);
            if (!input) return;
            btn.addEventListener('click', () => {
                const show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                btn.replaceChildren(SV.icon(show ? 'eye-off' : 'eye'));
                btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
                btn.setAttribute('aria-pressed', String(show));
            });
        });
    }

    function initCapsLock() {
        document.querySelectorAll('[data-caps]').forEach(input => {
            const warn = document.getElementById(input.dataset.caps);
            if (!warn) return;
            const check = e => { if (e.getModifierState) warn.classList.toggle('show', e.getModifierState('CapsLock')); };
            input.addEventListener('keydown', check);
            input.addEventListener('keyup', check);
            input.addEventListener('blur', () => warn.classList.remove('show'));
        });
    }

    SV.renderMeter = function (meter, label, pw) {
        const s = SV.passwordStrength(pw);
        if (meter) meter.dataset.score = pw ? String(Math.max(1, s.score)) : '0';
        if (label) label.textContent = pw ? s.label : '';
        return s;
    };

    function initStrength() {
        document.querySelectorAll('[data-strength]').forEach(input => {
            const meter = document.getElementById(input.dataset.strength);
            const label = document.getElementById(input.dataset.strength + 'Label');
            const list = input.dataset.checklist ? document.getElementById(input.dataset.checklist) : null;
            const update = () => {
                SV.renderMeter(meter, label, input.value);
                if (list) {
                    const v = input.value;
                    const rules = {
                        length: v.length >= 12 && v.length <= 128,
                        mixed: /[a-z]/.test(v) && /[A-Z]/.test(v),
                        number: /[0-9]/.test(v),
                        symbol: /[^A-Za-z0-9]/.test(v),
                    };
                    list.querySelectorAll('[data-rule]').forEach(li => li.classList.toggle('ok', !!rules[li.dataset.rule]));
                }
            };
            input.addEventListener('input', update);
            update();
        });
    }

    function initPatternHints() {
        document.querySelectorAll('[data-live-hint]').forEach(input => {
            const hint = document.getElementById(input.dataset.liveHint);
            const base = hint ? hint.textContent : '';
            input.addEventListener('input', () => {
                if (!input.value) { input.classList.remove('is-valid', 'is-invalid'); if (hint) { hint.textContent = base; hint.className = 'hint'; } return; }
                const ok = input.checkValidity();
                input.classList.toggle('is-valid', ok);
                input.classList.toggle('is-invalid', !ok);
                if (hint) {
                    hint.textContent = ok ? 'Looks good.' : (input.dataset.badHint || base);
                    hint.className = 'hint ' + (ok ? 'good' : 'bad');
                }
            });
        });
    }

    function initMatch() {
        document.querySelectorAll('[data-match]').forEach(input => {
            const other = document.getElementById(input.dataset.match);
            const hint = document.getElementById(input.id + 'Hint');
            const check = () => {
                const ok = !input.value || input.value === other.value;
                input.setCustomValidity(ok ? '' : 'Passwords do not match.');
                input.classList.toggle('is-invalid', !ok);
                input.classList.toggle('is-valid', ok && !!input.value);
                if (hint) { hint.textContent = ok ? (input.value ? 'Passwords match.' : '') : 'Passwords do not match.'; hint.className = 'hint ' + (ok ? 'good' : 'bad'); }
            };
            input.addEventListener('input', check);
            other.addEventListener('input', check);
        });
    }

    function initLoadingForms() {
        document.querySelectorAll('form[data-loading]').forEach(form => {
            form.addEventListener('submit', () => {
                const btn = form.querySelector('button[type="submit"]');
                if (btn) { btn.classList.add('is-loading'); btn.disabled = true; }
            });
        });
    }

    function initOtp() {
        document.querySelectorAll('[data-otp]').forEach(wrap => {
            const native = wrap.querySelector('input[name="token"]');
            const form = wrap.closest('form');
            if (!native || !form) return;
            const boxes = [];
            const row = document.createElement('div');
            row.className = 'otp';
            row.setAttribute('role', 'group');
            row.setAttribute('aria-label', 'Six-digit code');
            for (let i = 0; i < 6; i++) {
                const b = document.createElement('input');
                b.type = 'text';
                b.inputMode = 'numeric';
                b.maxLength = 1;
                b.autocomplete = i === 0 ? 'one-time-code' : 'off';
                b.setAttribute('aria-label', 'Digit ' + (i + 1));
                boxes.push(b);
                row.append(b);
                if (i === 2) { const gap = document.createElement('span'); gap.className = 'gap'; row.append(gap); }
            }
            native.classList.add('hidden');
            native.required = false;
            native.removeAttribute('pattern');
            wrap.prepend(row);

            const sync = () => {
                native.value = boxes.map(b => b.value).join('');
                boxes.forEach(b => b.classList.toggle('filled', !!b.value));
                if (/^[0-9]{6}$/.test(native.value)) {
                    const btn = form.querySelector('button[type="submit"]');
                    if (btn) { btn.classList.add('is-loading'); btn.disabled = true; }
                    form.submit();
                }
            };
            const fill = (start, text) => {
                const digits = text.replace(/\D/g, '').slice(0, 6 - start).split('');
                digits.forEach((d, k) => { boxes[start + k].value = d; });
                const next = Math.min(start + digits.length, 5);
                boxes[next].focus();
                sync();
            };
            boxes.forEach((b, i) => {
                b.addEventListener('input', () => {
                    const v = b.value.replace(/\D/g, '');
                    if (v.length > 1) { fill(i, v); return; }
                    b.value = v;
                    if (v && i < 5) boxes[i + 1].focus();
                    sync();
                });
                b.addEventListener('keydown', e => {
                    if (e.key === 'Backspace' && !b.value && i > 0) { boxes[i - 1].value = ''; boxes[i - 1].focus(); sync(); e.preventDefault(); }
                    if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
                    if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus();
                });
                b.addEventListener('paste', e => {
                    e.preventDefault();
                    fill(i, (e.clipboardData || window.clipboardData).getData('text'));
                });
                b.addEventListener('focus', () => b.select());
            });
            form.addEventListener('submit', e => {
                if (!/^[0-9]{6}$/.test(native.value)) { e.preventDefault(); SV.toast('Enter all six digits from your authenticator app.', 'warning'); boxes[0].focus(); }
            });
            boxes[0].focus();
        });
    }

    function initTotpTimer() {
        document.querySelectorAll('[data-totp-timer]').forEach(el => {
            const bar = el.querySelector('.bar');
            const ring = el.querySelector('.ring');
            const text = el.querySelector('[data-seconds]');
            const circumference = 2 * Math.PI * 10;
            if (bar) bar.style.strokeDasharray = String(circumference);
            const tick = () => {
                const left = 30 - (Math.floor(Date.now() / 1000) % 30);
                if (text) text.textContent = String(left);
                if (bar) bar.style.strokeDashoffset = String(circumference * (1 - left / 30));
                if (ring) ring.classList.toggle('low', left <= 5);
            };
            tick();
            setInterval(tick, 1000);
        });
    }

    function initConfirmButtons() {
        document.querySelectorAll('button[data-confirm]').forEach(btn => {
            const original = btn.innerHTML;
            let armed = false, timer;
            btn.addEventListener('click', e => {
                if (armed) return;
                e.preventDefault();
                armed = true;
                btn.textContent = btn.dataset.confirm;
                btn.classList.add('btn-danger');
                timer = setTimeout(() => { armed = false; btn.innerHTML = original; btn.classList.remove('btn-danger'); }, 4000);
            });
            btn.closest('form')?.addEventListener('submit', () => clearTimeout(timer));
        });
    }

    function initCopyButtons() {
        document.querySelectorAll('[data-copy]').forEach(btn => {
            btn.addEventListener('click', () => {
                const src = document.getElementById(btn.dataset.copy);
                if (src) SV.copy(src.textContent.trim(), btn.dataset.copyWhat || 'Text', btn);
            });
        });
    }

    function initLogFilter() {
        const table = document.getElementById('auditTable');
        if (!table) return;
        const rows = Array.from(table.querySelectorAll('tbody tr[data-category]'));
        const chips = document.querySelectorAll('[data-filter]');
        const search = document.getElementById('logSearch');
        const empty = document.getElementById('auditEmpty');
        let current = 'all';
        const apply = () => {
            const q = (search?.value || '').trim().toLowerCase();
            let shown = 0;
            rows.forEach(r => {
                const ok = (current === 'all' || r.dataset.category === current) && (!q || r.textContent.toLowerCase().includes(q));
                r.classList.toggle('hidden', !ok);
                if (ok) shown++;
            });
            if (empty) empty.classList.toggle('hidden', shown > 0);
        };
        chips.forEach(chip => chip.addEventListener('click', () => {
            chips.forEach(c => { c.classList.toggle('active', c === chip); c.setAttribute('aria-pressed', String(c === chip)); });
            current = chip.dataset.filter;
            apply();
        }));
        search?.addEventListener('input', apply);
    }

    SV.initPasswordToggles = initPasswordToggles;

    onReady(() => {
        initTheme();
        initFlashes();
        initPasswordToggles();
        initCapsLock();
        initStrength();
        initPatternHints();
        initMatch();
        initLoadingForms();
        initOtp();
        initTotpTimer();
        initConfirmButtons();
        initCopyButtons();
        initLogFilter();
    });
})();
