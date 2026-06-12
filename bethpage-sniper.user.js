// ==UserScript==
// @name         Bethpage Tee-Time Sniper v2.1
// @namespace    bethpage-bots
// @version      2.1.0
// @description  Wins the 7:00 PM slot race on the SERVER clock - re-runs the search until times appear, clicks the first acceptable tile, fills the booking modal, and either books OR hands off to you for the emailed one-time code / CAPTCHA. Never double-books.
// @match        https://foreupsoftware.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Paste this whole file into the DevTools console on the booking page,
 * or install it in Tampermonkey (same behavior, survives reloads).
 *
 * IMPORTANT - read this once:
 *   Since Oct 2025 Bethpage requires a ONE-TIME CODE EMAILED at booking
 *   time (and may show a CAPTCHA in the booking window). No script can or
 *   should bypass that - it is the point of the rule. So this bot's job
 *   is to WIN THE SLOT faster than any human: refresh the instant 7:00
 *   hits, grab the first good tee time, open and fill the booking window,
 *   and then HAND OFF to you with a loud banner to type the emailed code.
 *   You finishing the 2FA in ~10-20s is what completes the booking.
 *
 * GAME-DAY SHORT VERSION (full checklist in README.md):
 *   ~6:45 PM  Log in, clear any CAPTCHA, open the tee-times page.
 *             Select course / 18 holes / players / THE TARGET DATE.
 *             An empty times list is fine - that's expected before 7.
 *   ~6:50 PM  Paste this file. Read the "selector check" lines in the log.
 *   ~6:55 PM  Press ARM. Keep this tab FOCUSED (background tabs throttle
 *             timers to 1s+). Keep the Mac awake: `caffeinate -d`.
 *   7:00 PM   Hands near the keyboard. When the banner says
 *             "ENTER THE EMAILED CODE", check your email and type it in.
 *
 * Console handle: TTB
 *   TTB.config.searchEveryMs = 300   // live-tweak anything
 *   TTB.stop()                       // emergency stop
 *
 * States: idle -> armed -> searching -> attempting -> booking ->
 *         done | handoff (you finish 2FA) | verify (unknown - you check) | stopped
 */
