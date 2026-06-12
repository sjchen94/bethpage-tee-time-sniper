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
    fireTimeServer: '18:59:59.80', // [UI] fire on the SERVER clock, 24h HH:MM:SS.mmm
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

    // --- selectors ---
    // Clicking the "18 holes" filter makes ForeUp re-query times.
    searchClickSelectors: ['a.btn.btn-primary[data-value="18"]', 'a.btn[data-value="18"]'],
    tileSelector: 'div.time.time-tile, li.time-legacy, .time.time-tile',
    tileTimeLabelSelector: '.booking-start-time-label',
    modalSelectors: ['#book_time', '.booking-modal', '.modal.in', '.modal.show', '[role="dialog"]'],
    playerRowSelectors: ['.js-booking-players-row', '#book_time'],
    bookButtonSelectors: [
      '#book_time .modal-footer .js-book-button',
      '.js-book-button',
      'button[data-loading-text="Booking time..."]',
      'button[data-loading-text="Booking tee time..."]',
      'button.book-time-button',
    ],
    bookButtonTextPattern: /\bbook (?:time|tee time)\b|\bbook\b/i,
    closeButtonSelectors: ['#book_time [data-dismiss="modal"]', '[data-dismiss="modal"]', '.modal .close', 'button.cancel'],

    // Error/success scanning is SCOPED to dedicated alert containers (NOT the
    // whole modal body) so benign page text like "...error, call the pro
    // shop" can never abort a good attempt.
    errorSelectors: ['.alert-danger', '.alert.alert-danger', '.growl-danger', '.growl-error', '.toast-error', '[role="alert"].alert-danger'],
    successSelectors: ['.js-booking-confirmation', '.alert-success', '.alert.alert-success'],
    errorTextPattern: /no longer available|not available|unavailable|has expired|expired|sold out|already have (?:a |an )?(?:pending )?reservation|pending reservation|could not be (?:completed|booked|made)|unable to|please try again|something went wrong/i,
    successTextPattern: /\bbooked\b|reservation (?:has been|was|is) (?:made|booked|confirmed)|successfully booked|will be held|is confirmed/i,

    // Human-gate detection (the 2FA the bot must NOT bypass).
    captchaSelectors: ['#book_time #recaptcha', '.g-recaptcha', 'iframe[src*="recaptcha"]', 'iframe[title*="recaptcha" i]'],
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
    log('FIRE - server clock ' + fmtClock(serverNow()), 'big');
    if (document.hidden) log('THIS TAB IS IN THE BACKGROUND - timers are throttled. CLICK INTO THIS TAB NOW.', 'err');
    try { tileObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    searchTick();
    S.searchInterval = setInterval(searchTick, CONFIG.searchEveryMs);
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
    let clicked = false;
    for (const sel of CONFIG.searchClickSelectors) {
      const el = document.querySelector(sel);
      if (el) { realClick(el); clicked = true; break; }
    }
    if (!clicked) warnOnce('Search control not found (' + CONFIG.searchClickSelectors.join(' , ') + ') - fix CONFIG.searchClickSelectors!');
    if (clicked) {
      S.searchClicks++;
      if (S.searchClicks <= 3 || S.searchClicks % 10 === 0) log('searching… attempt ' + S.searchClicks + ' (+' + sinceFire() + ')');
    }
  }

  function tileSpots(el) {
    const m = textOf(el).match(/(\d+)\s*(?:player|spot|golfer)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function candidates() {
    const lo = parseAmPm(CONFIG.earliest);
    const hi = parseAmPm(CONFIG.latest);
    const out = [];
    for (const el of document.querySelectorAll(CONFIG.tileSelector)) {
      if (!visible(el)) continue;
      const label = textOf(el.querySelector(CONFIG.tileTimeLabelSelector)) || labelFromTile(el);
      const mins = parseAmPm(label);
      if (mins == null) continue;
      if (lo != null && mins < lo) continue;
      if (hi != null && mins > hi) continue;
      if ((S.failCounts.get(label) || 0) >= CONFIG.maxFailsPerSlot) continue;
      const spots = tileSpots(el);
      if (spots != null && spots < CONFIG.minPlayers) continue;
      out.push({ el: el, label: label, mins: mins });
    }
    out.sort(function (a, b) { return CONFIG.preference === 'latest' ? b.mins - a.mins : a.mins - b.mins; });
    return out;
  }

  // Fallback if the dedicated label node isn't found: read the first time
  // token out of the tile's own text.
  function labelFromTile(el) {
    const m = textOf(el).match(/\b\d{1,2}:\d{2}\s*[ap]\.?\s*m?\.?/i);
    return m ? m[0] : '';
  }

  function findTileByLabel(label) {
    for (const el of document.querySelectorAll(CONFIG.tileSelector)) {
      if (!visible(el)) continue;
      const l = textOf(el.querySelector(CONFIG.tileTimeLabelSelector)) || labelFromTile(el);
      if (l === label) return el;
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
    for (const sel of CONFIG.captchaSelectors) {
      const e = (modal && modal.querySelector(sel)) || document.querySelector(sel);
      if (e && visible(e)) return 'captcha';
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
      ? (preBook ? 'SOLVE THE CAPTCHA, then click Book Time, then enter the emailed code' : 'SOLVE THE CAPTCHA and enter the emailed code')
      : 'ENTER THE ONE-TIME CODE FROM YOUR EMAIL';
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
    row.appendChild(syncBtn); row.appendChild(testBtn); row.appendChild(armBtn); row.appendChild(stopBtn); row.appendChild(status);

    const row2 = el('div', { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' });
    const barWrap = el('div', { flex: '1', height: '8px', background: '#0c0d10', borderRadius: '4px', overflow: 'hidden' });
    const bar = el('div', { height: '100%', width: '0%', background: 'linear-gradient(90deg,#002efc,#ff0000)', transition: 'width .1s linear' }, { id: 'ttb-bar' });
    barWrap.appendChild(bar);
    const countdown = el('span', { minWidth: '170px', fontWeight: 'bold' }, { id: 'ttb-countdown', textContent: '' });
    const offset = el('span', { color: '#8ab4ff' }, { id: 'ttb-offset', textContent: 'clock: local (not synced)' });
    row2.appendChild(barWrap); row2.appendChild(countdown); row2.appendChild(offset);

    const logBox = el('div', { marginTop: '4px', height: '110px', overflowY: 'auto', background: '#0c0d10', border: '1px solid #333', borderRadius: '4px', padding: '4px 6px', whiteSpace: 'pre-wrap' }, { id: 'ttb-log' });

    root.appendChild(row); root.appendChild(row2); root.appendChild(logBox);
    document.body.appendChild(root);

    syncBtn.addEventListener('click', function () { syncClock(); });
    testBtn.addEventListener('click', testNow);
    armBtn.addEventListener('click', arm);
    stopBtn.addEventListener('click', function () { stopBot('Stopped by you.'); });
  }

  function readUi() {
    const f = $('#ttb-fire'), e = $('#ttb-earliest'), l = $('#ttb-latest'), p = $('#ttb-players'), d = $('#ttb-dry');
    if (f) CONFIG.fireTimeServer = f.value.trim();
    if (e) CONFIG.earliest = e.value.trim();
    if (l) CONFIG.latest = l.value.trim();
    if (p) CONFIG.desiredPlayers = parseInt(p.value, 10) || 4;
    if (d) CONFIG.dryRun = d.checked;
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

  buildUi();
  log('Bethpage Tee-Time Sniper v2.1 loaded. Set times, then ARM (or TEST for a dry run).', 'big');
  selfCheck();
  S.uiInterval = setInterval(uiTick, 100);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && (S.state === 'armed' || isLive())) log('Tab went to the BACKGROUND - timers throttle. Come back to this tab!', 'err');
  });
  syncClock();
})();
