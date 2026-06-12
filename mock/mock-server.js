/*
 * Mock of the ForeUp booking page, used by the Playwright e2e tests.
 *
 * Replicates the parts of the real flow the sniper drives, including the
 * 2025 reality the research surfaced (timed cart hold on tile click; a
 * one-time emailed code / in-modal reCAPTCHA before a booking finalizes):
 *  - GET  /                      booking page (18-holes filter, times list)
 *  - GET  /api/booking/times     [] before release, tee times after it
 *  - POST /api/booking/hold      tile click -> a stateful, EXCLUSIVE,
 *                                EXPIRING hold; second hold while one is
 *                                live is rejected ("pending reservation")
 *  - POST /api/booking/release   modal close -> frees the hold
 *  - POST /api/booking/reserve   Book -> needs players+agreement; can fail,
 *                                go ambiguous, expire, or demand a code
 *  - every response carries a Date header on the (skewed) server clock
 *
 * Test control:
 *  - POST /test/config           reset state + override config
 *  - GET  /test/state            bookings, hold, counters, clock info
 */
const http = require('http');

const PORT = Number(process.env.PORT || 4399);

let cfg, booked, counters, hold;

function reset(overrides) {
  cfg = Object.assign({
    clockSkewMs: 0,        // server clock = real clock + skew
    releaseInMs: 5000,     // times open this many ms after config
    teeTimes: null,        // [{mins, spots}] or null for generated default
    snipeFirst: 0,         // first N times fail at hold ("no longer available")
    bookFailFirst: 0,      // first N times fail at reserve
    expireFirst: 0,        // first N times reserve as "hold has expired"
    ambiguousFirst: 0,     // first N times reserve with NO ui signal
    captchaInModal: false, // modal shows a reCAPTCHA (human gate before Book)
    codeAfterBook: false,  // reserve demands an emailed one-time code (human gate after Book)
    holdExclusive: true,   // reject a second hold while one is live
    holdExpiryMs: 0,       // 0 = never expires; else hold dies this long after placed
    labelFormat: 'compact', // 'compact' "6:24pm" | 'spaced' "6:24 PM"
    responseDelayMs: 0,
  }, overrides || {});
  cfg.releaseAtMs = Date.now() + cfg.clockSkewMs + cfg.releaseInMs;
  booked = [];
  counters = { times: 0, hold: 0, release: 0, reserve: 0 };
  hold = null; // { label, at }
}
reset({});

function serverNow() { return Date.now() + cfg.clockSkewMs; }

function holdLive() {
  if (!hold) return false;
  if (cfg.holdExpiryMs && serverNow() - hold.at > cfg.holdExpiryMs) { hold = null; return false; }
  return true;
}

function label(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ap = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  const mm = String(m).padStart(2, '0');
  return cfg.labelFormat === 'spaced' ? `${h12}:${mm} ${ap.toUpperCase()}` : `${h12}:${mm}${ap}`;
}