(function () {
  'use strict';

  /* 0. Re-paste safety: tear down any previous copy. */
  try { if (window.__TTB_CLEANUP__) window.__TTB_CLEANUP__(); } catch (e) { /* ignore */ }
  const oldRoot = document.getElementById('ttb-root');
  if (oldRoot) oldRoot.remove();

  /* ------------------------------------------------------------------
   * 1. CONFIG. [UI] fields are overwritten from the on-screen inputs on
   *    ARM/TEST; everything else is console-only.
   *    Selectors reflect the real ForeUp page cross-verified across ~25
   *    public bots (Aug 2025); the dry run on game day re-verifies them.
   * ------------------------------------------------------------------ */
  const CONFIG = {
    // --- timing ---
    // [UI] fire on the SERVER clock, 24h HH:MM:SS.mmm. Default is ~1s before
    // the 7:00:00 PM release: enough margin to absorb clock-sync uncertainty
    // (~±90ms) and be already-polling when it flips, without turbo spraying a
    // lot of empty pre-release requests. Don't push it earlier than needed.
    fireTimeServer: '18:59:59.0',
    searchEveryMs: 350,            // re-run the search until tiles appear
    maxSearchMs: 180000,           // give up this long after fire if nothing secured
    modalWaitMs: 3500,             // tile click -> booking window timeout
    preBookDelayMs: 150,           // let the modal settle before Book
    outcomeWaitMs: 12000,          // Book click -> confirmation/error/code timeout
    resyncBeforeFireMs: 45000,     // re-sync the server clock at T-45s

    // --- what to book ---
    earliest: '5:00am',            // [UI] accept tee times from...
    latest: '8:00pm',              // [UI] ...to (inclusive)
    desiredPlayers: 4,             // [UI] players to select in the modal
    minPlayers: 1,                 // skip slots that can't seat this many
    preference: 'earliest',        // 'earliest' | 'latest' within the window
    maxFailsPerSlot: 2,            // give up on a slot after this many errors
    dryRun: false,                 // [UI] stop one click short of booking

    // --- API turbo (optional, advanced) ---
    // Also poll ForeUp's times endpoint DIRECTLY for the fastest possible
    // release detection, reusing your logged-in session (no stored creds, no
    // api_key tricks). The hold is still placed through the real UI tile, so
    // you get the same emailed-code handoff and it looks like a normal booking.
    // Trade-off: more requests during the brief search window - keep it polite,
    // and know that aggressive direct polling is the pattern bot-detection
    // watches for. Off by default; flip on in the console or the UI checkbox.
    apiTurbo: false,
    // Direct times-endpoint poll interval when apiTurbo is on. Floor is your
    // network round-trip time (the bot logs "rtt N ms" after syncing - you
    // can't detect faster than one round trip). 50ms is near that floor for a
    // NY->Oregon hop; going lower just adds request volume, not speed.
    apiPollEveryMs: 50,

    // --- selectors (verified against the LIVE Bethpage/ForeUp page, Jun 2026) ---
    // Clicking the "18 holes" filter makes ForeUp re-query times. NOTE: on
    // Bethpage the default-active holes filter is "Both" (data-value="all"),
    // so clicking [data-value="18"] both filters to 18 AND forces a refetch.
    searchClickSelectors: ['a.btn[data-value="18"]', 'a.btn.btn-primary[data-value="18"]'],
    // ForeUp also re-queries when the SELECTED day is re-clicked - used as a
    // backup refresh trigger so the search loop never stalls on a no-op click.
    refreshClickSelectors: ['.datepicker td.day.active', '.datepicker td.today', '.datepicker .day.active'],
    // Tile discovery is label-driven (climb from the time text to the card),
    // so we don't depend on the exact card class. On Bethpage the live card is
    // .booking-start-time-label -> .time-summary-left-top -> .time-summary ->
    // .js-summary (the delegated click target); clicking the card bubbles to it.
    tileTimeLabelSelector: '.booking-start-time-label, h4.start',
    tileSelector: '.js-summary, .time-summary, div.time.time-tile, .reserve-time, li.time-legacy, [class*="time-tile"], .time',
    modalSelectors: ['#book_time', '.time-details', '.modal.in', '.modal.show', '[role="dialog"]', '.booking-modal'],
    playerRowSelectors: ['.players', '.js-booking-players-row', '#book_time', '.time-details'],
    // The final submit button lives in the booking modal's footer. Verified
    // selectors plus text fallbacks (modal title is also "Book Time", so the
    // text match is scoped to buttons only by findBookButton).
    bookButtonSelectors: [
      '#book_time .modal-footer .js-book-button',
      '#book_time .modal-footer button.btn-success',
      '.time-details .modal-footer button.btn-success',
      '.js-book-button',
      'button[data-loading-text="Booking time..."]',
      'button[data-loading-text="Booking tee time..."]',
      'button.book-time-button',
    ],
    bookButtonTextPattern: /\bbook (?:time|tee time)\b|\breserve\b|\bconfirm\b|\bbook\b/i,
    closeButtonSelectors: ['#book_time [data-dismiss="modal"]', '.time-details [data-dismiss="modal"]', '[data-dismiss="modal"]', '.modal .close', 'button.cancel'],

    // Error/success scanning is SCOPED to dedicated alert containers (NOT the
    // whole modal body) so benign page text like "...error, call the pro
    // shop" can never abort a good attempt. #booking-error is the modal's own
    // error box (display:none until populated).
    errorSelectors: ['#booking-error', '.alert-danger', '.alert.alert-danger', '.growl-danger', '.growl-error', '.toast-error', '[role="alert"].alert-danger'],
    successSelectors: ['.js-booking-confirmation', '.alert-success', '.alert.alert-success', '.booking-confirmation'],
    errorTextPattern: /no longer available|not available|unavailable|has expired|expired|sold out|already have (?:a |an )?(?:pending )?reservation|pending reservation|could not be (?:completed|booked|made)|unable to|please try again|something went wrong/i,
    successTextPattern: /\bbooked\b|reservation (?:has been|was|is) (?:made|booked|confirmed)|successfully booked|will be held|is confirmed/i,

    // Human-gate detection (the 2FA the bot must NOT bypass). #payment-captcha
    // is Bethpage's body-level reCAPTCHA host (empty until the payment step).
    captchaSelectors: ['#payment-captcha', '#book_time #recaptcha', '.g-recaptcha', 'iframe[src*="recaptcha"]', 'iframe[title*="recaptcha" i]'],
    bookingCodeSelectors: [
      'input[name="reservation_confirmation_uid"]',
      'input[name*="confirmation_uid"]',
      'input[name*="booking_code"]',
      'input[id*="booking_code"]',
      'input[placeholder*="code" i]',
    ],

    // --- fun (runs only AFTER a confirmed booking) ---
    celebrate: true,
    capybaraUrl: 'https://img.itch.zone/aW1hZ2UvMjk4NTc3MC8xNzg1ODg5OS5naWY=/original/nA3Up1.gif',
    popOutImageUrls: [
      'https://www.pngkey.com/png/full/345-3455418_iu-iu-png.png',
      'https://www.pngarts.com/files/10/Rose-Blackpink-Transparent-Image.png',
      'https://www.pngplay.com/wp-content/uploads/13/BLACKPINK-PNG-Pic-Background.png',
    ],
  };

  /* ------------------------------------------------------------------
   * 2. STATE
   * ------------------------------------------------------------------ */
  const S = {
    state: 'idle',          // idle armed searching attempting booking done handoff verify stopped
    gen: 0,                 // attempt generation - bumped on each attack/stop/cleanup; stale async flows abort
    fireAtLocal: null,
    initialLead: null,
    firedAt: null,
    searchClicks: 0,
    failCounts: new Map(),
    clockOffsetMs: 0,       // serverNow = Date.now() + clockOffsetMs
    clockUncertainty: null,
    clockSynced: false,
    syncing: false,
    testDryRun: false,      // transient: set only by the TEST button, never sticky
    timers: new Set(),
    fireTimerId: null,
    searchInterval: null,
    apiInterval: null,
    timesUrl: null,         // the page's real /booking/times URL, sniffed from fetch/XHR
    apiHit: false,
    uiInterval: null,
    attemptErr: null,
    preBookErr: null,
    preBookSucc: null,
    warned: new Set(),
    logLines: [],
  };

  /* ------------------------------------------------------------------
   * 3. SMALL UTILS
   * ------------------------------------------------------------------ */
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function later(fn, ms) {
    const id = setTimeout(() => { S.timers.delete(id); fn(); }, ms);
    S.timers.add(id);
    return id;
  }

  function clearTimers() {
    for (const id of S.timers) clearTimeout(id);
    S.timers.clear();
    S.fireTimerId = null;
  }

  function textOf(el) { return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim(); }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  // Full pointer/mouse sequence so jQuery/Backbone handlers fire.
  function realClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ev = type.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ev(type, opts));
    }
    return true;
  }

  async function waitFor(fn, timeoutMs, intervalMs) {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 >= timeoutMs) return null;
      await sleep(intervalMs || 40);
    }
  }

  function warnOnce(msg) {
    if (S.warned.has(msg)) return;
    S.warned.add(msg);
    log(msg, 'warn');
  }

  function isLive() { return S.state === 'searching' || S.state === 'attempting' || S.state === 'booking'; }

  // The generation guard: returns true only if THIS attempt is still the
  // current one and the bot hasn't been stopped. This is what makes
  // STOP / re-ARM / re-paste safe - a stale async flow sees gen !== S.gen
  // and bails before it can click anything.
  function current(gen) { return gen === S.gen && S.state !== 'stopped'; }

  /* ------------------------------------------------------------------
   * 4. TIME PARSING / FORMATTING
   * ------------------------------------------------------------------ */
  function parseAmPm(s) {
    const m = String(s || '').trim().match(/(\d{1,2}):(\d{2})\s*([ap])\.?\s*m?\.?/i);
    if (!m) return null;
    let h = parseInt(m[1], 10) % 12;
    if (m[3].toLowerCase() === 'p') h += 12;
    return h * 60 + parseInt(m[2], 10);
  }

  function parseFireTime(s) {
    const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) return null;
    const h = +m[1], min = +m[2], sec = +m[3];
    if (h > 23 || min > 59 || sec > 59) return null;
    const frac = m[4] ? +((m[4] + '00').slice(0, 3)) : 0;
    return ((h * 60 + min) * 60 + sec) * 1000 + frac;
  }

  function pad(n, w) { return String(n).padStart(w || 2, '0'); }

  function fmtClock(epochMs) {
    const d = new Date(epochMs);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
  }

  function fmtDur(ms) {
    if (ms < 0) ms = 0;
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return m + ':' + pad(s) + '.' + pad(Math.floor(ms % 1000), 3);
  }

  function serverNow() { return Date.now() + S.clockOffsetMs; }
  function sinceFire() { return ((Date.now() - S.firedAt) / 1000).toFixed(2) + 's'; }

  // "06:51", "6:51am", "2026-06-16 06:51:00" -> minutes since midnight, or null
  function timeStrToMins(s) {
    const ap = parseAmPm(s);
    if (ap != null) return ap;
    const m = String(s || '').match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  /* ------------------------------------------------------------------
   * 4b. API TURBO - sniff the page's real times URL, then poll it directly
   *     for the fastest possible release detection (reuses the session).
   * ------------------------------------------------------------------ */
  function installApiSniffer() {
    const re = /\/booking\/times\b/i;
    try {
      const of = window.fetch;
      if (of && !of.__ttb) {
        window.fetch = function (input) {
          try { const u = typeof input === 'string' ? input : input && input.url; if (u && re.test(u)) S.timesUrl = u; } catch (e) { /* ignore */ }
          return of.apply(this, arguments);
        };
        window.fetch.__ttb = true;
      }
    } catch (e) { /* ignore */ }
    try {
      const oo = XMLHttpRequest.prototype.open;
      if (oo && !oo.__ttb) {
        XMLHttpRequest.prototype.open = function (method, url) {
          try { if (url && re.test(url)) S.timesUrl = url; } catch (e) { /* ignore */ }
          return oo.apply(this, arguments);
        };
        XMLHttpRequest.prototype.open.__ttb = true;
      }
    } catch (e) { /* ignore */ }
  }

  // Does the times JSON contain at least one slot inside our window?
  function apiHasTimes(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return /\d{1,2}:\d{2}/.test(text); }
    const arr = Array.isArray(data) ? data : (data.times || data.data || data.tee_times || []);
    if (!Array.isArray(arr) || !arr.length) return false;
    const lo = parseAmPm(CONFIG.earliest), hi = parseAmPm(CONFIG.latest);
    if (lo == null || hi == null) return true;
    for (const it of arr) {
      const mins = timeStrToMins((it && (it.time || it.label || it.start_time || it.teetime)) + '');
      if (mins == null) return true; // unparseable but non-empty -> trust it
      if (mins >= lo && mins <= hi) return true;
    }
    return false;
  }

  function startApiPoll() {
    if (!CONFIG.apiTurbo) return;
    if (!S.timesUrl) warnOnce('API turbo is ON but no times URL captured yet - the first search click will trigger one.');
    S.apiInterval = setInterval(function () {
      if (S.state !== 'searching' || !S.timesUrl) return;
      fetch(S.timesUrl, { credentials: 'include', cache: 'no-store' })
        .then(function (r) { return r.text(); })
        .then(function (txt) {
          if (S.state !== 'searching') return;
          if (apiHasTimes(txt)) {
            if (!S.apiHit) { S.apiHit = true; log('API: times released - forcing render + grab (+' + sinceFire() + ')', 'big'); }
            searchTick(); // render via the refresh click, then grab
          }
        })
        .catch(function () { /* transient - the next poll retries */ });
    }, CONFIG.apiPollEveryMs);
  }

  /* ------------------------------------------------------------------
   * 5. LOGGING (on-screen + console + localStorage postmortem)
   * ------------------------------------------------------------------ */
  function log(msg, cls) {
    const line = '[' + fmtClock(serverNow()) + '] ' + msg;
    S.logLines.push(line);
    try { console.log('[TTB]', line); } catch (e) { /* ignore */ }
    try { localStorage.setItem('ttb-last-log', JSON.stringify(S.logLines.slice(-400))); } catch (e) { /* ignore */ }
    const box = document.getElementById('ttb-log');
    if (!box) return;
    const div = document.createElement('div');
    div.textContent = line;
    div.style.color = cls === 'err' ? '#ff5f5f' : cls === 'warn' ? '#ffb347' : cls === 'big' ? '#5fff8f' : '#c8c8c8';
    if (cls === 'big') div.style.fontWeight = 'bold';
    box.appendChild(div);
    while (box.childNodes.length > 250) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  /* ------------------------------------------------------------------
   * 6. SERVER CLOCK SYNC (HTTP Date header tick-boundary detection)
   * ------------------------------------------------------------------ */
  async function probeDate() {
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(location.origin + '/?ttbclk=' + Math.random().toString(36).slice(2), {
        method: 'HEAD', cache: 'no-store',
      });
    } catch (e) { return null; }
    const t1 = performance.now();
    const hdr = res.headers.get('date');
    if (!hdr) return null;
    const ms = new Date(hdr).getTime();
    if (!isFinite(ms)) return null;
    return { serverMs: ms, mid: Date.now() - (t1 - t0) / 2, rtt: t1 - t0 };
  }

  async function syncClock() {
    if (S.syncing) return;
    S.syncing = true;
    try {
      log('Syncing to server clock…');
      const first = await probeDate();
      if (!first) { log('Server sent no usable Date header - falling back to your local clock.', 'warn'); return; }
      let prevSec = first.serverMs;
      let tick = null;
      const t0 = performance.now();
      while (performance.now() - t0 < 2500) {
        await sleep(85);
        const p = await probeDate();
        if (!p) continue;
        if (p.serverMs !== prevSec) { tick = p; break; }
        prevSec = p.serverMs;
      }
      if (tick) {
        S.clockOffsetMs = tick.serverMs - tick.mid;
        S.clockUncertainty = Math.round(tick.rtt / 2 + 90);
      } else {
        S.clockOffsetMs = (first.serverMs + 500) - first.mid;
        S.clockUncertainty = Math.round(first.rtt / 2 + 500);
      }
      S.clockSynced = true;
      log('Server clock offset: ' + (S.clockOffsetMs >= 0 ? '+' : '') + Math.round(S.clockOffsetMs) +
        ' ms (±' + S.clockUncertainty + ' ms, rtt ' + Math.round((tick || first).rtt) + ' ms)');
      if (S.state === 'armed') {
        const f = computeFireAt();
        if (f && Math.abs(f.fireAtLocal - S.fireAtLocal) < 6 * 3600 * 1000) {
          S.fireAtLocal = f.fireAtLocal;
          scheduleFire(); // re-aim, even if the new moment is EARLIER
        }
      }
    } catch (e) {
      log('Clock sync failed (' + (e && e.message) + ') - using local clock.', 'warn');
    } finally {
      S.syncing = false;
    }
  }

  /* ------------------------------------------------------------------
   * 7. SCHEDULING
   * ------------------------------------------------------------------ */
  function computeFireAt() {
    const msOfDay = parseFireTime(CONFIG.fireTimeServer);
    if (msOfDay == null) return null;
    const d = new Date(serverNow());
    d.setHours(0, 0, 0, 0);
    return { fireAtLocal: d.getTime() + msOfDay - S.clockOffsetMs };
  }

  function arm() {
    if (S.state === 'armed' || isLive()) { log('Already running - press STOP first.', 'warn'); return; }
    if (S.state === 'done' || S.state === 'handoff' || S.state === 'verify') {
      log('Already finished (' + S.state + '). Press STOP to reset before arming again.', 'warn');
      return;
    }
    S.testDryRun = false;
    readUi();
    const f = computeFireAt();
    if (!f) { log('Bad fire time "' + CONFIG.fireTimeServer + '" - use 24h HH:MM:SS.mmm, e.g. 18:59:59.80', 'err'); return; }
    if (parseAmPm(CONFIG.earliest) == null || parseAmPm(CONFIG.latest) == null) {
      log('Bad earliest/latest time - use e.g. "6:00am".', 'err'); return;
    }
    S.failCounts.clear();
    S.fireAtLocal = f.fireAtLocal;
    let lead = S.fireAtLocal - Date.now();

    if (lead <= 0 && lead > -15 * 60 * 1000) {
      setState('armed');
      log('Fire time just passed - FIRING NOW.', 'warn');
      fire();
      return;
    }
    if (lead <= 0) {
      S.fireAtLocal += 86400000;
      lead += 86400000;
      log('That time already passed today - scheduling for TOMORROW. Press STOP if that is wrong.', 'warn');
    }

    setState('armed');
    S.initialLead = lead;
    log('ARMED - firing at ' + CONFIG.fireTimeServer + ' on the server clock (' + fmtDur(lead) + ' from now)' +
      (S.clockSynced ? '' : ' [syncing clock now]'), 'big');
    if (!S.clockSynced) syncClock();
    if (lead > CONFIG.resyncBeforeFireMs + 15000) {
      later(function () {
        if (S.state !== 'armed') return;
        syncClock().then(function () { if (S.state === 'armed') log('Re-synced - fire in ' + fmtDur(S.fireAtLocal - Date.now())); });
      }, lead - CONFIG.resyncBeforeFireMs);
    }
    scheduleFire();
  }

  // Self-correcting fire scheduler: always reads S.fireAtLocal fresh, so a
  // clock re-aim (earlier OR later) is honored. Coarse timer down to ~1.5s,
  // then sub-ms busy-spin for the last stretch.
  function scheduleFire() {
    if (S.fireTimerId) { clearTimeout(S.fireTimerId); S.timers.delete(S.fireTimerId); S.fireTimerId = null; }
    const lead = S.fireAtLocal - Date.now();
    S.fireTimerId = later(precisionWait, Math.max(0, lead - 1500));
  }

  function precisionWait() {
    S.fireTimerId = null;
    if (S.state !== 'armed') return;
    const remain = S.fireAtLocal - Date.now();
    if (remain > 45) { S.fireTimerId = later(precisionWait, Math.min(remain - 40, 500)); return; }
    while (Date.now() < S.fireAtLocal) { /* spin */ }
    fire();
  }

  function stopLoops() {
    if (S.searchInterval) { clearInterval(S.searchInterval); S.searchInterval = null; }
    if (S.apiInterval) { clearInterval(S.apiInterval); S.apiInterval = null; }
    tileObserver.disconnect();
    clearTimers();
  }

  function stopBot(msg) {
    S.gen++; // invalidate any in-flight attempt
    stopLoops();
    S.testDryRun = false;
    setState('stopped');
    if (msg) log(msg, 'warn');
  }

  /* ------------------------------------------------------------------
   * 8. FIRE + SEARCH LOOP
   * ------------------------------------------------------------------ */
  const tileObserver = new MutationObserver(function () { maybeAttack(); });

  function fire() {
    if (S.state !== 'armed') return;
    setState('searching');
    S.firedAt = Date.now();
    S.searchClicks = 0;
    S.apiHit = false;
    log('FIRE - server clock ' + fmtClock(serverNow()) + (CONFIG.apiTurbo ? ' [API turbo ON]' : ''), 'big');
    if (document.hidden) log('THIS TAB IS IN THE BACKGROUND - timers are throttled. CLICK INTO THIS TAB NOW.', 'err');
    try { tileObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    searchTick();
    S.searchInterval = setInterval(searchTick, CONFIG.searchEveryMs);
    startApiPoll();
    later(function backstop() {
      if (S.state === 'searching' || S.state === 'attempting') {
        stopBot('Nothing secured ' + Math.round(CONFIG.maxSearchMs / 1000) + 's after fire - stopped. Take over by hand.');
      } else if (S.state === 'booking') {
        later(backstop, CONFIG.outcomeWaitMs); // let the in-flight Book resolve first
      }
    }, CONFIG.maxSearchMs);
  }

  function searchTick() {
    if (S.state !== 'searching') return;
    if (maybeAttack()) return;
    // Primary refresh: click the holes filter (forces a refetch + filters to
    // 18). Backup: re-click the selected day, which also re-queries times -
    // this keeps the loop refetching even after the holes filter is already 18.
    let clicked = false;
    for (const sel of CONFIG.searchClickSelectors) {
      const el = document.querySelector(sel);
      if (el) { realClick(el); clicked = true; break; }
    }
    if (S.searchClicks % 2 === 1) {
      for (const sel of CONFIG.refreshClickSelectors) {
        const el = document.querySelector(sel);
        if (el && !/disabled/.test(el.className)) { realClick(el); clicked = true; break; }
      }
    }
    if (!clicked) warnOnce('No search/refresh control found - check CONFIG.searchClickSelectors / refreshClickSelectors!');
    S.searchClicks++;
    if (S.searchClicks <= 3 || S.searchClicks % 10 === 0) log('searching… attempt ' + S.searchClicks + ' (+' + sinceFire() + ')');
  }

  function tileSpots(el) {
    const span = el.querySelector('.spots .spots, span.spots');
    if (span) { const n = parseInt(textOf(span), 10); if (Number.isInteger(n)) return n; }
    const m = textOf(el).match(/(\d+)\s*(?:player|spot|golfer)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // Tile discovery is label-driven: find each visible time label, then climb
  // to its clickable card. Robust to the exact card class (ForeUp click
  // handlers are delegated, so clicking the card - or the label - books it).
  function timeLabelNodes() { return document.querySelectorAll(CONFIG.tileTimeLabelSelector); }

  function cardFor(labelEl) {
    return labelEl.closest(CONFIG.tileSelector) || labelEl.closest('a[href], li, tr, .reserve-time') || labelEl.parentElement || labelEl;
  }

  function candidates() {
    const lo = parseAmPm(CONFIG.earliest);
    const hi = parseAmPm(CONFIG.latest);
    const out = [];
    const seen = new Set();
    for (const lab of timeLabelNodes()) {
      if (!visible(lab)) continue;
      const label = textOf(lab);
      const mins = parseAmPm(label);
      if (mins == null) continue;
      if (lo != null && mins < lo) continue;
      if (hi != null && mins > hi) continue;
      if ((S.failCounts.get(label) || 0) >= CONFIG.maxFailsPerSlot) continue;
      const card = cardFor(lab);
      if (seen.has(card)) continue;
      seen.add(card);
      const spots = tileSpots(card);
      if (spots != null && spots < CONFIG.minPlayers) continue;
      out.push({ el: card, label: label, mins: mins });
    }
    out.sort(function (a, b) { return CONFIG.preference === 'latest' ? b.mins - a.mins : a.mins - b.mins; });
    return out;
  }

  function findTileByLabel(label) {
    for (const lab of timeLabelNodes()) {
      if (visible(lab) && textOf(lab) === label) return cardFor(lab);
    }
    return null;
  }

  function maybeAttack() {
    if (S.state !== 'searching') return false;
    const cands = candidates();
    if (!cands.length) return false;
    attack(cands[0]);
    return true;
  }

  /* ------------------------------------------------------------------
   * 9. FEEDBACK DETECTION (scoped to alert containers only)
   * ------------------------------------------------------------------ */
  function feedback(selectors) {
    const out = [];
    const seen = new Set();
    for (const sel of selectors) {
      let els;
      try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of els) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (visible(el) && !el.closest('#ttb-root')) out.push(el);
      }
    }
    return out;
  }

  function snapshotErr() {
    const m = new Map();
    for (const el of feedback(CONFIG.errorSelectors)) m.set(el, textOf(el));
    return m;
  }
  function snapshotSucc() { return new Set(feedback(CONFIG.successSelectors)); }

  function newError(baseline) {
    for (const el of feedback(CONFIG.errorSelectors)) {
      const t = textOf(el);
      if (!t || !CONFIG.errorTextPattern.test(t)) continue;
      if (baseline && baseline.has(el) && baseline.get(el) === t) continue; // stale, ignore
      const i = Math.max(0, t.search(CONFIG.errorTextPattern) - 30);
      return { el: el, text: t.slice(i, i + 160) };
    }
    return null;
  }

  function newSuccess(baseline) {
    for (const el of feedback(CONFIG.successSelectors)) {
      if (baseline && baseline.has(el)) continue; // presence of a NEW success container is the signal
      return { el: el, text: textOf(el).slice(0, 160) || 'confirmation shown' };
    }
    return null;
  }

  function findBookingModal() {
    for (const sel of CONFIG.modalSelectors) {
      let els;
      try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of els) if (visible(el) && !el.closest('#ttb-root')) return el;
    }
    return null;
  }

  function findBookButton(modal) {
    for (const sel of CONFIG.bookButtonSelectors) {
      const el = modal.querySelector(sel);
      if (el && visible(el) && !el.disabled) return el;
    }
    for (const el of modal.querySelectorAll('button, a.btn, input[type="submit"]')) {
      const t = textOf(el) || el.value || '';
      if (visible(el) && !el.disabled && CONFIG.bookButtonTextPattern.test(t)) return el;
    }
    return null;
  }

  // The 2FA the bot must NOT bypass. Returns 'captcha' | 'code' | null.
  function detectHumanGate(modal) {
    // Bethpage's body-level reCAPTCHA host: populated (even if briefly hidden)
    // means a captcha is in play.
    const pc = document.getElementById('payment-captcha');
    if (pc && (pc.childElementCount > 0 || visible(pc))) return 'captcha';
    for (const sel of CONFIG.captchaSelectors) {
      const e = (modal && modal.querySelector(sel)) || document.querySelector(sel);
      if (e && e.id !== 'payment-captcha' && visible(e)) return 'captcha';
    }
    for (const sel of CONFIG.bookingCodeSelectors) {
      const e = (modal && modal.querySelector(sel)) || document.querySelector(sel);
      if (e && visible(e)) return 'code';
    }
    return null;
  }

  function closeAnyModal() {
    const modal = findBookingModal();
    if (modal) {
      for (const sel of CONFIG.closeButtonSelectors) {
        const b = modal.querySelector(sel) || document.querySelector(sel);
        if (b && visible(b)) { realClick(b); break; }
      }
    }
    for (const type of ['keydown', 'keyup']) {
      document.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    }
  }

  /* ------------------------------------------------------------------
   * 10. THE ATTACK - tile -> modal -> players -> checkbox ->
   *     (human gate? hand off) : Book -> outcome
   * ------------------------------------------------------------------ */
  function selectPlayers(modal) {
    let scope = null;
    for (const sel of CONFIG.playerRowSelectors) { scope = modal.querySelector(sel); if (scope) break; }
    scope = scope || modal;

    const btns = [];
    for (const elx of scope.querySelectorAll('a[data-value], button[data-value], div[data-value]')) {
      const v = parseInt(elx.getAttribute('data-value'), 10);
      if (Number.isInteger(v) && v >= 1 && v <= 6 && visible(elx) && !elx.disabled) btns.push({ el: elx, v: v });
    }
    if (btns.length) {
      const want = bestPlayers(btns.map(function (x) { return x.v; }));
      realClick(btns.filter(function (x) { return x.v === want; })[0].el);
      log('Players: clicked ' + want);
      return want;
    }
    for (const sel of scope.querySelectorAll('select')) {
      const vals = [];
      for (const o of sel.options) { const v = parseInt(o.value, 10); if (Number.isInteger(v) && v >= 1 && v <= 6) vals.push(v); }
      if (!vals.length) continue;
      const want = bestPlayers(vals);
      sel.value = String(want);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      log('Players: selected ' + want);
      return want;
    }
    log('No player control found - leaving the default.', 'warn');
    return null;

    function bestPlayers(vals) {
      const ok = vals.filter(function (v) { return v <= CONFIG.desiredPlayers; });
      return ok.length ? Math.max.apply(null, ok) : Math.min.apply(null, vals);
    }
  }

  function tickCheckboxes(modal) {
    for (const cb of modal.querySelectorAll('input[type="checkbox"]')) {
      if (cb.checked || !visible(cb)) continue;
      realClick(cb);
      if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      log('Ticked a checkbox in the booking window.');
    }
  }

  async function attack(cand) {
    const gen = ++S.gen; // new attempt invalidates any prior in-flight one
    setState('attempting');
    S.attemptErr = snapshotErr();

    const el = findTileByLabel(cand.label);
    if (!el) return failAttempt(cand, 'tile vanished before click (taken/re-rendered)', gen);

    log('-> ' + cand.label + ': clicking tile (+' + sinceFire() + ')');
    realClick(el);

    const res = await waitFor(function () {
      const m = findBookingModal();
      if (m) return { modal: m };
      const err = newError(S.attemptErr);
      if (err) return { err: err };
      return null;
    }, CONFIG.modalWaitMs, 40);

    if (!current(gen)) return;
    if (!res) return failAttempt(cand, 'booking window never appeared', gen);
    if (res.err) return failAttempt(cand, 'rejected: "' + res.err.text + '"', gen);

    const modal = res.modal;
    log('Booking window open (+' + sinceFire() + ')');
    selectPlayers(modal);
    tickCheckboxes(modal);
    await sleep(CONFIG.preBookDelayMs);
    if (!current(gen)) return;

    const lateErr = newError(S.attemptErr);
    if (lateErr) return failAttempt(cand, 'rejected: "' + lateErr.text + '"', gen);

    // Human gate present BEFORE Book (e.g. reCAPTCHA in the modal): we hold
    // the slot and hand off - we never try to solve or bypass it.
    const preGate = detectHumanGate(modal);
    if (preGate) return handoff(cand, gen, preGate, true);

    const btn = findBookButton(modal);
    if (!btn) return failAttempt(cand, 'no Book button found in the booking window', gen);

    const dry = CONFIG.dryRun || S.testDryRun;
    if (dry) {
      btn.style.outline = '4px solid #f0f';
      btn.style.outlineOffset = '2px';
      S.gen++;
      stopLoops();
      S.testDryRun = false;
      setState('stopped');
      log('DRY RUN complete - stopped one click short of booking ' + cand.label +
        '. The button it would press is highlighted. (+' + sinceFire() + ')', 'big');
      return;
    }

    S.preBookErr = snapshotErr();
    S.preBookSucc = snapshotSucc();
    log('Clicking "' + (textOf(btn) || 'Book') + '" (+' + sinceFire() + ')', 'big');
    realClick(btn);
    setState('booking');

    const outcome = await watchOutcome(gen);
    if (!current(gen)) return;
    if (outcome.gate) return handoff(cand, gen, outcome.gate, false);
    if (outcome.ok === true) return succeed(cand, gen, outcome.why);
    if (outcome.ok === false) return failAttempt(cand, outcome.why, gen);
    return haltUnknown(cand, gen);
  }

  async function watchOutcome(gen) {
    const t0 = performance.now();
    const startHref = location.href;
    while (performance.now() - t0 < CONFIG.outcomeWaitMs) {
      if (gen !== S.gen) return { ok: null };
      const err = newError(S.preBookErr);
      if (err) return { ok: false, why: 'booking failed: "' + err.text + '"' };
      const ok = newSuccess(S.preBookSucc);
      if (ok) return { ok: true, why: ok.text };
      const gate = detectHumanGate(findBookingModal());
      if (gate) return { ok: null, gate: gate };
      if (location.href !== startHref && /reserv|confirm/i.test(location.href)) return { ok: true, why: 'navigated to confirmation page' };
      await sleep(80);
    }
    return { ok: null };
  }

  async function failAttempt(cand, why, gen) {
    if (gen !== S.gen) return;
    log('x ' + cand.label + ': ' + why, 'warn');
    S.failCounts.set(cand.label, (S.failCounts.get(cand.label) || 0) + 1);
    closeAnyModal();
    await sleep(180);
    if (!current(gen) || (S.state !== 'attempting' && S.state !== 'booking')) return;
    setState('searching');
    if (!maybeAttack()) searchTick();
  }

  function succeed(cand, gen, why) {
    if (!current(gen)) return;
    S.gen++;
    stopLoops();
    setState('done');
    log('BOOKED ' + cand.label + ' - ' + String(why || '').trim() + ' (+' + sinceFire() +
      ' after fire). Verify on the confirmation screen and in your email NOW.', 'big');
    if (CONFIG.celebrate) celebrate();
  }

  // We won the slot but a human must finish the 2FA (emailed code / CAPTCHA).
  // Keep the modal and the hold; do NOT fall back.
  function handoff(cand, gen, kind, preBook) {
    if (!current(gen)) return;
    S.gen++;
    stopLoops();
    setState('handoff');
    const what = kind === 'captcha'
      ? (preBook ? 'SOLVE THE CAPTCHA, then enter the emailed code and click "Book Time"' : 'SOLVE THE CAPTCHA and enter the emailed code')
      : 'ENTER THE 6-DIGIT CODE FROM YOUR EMAIL, then click "Book Time"';
    log('SLOT HELD: ' + cand.label + ' (+' + sinceFire() + '). ' + what + ' - the booking window is open and waiting.', 'big');
    banner('✅ SLOT HELD: ' + cand.label + '\n' + what, '#7a00cc');
  }

  function haltUnknown(cand, gen) {
    if (!current(gen)) return;
    S.gen++;
    stopLoops();
    setState('verify');
    log('OUTCOME UNKNOWN for ' + cand.label + ' - Book was clicked but no confirmation, error, or code prompt appeared within ' +
      Math.round(CONFIG.outcomeWaitMs / 1000) + 's. HALTED so it cannot double-book. CHECK THE SCREEN AND YOUR EMAIL.', 'err');
    banner('OUTCOME UNKNOWN for ' + cand.label + '\nCHECK THE SCREEN AND YOUR EMAIL', '#c0392b');
  }

  function banner(text, bg) {
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;top:28%;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:' + (bg || '#c0f') + ';color:#fff;font:bold 22px/1.4 Arial;padding:24px 36px;border-radius:12px;cursor:pointer;' +
      'box-shadow:0 8px 40px rgba(0,0,0,.5);max-width:80vw;text-align:center;white-space:pre-line;';
    div.textContent = text + '\n(click to dismiss)';
    div.addEventListener('click', function () { div.remove(); });
    document.body.appendChild(div);
  }

  /* ------------------------------------------------------------------
   * 11. UI
   * ------------------------------------------------------------------ */
  function el(tag, style, props) {
    const e = document.createElement(tag);
    if (style) Object.assign(e.style, style);
    if (props) Object.assign(e, props);
    return e;
  }
  function $(sel) { return document.querySelector(sel); }

  function buildUi() {
    const root = el('div', {
      position: 'fixed', top: '0', left: '0', width: '100%', zIndex: '2147483000',
      background: '#16181d', color: '#e8e8e8', borderBottom: '2px solid #2a6fdb',
      font: '12px/1.5 Menlo, Monaco, monospace', padding: '6px 10px', boxSizing: 'border-box',
    }, { id: 'ttb-root' });

    const row = el('div', { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
    function field(t, input) { const w = el('label', { display: 'flex', alignItems: 'center', gap: '4px' }); w.appendChild(document.createTextNode(t)); w.appendChild(input); return w; }
    function textInput(id, value, width) {
      return el('input', { width: width, background: '#0c0d10', color: '#e8e8e8', border: '1px solid #444', borderRadius: '4px', padding: '2px 5px', font: 'inherit' }, { id: id, type: 'text', value: value });
    }
    function button(id, label, bg) {
      return el('button', { background: bg, color: '#fff', border: '0', borderRadius: '4px', padding: '4px 12px', font: 'inherit', fontWeight: 'bold', cursor: 'pointer' }, { id: id, textContent: label });
    }

    const fire = textInput('ttb-fire', CONFIG.fireTimeServer, '105px');
    const earliest = textInput('ttb-earliest', CONFIG.earliest, '70px');
    const latest = textInput('ttb-latest', CONFIG.latest, '70px');
    const players = el('select', { background: '#0c0d10', color: '#e8e8e8', border: '1px solid #444', borderRadius: '4px', font: 'inherit' }, { id: 'ttb-players' });
    for (let i = 1; i <= 4; i++) players.appendChild(el('option', null, { value: String(i), textContent: String(i), selected: i === CONFIG.desiredPlayers }));
    const dry = el('input', null, { id: 'ttb-dry', type: 'checkbox', checked: CONFIG.dryRun });
    const turbo = el('input', null, { id: 'ttb-turbo', type: 'checkbox', checked: CONFIG.apiTurbo });

    const syncBtn = button('ttb-sync', 'SYNC', '#555');
    const testBtn = button('ttb-test', 'TEST (dry)', '#8a6d00');
    const armBtn = button('ttb-arm', 'ARM', '#2a6fdb');
    const stopBtn = button('ttb-stop', 'STOP', '#a33');
    const status = el('span', { fontWeight: 'bold', color: '#999' }, { id: 'ttb-status', textContent: 'idle' });

    row.appendChild(el('span', { fontWeight: 'bold', color: '#5fff8f' }, { textContent: 'TTB v2.1' }));
    row.appendChild(field('fire@server', fire));
    row.appendChild(field('from', earliest));
    row.appendChild(field('to', latest));
    row.appendChild(field('players', players));
    row.appendChild(field('dry run', dry));
    row.appendChild(field('turbo', turbo));
    row.appendChild(syncBtn); row.appendChild(testBtn); row.appendChild(armBtn); row.appendChild(stopBtn); row.appendChild(status);

    const row2 = el('div', { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' });
    const barWrap = el('div', { flex: '1', height: '8px', background: '#0c0d10', borderRadius: '4px', overflow: 'hidden' });
    const bar = el('div', { height: '100%', width: '0%', background: 'linear-gradient(90deg,#002efc,#ff0000)', transition: 'width .1s linear' }, { id: 'ttb-bar' });
    barWrap.appendChild(bar);
    const countdown = el('span', { minWidth: '170px', fontWeight: 'bold' }, { id: 'ttb-countdown', textContent: '' });
    const offset = el('span', { color: '#8ab4ff' }, { id: 'ttb-offset', textContent: 'clock: local (not synced)' });
    row2.appendChild(barWrap); row2.appendChild(countdown); row2.appendChild(offset);

    const help = el('div', {
      marginTop: '4px', padding: '5px 9px', background: '#1f2733', border: '1px solid #2a6fdb',
      borderRadius: '4px', color: '#cfe3ff', fontSize: '11px', lineHeight: '1.55',
    });
    help.innerHTML =
      '<b style="color:#5fff8f">How to use &mdash; just 4 steps:</b><br>' +
      '<b>1.</b> Set <b>from</b>/<b>to</b> + <b>players</b>. Leave <b>fire@server</b> as-is. <b>dry&nbsp;run&nbsp;OFF</b> (tick <b>turbo</b> only for Black). &nbsp; ' +
      '<b>2.</b> Press <b>ARM</b> &mdash; it fires at 7:00 by itself. &nbsp; ' +
      '<b>3.</b> Keep this tab in front and <b>wait</b>.<br>' +
      '<b>4.</b> When the <b style="color:#c77dff">purple banner</b> appears &rarr; check your email, type the <b>6-digit code</b>, click <b>&ldquo;Book Time&rdquo;</b>.';

    const logBox = el('div', { marginTop: '4px', height: '104px', overflowY: 'auto', background: '#0c0d10', border: '1px solid #333', borderRadius: '4px', padding: '4px 6px', whiteSpace: 'pre-wrap' }, { id: 'ttb-log' });

    root.appendChild(row); root.appendChild(row2); root.appendChild(help); root.appendChild(logBox);
    document.body.appendChild(root);

    syncBtn.addEventListener('click', function () { syncClock(); });
    testBtn.addEventListener('click', testNow);
    armBtn.addEventListener('click', arm);
    stopBtn.addEventListener('click', function () { stopBot('Stopped by you.'); });
  }

  function readUi() {
    const f = $('#ttb-fire'), e = $('#ttb-earliest'), l = $('#ttb-latest'), p = $('#ttb-players'), d = $('#ttb-dry'), t = $('#ttb-turbo');
    if (f) CONFIG.fireTimeServer = f.value.trim();
    if (e) CONFIG.earliest = e.value.trim();
    if (l) CONFIG.latest = l.value.trim();
    if (p) CONFIG.desiredPlayers = parseInt(p.value, 10) || 4;
    if (d) CONFIG.dryRun = d.checked;
    if (t) CONFIG.apiTurbo = t.checked;
  }

  function setState(s) {
    S.state = s;
    const colors = {
      idle: '#999', armed: '#8ab4ff', searching: '#ffb347', attempting: '#ff5f5f',
      booking: '#ff5f5f', done: '#5fff8f', handoff: '#c77dff', verify: '#f0f', stopped: '#999',
    };
    const st = $('#ttb-status');
    if (st) { st.textContent = s.toUpperCase(); st.style.color = colors[s] || '#999'; }
  }

  function uiTick() {
    const off = $('#ttb-offset');
    if (!off) return;
    off.textContent = S.clockSynced
      ? 'server ' + (S.clockOffsetMs >= 0 ? '+' : '') + Math.round(S.clockOffsetMs) + 'ms ±' + S.clockUncertainty
      : 'clock: local (not synced)';
    const cd = $('#ttb-countdown'), bar = $('#ttb-bar');
    if (S.state === 'armed' && S.fireAtLocal) {
      const remain = Math.max(0, S.fireAtLocal - Date.now());
      cd.textContent = 'T-' + fmtDur(remain);
      if (S.initialLead) bar.style.width = Math.max(0, Math.min(100, 100 * (1 - remain / S.initialLead))) + '%';
    } else if (isLive() && S.firedAt) {
      cd.textContent = '+' + sinceFire() + ' · ' + S.searchClicks + ' searches';
      bar.style.width = '100%';
    }
  }

  function testNow() {
    if (S.state === 'armed' || isLive()) { log('Already running - press STOP first.', 'warn'); return; }
    readUi();
    S.failCounts.clear();
    S.testDryRun = true; // transient: does NOT touch CONFIG.dryRun or the checkbox
    setState('armed');
    S.fireAtLocal = Date.now();
    log('TEST: firing immediately in DRY RUN mode - nothing will be booked.');
    fire();
  }

  /* ------------------------------------------------------------------
   * 12. CELEBRATION (only after a CONFIRMED booking)
   * ------------------------------------------------------------------ */
  function celebrate() {
    try { spawnCapybaras(8000, 14); popOutImages(4); } catch (e) { /* never break anything */ }
  }
  function spawnCapybaras(durationMs, minCount) {
    const start = Date.now();
    let spawned = 0;
    const minY = window.innerHeight / 2, maxY = window.innerHeight - 80;
    (function loop() {
      if (Date.now() - start >= durationMs && spawned >= minCount) return;
      const img = el('img', { position: 'fixed', width: '60px', left: '-80px', top: (minY + Math.random() * (maxY - minY)) + 'px', zIndex: '2147483100', pointerEvents: 'none', transition: 'transform ' + (2.5 + Math.random() * 1.5) + 's linear' }, { src: CONFIG.capybaraUrl, alt: 'capybara' });
      document.body.appendChild(img);
      setTimeout(function () { img.style.transform = 'translateX(' + (window.innerWidth + 100) + 'px)'; }, 30);
      setTimeout(function () { img.remove(); }, 4200);
      spawned++;
      setTimeout(loop, 200 + Math.random() * 200);
    })();
  }
  function popOutImages(count) {
    for (let i = 0; i < count; i++) {
      const url = CONFIG.popOutImageUrls[Math.floor(Math.random() * CONFIG.popOutImageUrls.length)];
      const img = el('img', { position: 'fixed', width: '200px', left: (Math.random() * (window.innerWidth - 200)) + 'px', bottom: '-220px', zIndex: '2147483100', pointerEvents: 'none', transition: 'bottom 1.2s cubic-bezier(0.2,0.8,0.2,1), opacity 1s linear' }, { src: url, alt: 'celebration' });
      document.body.appendChild(img);
      setTimeout(function () { img.style.bottom = (40 + Math.random() * 120) + 'px'; }, 30);
      setTimeout(function () { img.style.opacity = '0'; setTimeout(function () { img.remove(); }, 1100); }, 1500 + Math.random() * 2500);
    }
  }

  /* ------------------------------------------------------------------
   * 13. INIT
   * ------------------------------------------------------------------ */
  window.__TTB_CLEANUP__ = function () {
    S.gen++;
    stopLoops();
    if (S.uiInterval) clearInterval(S.uiInterval);
    const r = document.getElementById('ttb-root');
    if (r) r.remove();
  };

  window.TTB = {
    version: '2.1.0',
    config: CONFIG,
    state: S,
    arm: arm,
    stop: function () { stopBot('Stopped via console.'); },
    test: testNow,
    sync: syncClock,
  };

  function selfCheck() {
    const tz = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || 'unknown';
    if (!/New_York/.test(tz)) log('Heads up: this machine’s timezone is ' + tz + ', not America/New_York. Times are interpreted in the MACHINE timezone.', 'warn');
    let found = 0;
    for (const sel of CONFIG.searchClickSelectors) found += document.querySelectorAll(sel).length;
    log('selector check: search control -> ' + found + ' match(es)' + (found ? '' : '  <-- FIX BEFORE 7PM'), found ? undefined : 'err');
    log('selector check: tiles (' + CONFIG.tileSelector + ') -> ' + document.querySelectorAll(CONFIG.tileSelector).length + ' (0 is normal before release)');
    log('Reminder: Bethpage requires an EMAILED one-time code at booking. The bot wins the slot, then the banner tells YOU to type the code.', 'warn');
    try { if (localStorage.getItem('ttb-last-log')) log('Previous run log saved - view: JSON.parse(localStorage.getItem("ttb-last-log")).join("\\n")'); } catch (e) { /* ignore */ }
  }

  installApiSniffer();
  buildUi();
  log('Bethpage Tee-Time Sniper v2.1 loaded. Set times, then ARM (or TEST for a dry run).', 'big');
  selfCheck();
  S.uiInterval = setInterval(uiTick, 100);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && (S.state === 'armed' || isLive())) log('Tab went to the BACKGROUND - timers throttle. Come back to this tab!', 'err');
  });
  syncClock();
})();
