# 🏌️ Bethpage Tee-Time Sniper v2.1

Wins a Bethpage State Park tee time the instant the **7:00 PM** release hits.
A ground-up rewrite of a 2025 vibe-coded console script — re-architected by
**Claude Fable 5** with a fleet of research and adversarial-review subagents,
and **proven by a Playwright e2e suite (18/18)** against a faithful mock of
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

## 🚀 Run it (about 60 seconds)

**Step 1 — Copy the bot to your clipboard.** One command (always grabs the
latest version):

```bash
curl -sL https://raw.githubusercontent.com/jardysuntan/bethpage-tee-time-sniper/main/bethpage-sniper.user.js | pbcopy
```

> Have the repo cloned locally? Use `pbcopy < bethpage-sniper.user.js` instead.
> No Terminal? Open [the raw file](https://raw.githubusercontent.com/jardysuntan/bethpage-tee-time-sniper/main/bethpage-sniper.user.js), select all (**⌘A**), copy (**⌘C**).

**Step 2 — Paste it into the page.** On the Bethpage booking page, open the
Chrome console with **⌥⌘J** (Option-Command-J), click into it, paste (**⌘V**),
and press **Enter**.

> If Chrome blocks the paste, type **`allow pasting`**, press Enter, then paste again.

A dark **TTB** control bar appears at the top of the page, with a built-in
4-step guide printed right on it.

**Step 3 — Use it. This is the entire job:**

1. Set your **`from`** / **`to`** time window and **`players`**. Leave
   **`fire@server`** at `18:59:59.0`. Tick **`turbo`** only if you're going for
   Black. **Make sure `dry run` is UNCHECKED.**
2. Press **ARM**. It fires at 7:00 automatically.
3. Keep the tab in front and **wait** — hands off the keyboard.
4. When the **purple banner** appears: **check your email, type the 6-digit
   code into the booking window, and click "Book Time."**

> **You only do two things live:** press **ARM** after pasting, and **type the
> emailed code** when the purple banner pops. Everything in between — refreshing
> at 7:00, grabbing the first open slot, filling the booking window — is
> automatic.

👉 **Want it minute-by-minute for game day? See [GAMEDAY.md](GAMEDAY.md).**

> **Rehearse for free first:** start the mock (`npm install && npm run mock`),
> open http://127.0.0.1:4399, paste the bot, and click **TEST (dry)** to watch
> the whole flow without booking anything. See [Running the tests](#running-the-tests).

---

## What's in here

| File | What it is |
|---|---|
| `bethpage-sniper.user.js` | **The bot.** Paste into the DevTools console on the booking page (or install in Tampermonkey). |
| [`GAMEDAY.md`](GAMEDAY.md) | **The 7:00 PM runbook** — the minute-by-minute checklist for the real run. |
| `mock/mock-server.js` | A mock ForeUp site: empty times before a release timestamp, tiles after, stateful/expiring holds, snipe races, the booking modal, a skewable server clock, and the CAPTCHA / emailed-code 2FA gates. |
| `tests/sniper.spec.js` | Playwright e2e proof — 18 scenarios, all passing. |
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

## Two modes: click-sim (default) and API turbo

The bot ships with both approaches, because they win different things:

- **Click-sim (default).** Refreshes and clicks the real visible tile, exactly
  like a fast human. Safest — it looks like normal use and is the recommended
  mode for most courses.
- **API turbo** (tick the **`turbo`** box, or `TTB.config.apiTurbo = true`).
  *Also* polls ForeUp's `/api/booking/times` endpoint **directly** for the
  fastest possible detection of the 7:00 release, reusing your logged-in
  session (no stored credentials, no `api_key` tricks — `fetch(...,
  {credentials:'include'})` rides your cookie). The instant the API shows times
  in your window, it forces the render and grabs the tile.

**Why turbo still places the hold through the UI, not the API:** the booking
*write* can't skip the 2FA either way — the emailed-code field
(`#reservation_confirmation_uid`) is in the modal and needs *you*. So the only
thing "going direct" wins is **detecting the release a few ms sooner**, which
turbo does. Doing the *hold* purely over the API (`pending_reservation`) would
shave a bit more, but it's the exact pattern ForeUp's bot-detection and the NY
crackdown watch for — and it's your personal account at risk. Turbo gets you
the API's detection speed while keeping the booking on the legitimate UI path.
For Bethpage Black (which clears in milliseconds) turbo is worth turning on; on
quieter courses the default is plenty.

> The thing that actually reserves your slot is the **hold** that fires when the
> tile is clicked — it protects the time *while you type the emailed code*. So
> you don't lose Black to the 2FA; you lose it if your hold lands a few ms late.
> Both modes fire that hold the instant a tile renders (via a `MutationObserver`,
> not a poll tick); turbo just learns *when* to render a hair sooner. An e2e test
> simulates a slot that's grabbable for only 500 ms after release and proves the
> hold lands inside it.

## Knobs (`TTB.config.<x> = ...` in the console)

- `apiTurbo` (or the `turbo` checkbox) · `apiPollEveryMs` (50)

- `fireTimeServer` — default `18:59:59.0` (server clock), ~1s before release.
  That's enough margin to absorb clock-sync uncertainty (~±90ms) and be
  already-polling when 7:00 flips, without turbo spraying ~100 empty
  pre-release requests. Firing much earlier just adds bot-like request volume,
  not speed; the search-until-found loop means firing a hair late is safe too.
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

**Scenarios covered (18):** release-after-fire (empty searches first, books
<2.5 s after release) · benign "error" text in the modal does **not** abort a
good booking · **Bethpage Black realism: hold lands inside a 500 ms window** ·
**API turbo detection** · snipe fallback · Book-failure with proper hold release
(no double-hold lockout) · expired-hold recovery · CAPTCHA gate → human handoff ·
**emailed-code field → human handoff (never clicks Book)** · 90 s server-clock
skew · earliest/latest window · dry run · TEST-doesn't-stick regression guard ·
ambiguous-outcome halt (double-booking guard) · STOP can't be resurrected by a
late async tick · panic-mode late arming · spaced time labels ("6:00 AM") ·
250 ms latency.

The mock's page markup mirrors the **live Bethpage page** (verified Jun 2026):
`.js-summary`/`.time-summary` tiles, `#booking-error`, `.players` buttons, the
`#reservation_confirmation_uid` code field, and the `js-book-button` footer — so
these tests exercise the real production selectors.

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
ledger. **18/18 green.**

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
