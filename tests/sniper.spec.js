/*
 * End-to-end proof that the sniper wins a tee time against a faithful
 * mock of the ForeUp release flow (mock/mock-server.js).
 *
 * Each test: configure the mock (release moment, snipes, skew, 2FA gates,
 * ...), load the page, inject bethpage-sniper.user.js exactly as a user
 * would paste it, drive the bot's own UI, and assert against the mock's
 * server-side ledger (bookings, hold, request counters).
 */
const { test, expect } = require('@playwright/test');
const path = require('path');

const BOT_PATH = path.join(__dirname, '..', 'bethpage-sniper.user.js');

function fmtFire(epochMs) {
  const d = new Date(epochMs);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

async function configure(request, data) {
  const res = await request.post('/test/config', { data });
  expect(res.ok()).toBeTruthy();
  return res.json(); // { ok, releaseAtMs, times: [labels...] }
}
async function getState(request) { return (await request.get('/test/state')).json(); }

async function inject(page, botCfg = {}) {
  await page.goto('/');
  await page.addScriptTag({ path: BOT_PATH });
  await page.evaluate(
    (c) => Object.assign(window.TTB.config, c),
    Object.assign({ celebrate: false, outcomeWaitMs: 4000, modalWaitMs: 2500 }, botCfg),
  );
  await page.waitForFunction(() => window.TTB.state.clockSynced, null, { timeout: 10000 });
}

async function armAndWaitFor(page, opts) {
  const { fire, earliest = '5:00am', latest = '8:00pm', dry = false, endState = 'done', timeout = 25000 } = opts;
  if (fire) await page.fill('#ttb-fire', fire);
  await page.fill('#ttb-earliest', earliest);
  await page.fill('#ttb-latest', latest);
  if (dry) await page.check('#ttb-dry');
  await page.click('#ttb-arm');
  await page.waitForFunction((s) => window.TTB.state.state === s, endState, { timeout });
}

async function botLog(page) { return page.evaluate(() => window.TTB.state.logLines.join('\n')); }

test('books the first slot when times release after fire (empty searches first, <2.5s)', async ({ page, request }) => {
  const { times } = await configure(request, { releaseInMs: 8000 });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 2500), earliest: '6:00am', latest: '6:00pm' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(1);
  expect(st.booked[0].label).toBe(times[0]);
  expect(st.booked[0].players).toBe(4);
  expect(st.booked[0].at).toBeGreaterThanOrEqual(st.releaseAtMs);
  expect(st.booked[0].at - st.releaseAtMs).toBeLessThan(2500); // speed proof
  expect(st.counters.times).toBeGreaterThanOrEqual(2);          // searched while empty
  expect(st.hold).toBeNull();                                   // no leaked hold
  expect(await botLog(page)).toContain('BOOKED ' + times[0]);
});

test('benign "error" text in the modal body never aborts a good booking', async ({ page, request }) => {
  // The mock's modal contains "...error with your reservation, please call
  // the pro shop." A naive error-scan would treat that as a failure.
  const { times } = await configure(request, { releaseInMs: 1500 });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 1000), earliest: '6:00am', latest: '6:00pm' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(1);
  expect(st.booked[0].label).toBe(times[0]);
});

test('falls back to the next tile when the first is sniped', async ({ page, request }) => {
  const { times } = await configure(request, { releaseInMs: 2000, snipeFirst: 1 });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 1000), earliest: '6:00am', latest: '6:00pm' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(1);
  expect(st.booked[0].label).toBe(times[1]);
  const log = await botLog(page);
  expect(log).toContain('no longer available');
  expect(log).toContain('BOOKED ' + times[1]);
});

test('releases its hold and falls back when the Book click fails (no double-hold lockout)', async ({ page, request }) => {
  // holdExclusive is on: if the bot did NOT release before the next hold,
  // the second hold would be rejected ("pending reservation") and it could
  // livelock. Booking the second slot proves the release path works.
  const { times } = await configure(request, { releaseInMs: 2000, bookFailFirst: 1, holdExclusive: true });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 1000), earliest: '6:00am', latest: '6:00pm' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(1);
  expect(st.booked[0].label).toBe(times[1]);
  expect(st.hold).toBeNull();
  expect(st.counters.release).toBeGreaterThanOrEqual(1);
  expect(await botLog(page)).toContain('could not be completed');
});

test('recovers from an expired hold by re-holding the next slot', async ({ page, request }) => {
  const { times } = await configure(request, { releaseInMs: 2000, expireFirst: 1 });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 1000), earliest: '6:00am', latest: '6:00pm' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(1);
  expect(st.booked[0].label).toBe(times[1]);
  expect(await botLog(page)).toContain('expired');
});

test('hands off (never books) when a CAPTCHA gates the booking window', async ({ page, request }) => {
  await configure(request, { releaseInMs: 1500, captchaInModal: true });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 1000), earliest: '6:00am', latest: '6:00pm', endState: 'handoff' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(0);     // bot never bypasses the captcha
  expect(st.counters.reserve).toBe(0);   // didn't even click Book
  expect(st.hold).not.toBeNull();        // but it HELD the slot for the human
  expect(await botLog(page)).toContain('SLOT HELD');
});

