/*
  Lead capture for every page.
  - Remembers where a visitor came from (UTM tags, partner ?ref= code, Meta click id).
  - Sends any form marked data-lead-form="<name>" to /api/lead (a Cloudflare Pages Function),
    which forwards it to GoHighLevel. Then it opens the thank-you page.
  - Loads the Meta Pixel when SITE_CONFIG.metaPixelId is set, and fires a Lead event
    with the same event id the server sends, so Meta counts it once.
  - Fills [data-fill] placeholders on legal pages from SITE_CONFIG.
  On previews (localhost, github.io, file://) nothing is sent: the form just opens the
  thank-you page so the flow can be tested.
*/
(function () {
  var CFG = window.SITE_CONFIG || {};
  var script = document.currentScript;
  var BASE = script ? script.src.replace(/assets\/lead\.js.*$/, '') : '/';
  var host = location.hostname;
  var DEMO = CFG.previewMode === true || location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1' || /github\.io$/.test(host);

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function cookie(name) { var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; }
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2); }

  // ---------- 1. Attribution ----------
  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'fbclid', 'gclid'];
  var params = new URLSearchParams(location.search);
  var touch = {};
  KEYS.forEach(function (k) { if (params.get(k)) touch[k] = params.get(k).slice(0, 120); });
  if (Object.keys(touch).length) {
    touch.landing_page = location.pathname;
    touch.at = new Date().toISOString();
    if (!read('bm_first_touch')) store('bm_first_touch', JSON.stringify(touch));
    store('bm_last_touch', JSON.stringify(touch));
  }
  if (!read('bm_first_referrer') && document.referrer && document.referrer.indexOf(location.host) === -1) {
    store('bm_first_referrer', document.referrer.slice(0, 300));
  }
  if (params.get('fbclid') && !cookie('_fbc')) {
    document.cookie = '_fbc=fb.1.' + Date.now() + '.' + params.get('fbclid') + ';path=/;max-age=7776000;SameSite=Lax';
  }

  function attribution() {
    var first = {}, last = {};
    try { first = JSON.parse(read('bm_first_touch') || '{}'); } catch (e) {}
    try { last = JSON.parse(read('bm_last_touch') || '{}'); } catch (e) {}
    var src = last.ref ? 'partner:' + last.ref
      : last.utm_source ? last.utm_source + (last.utm_medium ? '/' + last.utm_medium : '')
      : last.fbclid ? 'meta/paid'
      : last.gclid ? 'google/paid'
      : read('bm_first_referrer') ? 'referral:' + (read('bm_first_referrer').split('/')[2] || '')
      : 'direct';
    return { source: src, first_touch: first, last_touch: last, referrer: read('bm_first_referrer') || '' };
  }

  // ---------- 2. Meta Pixel (only when configured) ----------
  if (CFG.metaPixelId && !DEMO) {
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', CFG.metaPixelId);
    window.fbq('track', 'PageView');
  }

  // ---------- 3. Optional Cloudflare Turnstile ----------
  function loadTurnstile() {
    if (!CFG.turnstileSiteKey || DEMO) return;
    var boxes = document.querySelectorAll('[data-turnstile]');
    if (!boxes.length) return;
    window.bmTurnstileReady = function () {
      boxes.forEach(function (b) { window.turnstile.render(b, { sitekey: CFG.turnstileSiteKey, size: 'flexible' }); });
    };
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=bmTurnstileReady&render=explicit';
    s.async = true; document.head.appendChild(s);
  }

  // ---------- 4. Form submission ----------
  function normalizePhone(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return v;
  }

  function submit(form, formName) {
    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = typeof v === 'string' ? v.trim() : v; });
    var payload = {
      form: formName,
      fields: data,
      phone: normalizePhone(data.phone),
      email: data.email || '',
      sms_consent: !!data.sms_consent,
      page: location.href.split('#')[0],
      attribution: attribution(),
      event_id: uuid(),
      fbp: cookie('_fbp'),
      fbc: cookie('_fbc'),
      turnstile: data['cf-turnstile-response'] || ''
    };
    delete payload.fields['cf-turnstile-response'];
    var next = BASE + 'thank-you/?f=' + encodeURIComponent(formName);

    if (DEMO) {
      console.info('[preview] lead not sent. It would post this to /api/lead:', payload);
      return Promise.resolve(next);
    }
    return fetch(BASE + 'api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) throw new Error('Lead endpoint returned ' + r.status);
      // Fire the browser Lead event on the next page so the redirect can't cut it off.
      try { sessionStorage.setItem('bm_lead_event', JSON.stringify({ id: payload.event_id, form: formName })); } catch (e) {}
      return next;
    });
  }

  function wire(form) {
    var name = form.getAttribute('data-lead-form') || 'consultation';
    var btn = form.querySelector('[type="submit"]');
    var err = form.querySelector('[data-lead-error]');
    form.setAttribute('novalidate', '');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (err) err.hidden = true;
      if (!form.checkValidity()) { form.reportValidity(); return; }
      if (btn) { btn.disabled = true; btn.dataset.label = btn.dataset.label || btn.innerHTML; btn.innerHTML = 'Sending…'; }
      submit(form, name).then(function (next) { location.href = next; }).catch(function (ex) {
        console.error(ex);
        if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label; }
        if (err) {
          var contact = CFG.phoneDisplay ? ' Please call or text ' + CFG.phoneDisplay + '.' : ' Please try again in a minute.';
          err.textContent = 'Sorry, that didn’t go through.' + contact;
          err.hidden = false;
        }
      });
    }, true);
  }

  // ---------- 5. Fill placeholders from SITE_CONFIG ----------
  function get(path) { return path.split('.').reduce(function (o, k) { return o && o[k]; }, CFG); }
  function fill() {
    document.querySelectorAll('[data-fill]').forEach(function (el) {
      var v = get(el.getAttribute('data-fill'));
      if (v) { el.textContent = v; el.classList.remove('ph'); }
      else { el.classList.add('ph'); }
    });
    document.querySelectorAll('[data-fill-soft]').forEach(function (el) {
      var v = get(el.getAttribute('data-fill-soft'));
      if (v) el.textContent = v;
    });
    document.querySelectorAll('[data-href-phone]').forEach(function (a) {
      if (CFG.phone) a.href = 'tel:' + CFG.phone; else a.hidden = true;
    });
    document.querySelectorAll('[data-href-email]').forEach(function (a) {
      if (CFG.email) a.href = 'mailto:' + CFG.email; else a.hidden = true;
    });
  }

  function firePendingLead() {
    var pending = null;
    try { pending = JSON.parse(sessionStorage.getItem('bm_lead_event') || 'null'); sessionStorage.removeItem('bm_lead_event'); } catch (e) {}
    if (pending && window.fbq) window.fbq('track', 'Lead', { content_name: pending.form }, { eventID: pending.id });
  }

  function showIf() {
    document.querySelectorAll('[data-show-if]').forEach(function (el) {
      if (!get(el.getAttribute('data-show-if'))) el.remove();
    });
  }

  function giveawayPill() {
    var g = CFG.giveaway || {};
    if (!g.live || !document.body.hasAttribute('data-giveaway-pill')) return;
    try { if (sessionStorage.getItem('bm_pill_closed')) return; } catch (e) {}
    var css = document.createElement('style');
    css.textContent = '#bmPill{position:fixed;right:16px;bottom:16px;z-index:94;display:flex;align-items:center;gap:12px;max-width:min(420px,calc(100vw - 24px));padding:12px 12px 12px 16px;border-radius:18px;background:#0b100d;border:1px solid rgba(43,226,106,.45);box-shadow:0 18px 40px -14px rgba(0,0,0,.8);font:500 14px/1.35 Inter,system-ui,sans-serif;color:#f4f7f5;animation:bmIn .5s ease 1.5s both}'
      + '#bmPill b{color:#2BE26A}#bmPill a.go{flex:none;background:#2BE26A;color:#041007;text-decoration:none;font-weight:700;padding:10px 14px;border-radius:999px;white-space:nowrap}'
      + '#bmPill button{flex:none;background:none;border:0;color:#9aa7a0;font-size:20px;line-height:1;cursor:pointer;padding:4px}'
      + '@keyframes bmIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}'
      + '@media(max-width:640px){#bmPill{left:12px;right:12px;max-width:none}}';
    document.head.appendChild(css);
    var pill = document.createElement('div');
    pill.id = 'bmPill';
    pill.innerHTML = '<span>\ud83c\udf81 <b>Giveaway:</b> win a free credit repair program</span><a class="go" href="' + BASE + 'giveaway/">Enter</a><button type="button" aria-label="Close">\u00d7</button>';
    pill.querySelector('button').onclick = function () { pill.remove(); try { sessionStorage.setItem('bm_pill_closed', '1'); } catch (e) {} };
    document.body.appendChild(pill);
    // sit above the preview version switcher when it's showing
    var vsw = document.getElementById('vsw');
    if (vsw && getComputedStyle(vsw).display !== 'none') pill.style.bottom = '68px';
  }

  function init() {
    firePendingLead();
    showIf();
    giveawayPill();
    document.querySelectorAll('form[data-lead-form]').forEach(wire);
    fill();
    loadTurnstile();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.BMLead = { submit: submit, attribution: attribution, base: BASE, demo: DEMO };
})();
