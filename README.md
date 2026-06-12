# 🏌️ Bethpage Tee-Time Sniper v2.1

Wins a Bethpage State Park tee time the instant the **7:00 PM** release hits.
A ground-up rewrite of a 2025 vibe-coded console script — re-architected by
**Claude Fable 5** with a fleet of research and adversarial-review subagents,
and **proven by a Playwright e2e suite (16/16)** against a faithful mock of
the ForeUp booking flow.

> **The honest headline.** Since **Oct 9, 2025** Bethpage requires a
> **one-time code emailed at booking time** (email 2FA), and reCAPTCHA can
> appear in the booking window. No script can — or should — bypass that;
> it's the whole point of the rule. So this bot's job is to **win the slot
> race** (refresh → grab the first good tee time → open and fill the booking
> window faster than any human) and then **hand off to you with a loud banner
> to type the emailed code**. That division of labor is what gets you the
> time, legitimately, almost every night.

---

## What's in here

| File | What it is |
|---|---|
| `bethpage-sniper.user.js` | **The bot.** Paste into the DevTools console on the booking page (or install in Tampermonkey). |
| `mock/mock-server.js` | A mock ForeUp site: empty times before a release timestamp, tiles after, stateful/expiring holds, snipe races, the booking modal, a skewable server clock, and the CAPTCHA / emailed-code 2FA gates. |
| `tests/sniper.spec.js` | Playwright e2e proof — 16 scenarios, all passing. |
| `playwright.config.js`, `package.json` | Test harness wiring. |

---

## Why the original only worked *sometimes*, and what v2.1 changed

The 2025 script was clever but had five failure modes that each cost a night:

1. **It searched exactly once.** It clicked the "18 holes" button one time at
   fire and then polled the DOM every 5 ms forever. If that single request
   landed before the server released the times, it waited on tiles that would
   never come. → **v2.1 re-runs the search every 350 ms until tiles appear.**
2. **It trusted the laptop clock.** The release fires on ForeUp's *server*
   clock; a 2-second-fast Mac means you've already lost. → **v2.1 measures the
   server clock from HTTP `Date` headers (tick-boundary detection, ~±100 ms)
   and fires on server time, re-syncing at T-45 s.**
3. **It stopped at the tile click.** Clicking a tile only opens the booking
   modal — players, checkbox, and "Book Time" still need clicking, which is
   exactly the window where you get sniped. → **v2.1 selects players, ticks
   the agreement checkbox, and clicks "Book Time" itself.**
4. **No fallback.** If your slot got taken, it gave up. → **v2.1 closes the
   error and attacks the next acceptable tile (2 tries per slot).**
5. **It celebrated mid-flow.** Capybaras spawned *before* booking finished,
   burning main-thread time at the worst moment. → **v2.1 only celebrates
   after a confirmed booking.**

Plus the things that didn't exist in 2025:

6. **The emailed one-time code + in-modal reCAPTCHA.** → **v2.1 detects these
   human gates, holds the slot, and stops with a banner telling you to finish
   the 2FA — it never tries to solve or bypass them.**
7. **Never double-books.** Every async step is tagged with an attempt
   *generation*; STOP / re-ARM / re-paste invalidate stale flows so a delayed
   callback can't fire a second booking. If the outcome of a "Book" click is
   ever ambiguous, the bot **halts** instead of guessing.

---

## Game-day checklist (7:00 PM ET)

- **Earlier in the day — rehearse.** Open the booking page and press
  **TEST (dry)** on a date that already has visible tee times. Watch the log:
  it should click a tile, open the booking window, pick players, tick the
  checkbox, and stop one click short with the "Book" button highlighted. If a
  step fails, the log names the exact `CONFIG` selector to fix. *(TEST never
  books and never sticks dry-run on.)*
- **~6:45 PM** — Log in, clear any CAPTCHA, go to tee times. Select course,
  18 holes, players, and **the target date**. An empty list is expected.
- **~6:50 PM** — Paste `bethpage-sniper.user.js`. Check the `selector check`
  log lines and that a server-clock offset prints.
- **~6:52 PM** — Terminal: `caffeinate -d` (keeps the Mac awake).
- **~6:55 PM** — Set your window (`from`/`to`), players, confirm **dry run is
  OFF**, press **ARM**.
- **7:00 PM** — Keep the tab **focused** (background tabs throttle timers to
  1 s+). When the banner says **"ENTER THE ONE-TIME CODE"**, check your email
  and type it into the booking window. Done.
- **If anything looks wrong** — press **STOP** and book by hand; it's still a
  normal page. The full log persists:
  `JSON.parse(localStorage.getItem("ttb-last-log")).join("\n")`.

---

## Knobs (`TTB.config.<x> = ...` in the console)

- `fireTimeServer` — default `18:59:59.80` (server clock). Early firing is
  safe: the first attempts return empty, then the 7:00:00 attempt hits.