test('hands off for the emailed one-time code after clicking Book', async ({ page, request }) => {
  await configure(request, { releaseInMs: 1500, codeAfterBook: true });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 1000), earliest: '6:00am', latest: '6:00pm', endState: 'handoff' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(0);
  expect(st.counters.reserve).toBe(1);   // it clicked Book (which triggers the email)...
  expect(st.hold).not.toBeNull();        // ...and holds while the human types the code
  expect(await botLog(page)).toContain('ENTER THE ONE-TIME CODE');
});

test('syncs to a server clock 90s ahead and books at the server release moment', async ({ page, request }) => {
  const SKEW = 90000;
  await configure(request, { releaseInMs: 5000, clockSkewMs: SKEW });
  await inject(page);

  const offset = await page.evaluate(() => window.TTB.state.clockOffsetMs);
  expect(Math.abs(offset - SKEW)).toBeLessThan(800);

  await armAndWaitFor(page, { fire: fmtFire(Date.now() + SKEW + 4000), earliest: '6:00am', latest: '6:00pm' });
  const st = await getState(request);
  expect(st.booked).toHaveLength(1);
  expect(st.booked[0].at).toBeGreaterThanOrEqual(st.releaseAtMs);
});

test('respects the earliest/latest window', async ({ page, request }) => {
  await configure(request, { releaseInMs: 1500, teeTimes: [{ mins: 330, spots: 4 }, { mins: 900, spots: 4 }] });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 1000), earliest: '6:00am', latest: '6:00pm' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(1);
  expect(st.booked[0].label).toBe('3:00pm');
});

test('dry run walks the whole flow but never books', async ({ page, request }) => {
  await configure(request, { releaseInMs: 1500 });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 1000), dry: true, endState: 'stopped' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(0);
  expect(st.counters.hold).toBeGreaterThanOrEqual(1);
  expect(st.counters.reserve).toBe(0);
  expect(await botLog(page)).toContain('DRY RUN complete');
});

test('TEST (dry) does not stick - a real ARM afterwards books for real', async ({ page, request }) => {
  // Regression guard: v2.0 left dry-run permanently on after TEST.
  await configure(request, { releaseInMs: -1000 }); // times already visible
  await inject(page);
  await page.click('#ttb-test');
  await page.waitForFunction(() => window.TTB.state.state === 'stopped', null, { timeout: 15000 });
  expect((await getState(request)).booked).toHaveLength(0);
  expect(await page.evaluate(() => window.TTB.config.dryRun)).toBe(false);

  await configure(request, { releaseInMs: 800 }); // fresh release
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 600), earliest: '6:00am', latest: '6:00pm' });
  expect((await getState(request)).booked).toHaveLength(1);
});

test('halts (never double-books) when the booking outcome is ambiguous', async ({ page, request }) => {
  await configure(request, { releaseInMs: 1500, ambiguousFirst: 1 });
  await inject(page, { outcomeWaitMs: 2500 });
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 1000), earliest: '6:00am', latest: '6:00pm', endState: 'verify' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(0);
  expect(st.counters.reserve).toBe(1); // exactly one Book attempt, then HALT
  expect(await botLog(page)).toContain('OUTCOME UNKNOWN');
});

test('STOP mid-search cannot be resurrected by a later async tick', async ({ page, request }) => {
  await configure(request, { releaseInMs: 1500 });
  await inject(page);
  await page.fill('#ttb-fire', fmtFire(Date.now() + 800));
  await page.fill('#ttb-earliest', '6:00am');
  await page.fill('#ttb-latest', '6:00pm');
  await page.click('#ttb-arm');
  await page.waitForFunction(() => window.TTB.state.state === 'searching', null, { timeout: 8000 });
  await page.click('#ttb-stop');
  await page.waitForTimeout(2500);

  const st = await getState(request);
  expect(st.booked).toHaveLength(0);
  expect(await page.evaluate(() => window.TTB.state.state)).toBe('stopped');
});

test('fires immediately when armed just after the fire time (panic mode)', async ({ page, request }) => {
  const { times } = await configure(request, { releaseInMs: -1000 });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() - 2000), earliest: '6:00am', latest: '6:00pm' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(1);
  expect(st.booked[0].label).toBe(times[0]);
  expect(await botLog(page)).toContain('FIRING NOW');
});

test('parses spaced/uppercase time labels ("6:00 AM")', async ({ page, request }) => {
  const { times } = await configure(request, { releaseInMs: 1500, labelFormat: 'spaced' });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 1000), earliest: '6:00am', latest: '6:00pm' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(1);
  expect(st.booked[0].label).toBe(times[0]);
});

test('still books when every server response is slow (250ms latency)', async ({ page, request }) => {
  const { times } = await configure(request, { releaseInMs: 2500, responseDelayMs: 250 });
  await inject(page);
  await armAndWaitFor(page, { fire: fmtFire(Date.now() + 1000), earliest: '6:00am', latest: '6:00pm' });

  const st = await getState(request);
  expect(st.booked).toHaveLength(1);
  expect(st.booked[0].label).toBe(times[0]);
});
