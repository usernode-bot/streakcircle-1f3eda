# StreakCircle

Track daily habits and cheer each other on as a group. Members add up to
five habits, tap a big circle to check in each day, and watch their
streaks grow. Below their own habits, a weekly leaderboard and everyone's
streaks show how the group is doing.

- **Check in** — tap a habit's circle for today; tap again to undo a
  mistaken tap. Each habit shows its week as a chain of seven dots,
  Monday to Sunday, that fills in as you check in.
- **Streaks** — consecutive days checked in, one grace day per week
  forgiven, so a steady week beats a perfect one.
- **Weekly leaderboard** — everyone in the group ranked by days checked
  in this week, Monday to Sunday; ties share a rank.
- **Everyone's streaks** — other members' habits and their longest
  running streak, with a way to report a habit name to the app's keepers.

## Running it

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
- **Database** — the app's own private Postgres: `habits`, `checkins`
  and `reports`, all marked `staging:private`.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during
  image creation, in a light and a dark look that follow the viewer's
  Homeroom theme. The design notes live in `CLAUDE.md` under "## Design".
- **Staging demo** — on a staging preview, `?demo=1` shows a populated
  screen: four demo habits with history and four made-up members. The
  plain route stays real.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can also
run Claude Code against this repo directly; start with `CLAUDE.md`.