- `searchEveryMs` (350) · `modalWaitMs` · `outcomeWaitMs` · `maxSearchMs`
- `earliest` / `latest` / `desiredPlayers` / `minPlayers` / `preference`
- All selectors live in `CONFIG`; the dry-run log tells you which to update if
  the page changed.

---

## Running the tests

```bash
npm install        # once
npm test           # 16 e2e scenarios against the mock ForeUp site
npm run mock       # poke the mock yourself at http://127.0.0.1:4399
```

**Scenarios covered:** release-after-fire (empty searches first, books <2.5 s
after release) · benign "error" text in the modal does **not** abort a good
booking · snipe fallback · Book-failure with proper hold release (no
double-hold lockout) · expired-hold recovery · CAPTCHA gate → human handoff ·
emailed-code gate → human handoff · 90 s server-clock skew · earliest/latest
window · dry run · TEST-doesn't-stick regression guard · ambiguous-outcome
halt (double-booking guard) · STOP can't be resurrected by a late async tick ·
panic-mode late arming · spaced time labels ("6:00 AM") · 250 ms latency.

---

## How this was built: a Fable 5 multi-agent refactor

This wasn't a one-shot rewrite. The original was handed over as a single
pasted file with the note *"it worked a few times but not every time."* Here's
the actual process **Claude Fable 5** used to turn it into something tested.

### 1. Read the original closely
First pass was pure comprehension: tracing the 2025 script end to end —
`executeAtTargetTime` → click `data-value="18"` → `clickFirstAvailableTile` →
the 5 ms DOM poll — and writing down *why each path could fail on release
night*, not just what it did. That produced the five failure modes above.

### 2. Fan out a research subagent fleet (parallel)
A background **Workflow** launched three research agents at once, each given a
different brief and forced to return structured, source-cited findings:
- **platform & rules / anti-bot** — confirmed Bethpage runs on ForeUp
  (`foreupsoftware.com/index.php/booking/19765/2431`), the 7 PM / 7-day
  resident window, the **$5 non-refundable fee (May 2025)**, and the pivotal
  **Oct 9 2025 emailed one-time code (email 2FA)** — the single fact that
  reshaped the design.
- **DOM selectors** — swept ~25 public ForeUp/Bethpage bots, extracted the
  real selectors for every step, then a **verification sub-agent** demanded a
  second independent source for each. That's how `#book_time`,
  `button.js-book-button` ("Book Time"), the `.js-booking-players-row` player
  buttons, `.alert-danger` errors, and `.js-booking-confirmation` success
  signals landed in `CONFIG` with confidence levels.
- **release timing & runtime** — confirmed the HTTP `Date`-header clock-sync
  approach, that pre-release requests return empty lists, and the browser
  background-tab timer-throttling traps to design around.

### 3. Build in parallel with the research
While the fleet searched, Fable wrote the v2 bot, the mock ForeUp server, and
the first Playwright suite — so research findings could be folded in as they
arrived rather than blocking on them.

### 4. Adversarial review fleet (parallel, multi-lens)
A second **Workflow** ran three reviewers over the code from different lenses
— **state-machine correctness**, **game-day realism vs. the real ForeUp
page**, and **test/mock fidelity** — and then spawned **adversarial verifier
sub-agents** that tried to *refute* each finding before it counted. Confirmed
findings drove real fixes:
- a stale-async race that could break the never-double-book guarantee →
  **attempt-generation tokens**;
- **TEST permanently flipping dry-run on** (would've made the real 7 PM run
  stop one click short!) → made transient;
- the error-scan **false-positiving on benign modal text** → scoped error/
  success detection to dedicated alert containers. *(The mock now ships that
  exact boilerplate — "...error with your reservation, please call the pro
  shop" — and a test asserts it doesn't abort a booking.)*
- the mock's **stateless holds** → rewrote them as stateful, **exclusive,
  expiring** holds with a release endpoint, then added tests that only pass if
  the bot releases correctly and recovers from an expired hold.

### 5. Prove it
Every fix is locked in by an e2e test that drives the actual `.user.js` in a
real browser against the mock and asserts on the mock's server-side booking
ledger. **16/16 green.**

> Built with [Claude Code](https://claude.com/claude-code) (Fable 5) using
> background Workflow orchestration — parallel research and adversarial-review
> subagent fleets with structured outputs and refute-first verification.

---

## Honest caveats

- **No bot can *guarantee* a slot.** This one removes every failure mode we
  could find and reproduce, but it still competes with other humans for finite
  inventory, and the **emailed code requires you in the loop**. What it
  guarantees is that you reach the code-entry screen faster than a person
  clicking by hand.
- **Re-verify selectors on game day.** The mock mirrors the 2025/known
  structure; the dry run on the real page is what validates `CONFIG` against
  reality, and it books nothing.
- **Terms of use.** Automated booking is likely against the site's terms, and
  NY has been cracking down on Bethpage tee-time *resale* bots. This is built
  for **personal use** — one golfer, polite request volume (a few requests/sec
  only during the brief search window), no account sharing. Use it that way.
