# 🏌️ Game-Day Runbook (7:00 PM release)

**The one thing to remember:** the bot **wins you the slot**, then **hands off to
you to type the emailed code**. It does *not* finish the booking by itself — when
the purple banner appears, you check your email and type the 6-digit code. Be
ready for that.

---

## ☀️ Anytime before 6:50 — prep (2 min)

1. **Copy the bot to your clipboard** — in Terminal:
   ```
   pbcopy < ~/bots/bethpage-tee-time-bot/bethpage-sniper.user.js
   ```
2. **Keep your Mac awake** — in Terminal:
   ```
   caffeinate -d
   ```

## 🕕 6:50 PM — get on the page

3. **Log in** to the Bethpage booking site and clear any CAPTCHA.
4. Go to **tee times** and choose: your **course**, the **target date** (the one
   that unlocks at 7:00), **18 holes**, and **players**. An **empty list is
   normal** this early.
5. Open the **Console**: press **⌥⌘J** (Option-Command-J).
6. **Paste** the bot (**⌘V**) and hit **Enter**.
   - If Chrome warns about pasting: type **`allow pasting`**, Enter, then paste again.
7. The dark **TTB v2.1** bar appears at the top. In its log, check two lines:
   - `selector check: search control -> 1 match` (or more) ✅ — **if it says 0,
     stop and tell me.**
   - `Server clock offset … rtt N ms` ✅ — that's your connection's round-trip.

## 🕔 6:55 PM — arm it

8. In the TTB bar:
   - **`from` / `to`**: your time window, e.g. `6:00am` / `2:00pm`.
   - **`players`**: how many (default 4).
   - **`fire@server`**: leave it at **`18:59:59.0`** (already correct).
   - **`turbo`**: tick it **only if you're going for Black**.
   - **`dry run`**: **make sure it's UNCHECKED.** ← important
9. Press **ARM**. You'll see `ARMED — firing at 18:59:59.0 … T-4:00` counting down.
10. **Now don't touch anything.** Keep this tab in front. Don't switch tabs or
    apps (background tabs slow the timers down).

## 🕖 7:00 PM — the bot fires, then you finish

11. At 7:00 the bot fires, refreshes, and grabs the first time in your window —
    all in well under a second. You'll see the log light up.
12. **When the big purple banner says `SLOT HELD — ENTER THE 6-DIGIT CODE`:**
    1. **Check your email** for the booking code.
    2. **Type it** into the code box in the booking window.
    3. **Click "Book Time."**
13. **Confirm** — you'll get a confirmation; double-check it under **My
    Reservations** and in your email.

---

## 🆘 If anything goes sideways

- **Press STOP** and book by hand — it's still a normal booking page.
- **Armed too late / it's already past 7:00?** Just press **ARM** anyway — if
  the time just passed, it fires immediately.
- **Page reloaded?** The bot is gone with it — **paste it again** (still on your
  clipboard) and **ARM**.
- **Banner says `OUTCOME UNKNOWN`?** Don't panic and don't re-run — check the
  screen and your email to see if it actually went through. The bot halts here
  on purpose so it can never double-book.

## What the status colors mean

`ARMED` (blue, waiting) → `SEARCHING` (orange, refreshing) → `HANDOFF` (purple,
**your turn — type the code**) → you click Book → done. `STOPPED`/`VERIFY` mean
it paused for you to look.