function defaultTimes() {
  const out = [];
  for (let m = 6 * 60; m <= 18 * 60; m += 9) out.push({ mins: m, spots: 4 - (Math.floor(m / 9) % 4) });
  return out;
}
function allTimes() { return (cfg.teeTimes || defaultTimes()).map((t) => ({ label: label(t.mins), spots: t.spots })); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function json(res, obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); }
function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
  });
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>ForeUp Mock - Bethpage State Park</title>
<style>
 body { font-family: Arial, sans-serif; margin: 0; padding-top: 190px; }
 .filters { padding: 10px; border-bottom: 1px solid #ccc; }
 .btn { display: inline-block; padding: 6px 14px; border: 1px solid #888; border-radius: 4px;
        margin-right: 6px; cursor: pointer; text-decoration: none; color: #222; background: #eee; }
 .btn-primary { background: #2a6fdb; color: #fff; }
 .btn-success { background: #2e9e44; color: #fff; }
 #times-container { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; }
 .time-tile { border: 1px solid #aaa; border-radius: 6px; padding: 10px 14px; cursor: pointer; background: #f5fff0; }
 .booking-start-time-label { font-weight: bold; display: block; }
 .spots { color: #555; font-size: 12px; }
 .modal { position: fixed; top: 22%; left: 50%; transform: translateX(-50%); width: 440px; background: #fff;
          border: 2px solid #444; border-radius: 8px; padding: 16px; z-index: 5000; }
 .modal-footer { margin-top: 12px; }
 .alert { padding: 10px 14px; border-radius: 6px; margin: 8px; }
 .alert-danger { background: #fdd; border: 1px solid #c33; color: #800; }
 .alert-success { background: #dfd; border: 1px solid #3a3; color: #060; }
 .close { float: right; cursor: pointer; border: 0; background: none; font-size: 18px; }
 .player-btn.active { background: #2a6fdb; color: #fff; }
 .g-recaptcha { width: 304px; height: 78px; background: #f9f9f9; border: 1px solid #d3d3d3;
                display: flex; align-items: center; justify-content: center; margin: 8px 0; }
</style></head>
<body>
<div class="filters">
  <span>Sat Jun 20 2026 &middot; Bethpage Black</span>
  <a href="#" class="btn btn-default" data-value="9">9 Holes</a>
  <a href="#" class="btn btn-primary active" data-value="18">18 Holes</a>
</div>
<div id="alerts"></div>
<div id="times-container"><div class="no-times">No times available for this date.</div></div>
<script>
(function () {
  var selectedPlayers = 0;

  document.querySelectorAll('.filters [data-value]').forEach(function (btn) {
    btn.addEventListener('click', function (e) { e.preventDefault(); loadTimes(); });
  });

  function loadTimes() {
    return fetch('/api/booking/times?ts=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var box = document.getElementById('times-container');
        box.innerHTML = '';
        if (!data.times.length) { box.innerHTML = '<div class="no-times">No times available for this date.</div>'; return; }
        data.times.forEach(function (t) {
          var tile = document.createElement('div');
          tile.className = 'time time-tile';
          tile.innerHTML = '<span class="booking-start-time-label">' + t.label + '</span>' +
            '<span class="spots">' + t.spots + ' Players</span>';
          tile.addEventListener('click', function () { holdTime(t); });
          box.appendChild(tile);
        });
      });
  }

  function holdTime(t) {
    fetch('/api/booking/hold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: t.label }) })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { showAlert('danger', data.error); loadTimes(); return; }
        openModal(t, data);
      });
  }

  function openModal(t, holdData) {
    closeModal(true);
    selectedPlayers = 0;
    var m = document.createElement('div');
    m.id = 'book_time';
    m.className = 'modal in';
    m.setAttribute('role', 'dialog');
    var players = '';
    for (var i = 1; i <= t.spots; i++) players += '<a href="#" class="btn btn-default player-btn js-booking-players-row" data-value="' + i + '">' + i + '</a>';
    m.innerHTML =
      '<button class="close" data-dismiss="modal">&times;</button>' +
      '<h3>' + t.label + ' - Bethpage Black</h3>' +
      '<div class="modal-body">' +
        '<p>Players:</p><div class="js-booking-players-row player-row">' + players + '</div>' +
        '<p><label><input type="checkbox" id="agree-box"> I agree to the cancellation policy</label></p>' +
        '<p class="policy">In the event of an error with your reservation, please call the pro shop.</p>' +
        (holdData && holdData.captcha ? '<div id="recaptcha" class="g-recaptcha">[ reCAPTCHA - check the box ]</div>' : '') +
        '<div id="code-area"></div>' +
      '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-success book-time-button js-book-button" data-loading-text="Booking time...">Book Time</button>' +
      '</div>';
    document.body.appendChild(m);
    m.querySelectorAll('.player-btn').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        m.querySelectorAll('.player-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        selectedPlayers = Number(b.getAttribute('data-value'));
      });
    });
    m.querySelector('.close').addEventListener('click', function () { closeModal(); });
    m.querySelector('.js-book-button').addEventListener('click', function () {
      if (!selectedPlayers) { showAlert('danger', 'Please select the number of players.', m); return; }
      if (!m.querySelector('#agree-box').checked) { showAlert('danger', 'You must agree to the cancellation policy.', m); return; }
      fetch('/api/booking/reserve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: t.label, players: selectedPlayers, agreed: true }) })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok && data.ambiguous) return;                 // spinner of doom - no signal
          if (data.ok && data.needsCode) {                       // emailed one-time code gate
            m.querySelector('#code-area').innerHTML =
              '<p>Enter the booking code we just emailed you:</p>' +
              '<input type="text" name="reservation_confirmation_uid" placeholder="Enter booking code">';
            return;
          }
          if (!data.ok) { showAlert('danger', data.error, m); return; }
          m.querySelector('.modal-body').innerHTML = '<div class="alert alert-success">Success! Your reservation is booked for ' + t.label + '.</div>';
          loadTimes();
        });
    });
  }

  function closeModal(silent) {
    var m = document.getElementById('book_time');
    if (m) m.remove();
    if (!silent) fetch('/api/booking/release', { method: 'POST' });
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  function showAlert(kind, text, parent) {
    var d = document.createElement('div');
    d.className = 'alert alert-' + kind;
    d.textContent = text;
    var host = parent ? (parent.querySelector('.modal-body') || parent) : document.getElementById('alerts');
    host.appendChild(d);
    setTimeout(function () { d.remove(); }, 2500);
  }
})();
</script>
</body></html>`;

const server = http.createServer(async (req, res) => {
  res.setHeader('Date', new Date(serverNow()).toUTCString()); // sniper's sync source
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (cfg.responseDelayMs) await sleep(cfg.responseDelayMs);

  if (u.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.method === 'HEAD') return res.end();
    return res.end(PAGE);
  }

  if (u.pathname === '/api/booking/times') {
    counters.times++;
    const open = serverNow() >= cfg.releaseAtMs;
    const list = open ? allTimes().filter((t) => !booked.some((b) => b.label === t.label)) : [];
    return json(res, { times: list });
  }

  if (u.pathname === '/api/booking/hold' && req.method === 'POST') {
    counters.hold++;
    const body = await readJson(req);
    const labels = allTimes().map((t) => t.label);
    const idx = labels.indexOf(body.label);
    if (idx === -1 || idx < cfg.snipeFirst || booked.some((b) => b.label === body.label)) {
      return json(res, { ok: false, error: 'That tee time is no longer available.' });
    }
    if (cfg.holdExclusive && holdLive() && hold.label !== body.label) {
      return json(res, { ok: false, error: 'You already have a pending reservation. Finish or cancel it first.' });
    }
    hold = { label: body.label, at: serverNow() };
    return json(res, { ok: true, captcha: !!cfg.captchaInModal });
  }

  if (u.pathname === '/api/booking/release' && req.method === 'POST') {
    counters.release++;
    hold = null;
    return json(res, { ok: true });
  }

  if (u.pathname === '/api/booking/reserve' && req.method === 'POST') {
    counters.reserve++;
    const body = await readJson(req);
    const labels = allTimes().map((t) => t.label);
    const idx = labels.indexOf(body.label);
    if (!body.players || !body.agreed) return json(res, { ok: false, error: 'Please complete all required fields.' });
    if (!holdLive() || hold.label !== body.label) return json(res, { ok: false, error: 'Your hold has expired. Please try again.' });
    if (idx > -1 && idx < cfg.expireFirst) { hold = null; return json(res, { ok: false, error: 'Your hold has expired. Please try again.' }); }
    if (idx > -1 && idx < cfg.ambiguousFirst) return json(res, { ok: true, ambiguous: true });
    if (idx > -1 && idx < cfg.bookFailFirst) return json(res, { ok: false, error: 'Sorry, your booking could not be completed.' });
    if (cfg.codeAfterBook) return json(res, { ok: true, needsCode: true }); // human must enter emailed code
    hold = null;
    booked.push({ label: body.label, players: body.players, at: serverNow() });
    return json(res, { ok: true });
  }

  if (u.pathname === '/test/config' && req.method === 'POST') {
    reset(await readJson(req));
    return json(res, { ok: true, releaseAtMs: cfg.releaseAtMs, times: allTimes().map((t) => t.label) });
  }

  if (u.pathname === '/test/state') {
    return json(res, { booked, counters, hold, now: serverNow(), releaseAtMs: cfg.releaseAtMs, times: allTimes().map((t) => t.label) });
  }

  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, () => console.log(`ForeUp mock on http://127.0.0.1:${PORT} (release in ${cfg.releaseInMs} ms)`));
