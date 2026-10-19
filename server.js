const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  req.token = typeof token === 'string' ? token : null;
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── StreakCircle data ─────────────────────────────────────────────────────
// Days are always plain "YYYY-MM-DD" strings compared at UTC midnight, from
// `req.now` or the `today` the viewer's device sent — never NOW() or
// new Date() (see "Time-dependent features" in the platform conventions).

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// "YYYY-MM-DD" → Date at UTC midnight, or null (also rejects rollovers
// like 2026-02-31, which Date would silently turn into March).
function parseDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) || ymd(d) !== s ? null : d;
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

// The Monday that starts the Mon–Sun week containing d.
function mondayOf(d) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}

function daysBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

// The viewer's habit is_demo filter: the staging demo, `?demo=1` only.
function demoRequested(req) {
  return IS_STAGING && req.query.demo === '1';
}

// Streak for one habit: walk back from today. Today counts if checked and
// never breaks the streak if not. In each Mon–Sun week the first missed day
// is a grace day (it doesn't count but continues the streak); a second miss
// in the same week stops it, as does reaching the habit's created_on.
function streakFor(checked, todayD, createdOnD) {
  let streak = 0;
  let d = new Date(todayD.getTime());
  if (!checked.has(ymd(d))) d = addDays(d, -1);
  const misses = new Map(); // week start "YYYY-MM-DD" → misses seen so far
  while (d.getTime() >= createdOnD.getTime()) {
    if (checked.has(ymd(d))) {
      streak++;
    } else {
      const week = ymd(mondayOf(d));
      const seen = misses.get(week) || 0;
      misses.set(week, seen + 1);
      if (seen >= 1) break; // second miss in this week ends the streak
    }
    d = addDays(d, -1);
  }
  return streak;
}

// The first missed day of the CURRENT week (before today), shown as the
// dashed amber grace dot. Days before the habit existed are not misses.
function graceDayThisWeek(checked, todayD, createdOnD) {
  const start = mondayOf(todayD).getTime() > createdOnD.getTime()
    ? mondayOf(todayD) : new Date(createdOnD.getTime());
  for (let d = new Date(start.getTime()); d.getTime() < todayD.getTime(); d = addDays(d, 1)) {
    if (!checked.has(ymd(d))) return ymd(d);
  }
  return null;
}

// Seven dots, Monday to Sunday, for one habit's week chain.
function weekDots(checked, todayD, grace) {
  const monday = mondayOf(todayD);
  const today = ymd(todayD);
  const dots = [];
  for (let i = 0; i < 7; i++) {
    const s = ymd(addDays(monday, i));
    if (checked.has(s)) dots.push('f');        // solid green
    else if (s === today) dots.push('t');      // ringed: today, not yet checked
    else if (s === grace) dots.push('g');      // dashed amber grace day
    else dots.push('');
  }
  return dots;
}

// ── Schema (idempotent, on boot; all three tables staging:private) ────────
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS habits (
      id bigserial PRIMARY KEY,
      user_id text NOT NULL,
      username text NOT NULL,
      name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 60),
      created_on date NOT NULL,
      created_at timestamptz NOT NULL,
      is_demo boolean NOT NULL DEFAULT false,
      demo_key text,
      UNIQUE (user_id, demo_key)
    );
    CREATE TABLE IF NOT EXISTS checkins (
      habit_id bigint NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
      day date NOT NULL,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (habit_id, day)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id bigserial PRIMARY KEY,
      reporter_id text NOT NULL,
      reported_user_id text NOT NULL,
      habit_names text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL
    );
  `);
  await pool.query(`
    COMMENT ON TABLE habits IS 'staging:private';
    COMMENT ON TABLE checkins IS 'staging:private';
    COMMENT ON TABLE reports IS 'staging:private';
  `);
}

// ── Members: who is in this project ───────────────────────────────────────
// The platform's member list, cached for 60s (it is shared with /users/*'s
// rate limit). Only members get an answer — the platform's check runner gets
// 403 — so every caller falls back to the people who have habits, and the
// page never fails on it.
const PLATFORM_API_BASE = process.env.USERNODE_PLATFORM_API_V1_URL
  || process.env.USERNODE_PLATFORM_API_URL || '';
const membersCache = { at: 0, list: null };

async function getMembers(userToken) {
  if (membersCache.list && Date.now() - membersCache.at < 60_000) {
    return membersCache.list;
  }
  if (!PLATFORM_API_BASE || !userToken) throw new Error('members unavailable');
  const headers = { 'x-usernode-user-token': userToken };
  if (process.env.USERNODE_LLM_PROXY_TOKEN) {
    headers['x-usernode-app-token'] = process.env.USERNODE_LLM_PROXY_TOKEN;
  }
  const resp = await fetch(PLATFORM_API_BASE + '/members', { headers });
  if (!resp.ok) throw new Error('members ' + resp.status);
  const data = await resp.json();
  const list = Array.isArray(data.members)
    ? data.members.filter((m) => m && m.id != null && m.username).map((m) => ({ id: String(m.id), username: m.username }))
    : [];
  membersCache.at = Date.now();
  membersCache.list = list;
  return list;
}

// Fallback when the roster is not available: the people who have habits.
async function peopleWithHabits() {
  const { rows } = await pool.query(
    `SELECT user_id, username, min(created_at) AS first FROM habits
     WHERE is_demo = false GROUP BY user_id, username ORDER BY min(created_at)`);
  return rows.map((r) => ({ id: r.user_id, username: r.username }));
}

// ── Staging demo ──────────────────────────────────────────────────────────
// Only on staging, `?demo=1` only: the viewer's own four habits with a few
// weeks of history (stored once, idempotently, marked is_demo) plus four
// made-up members whose check-ins are computed from today and never stored.
// Without demo=1 every query excludes is_demo rows, so the plain route stays
// empty for a new account.
const DEMO_SEED = [
  // offsets = days back from the seed day that were checked in
  { key: 'morning-walk', name: 'Morning walk', createdDaysAgo: 30, offsets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { key: 'read-20-pages', name: 'Read 20 pages', createdDaysAgo: 20, offsets: [0, 1, 2, 3] },
  // one grace day: every day from 10 back to 1 except 2, today unchecked —
  // a 9-day streak that a single miss (the grace day) carries
  { key: 'stretch', name: 'Stretch for 10 minutes', createdDaysAgo: 30, offsets: [1, 3, 4, 5, 6, 7, 8, 9, 10] },
  { key: 'no-phone', name: 'No phone after 10pm', createdDaysAgo: 40, offsets: Array.from({ length: 26 }, (_, i) => i) },
];

async function seedDemoHabits(user, now) {
  const todayD = parseDay(ymd(now));
  for (const h of DEMO_SEED) {
    const createdOn = ymd(addDays(todayD, -h.createdDaysAgo));
    const ins = await pool.query(
      `INSERT INTO habits (user_id, username, name, created_on, created_at, is_demo, demo_key)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       ON CONFLICT (user_id, demo_key) DO NOTHING RETURNING id`,
      [user.id, user.username, h.name, createdOn, now, h.key]);
    if (!ins.rows.length) continue;
    const days = h.offsets.map((o) => ymd(addDays(todayD, -o)));
    await pool.query(
      `INSERT INTO checkins (habit_id, day, created_at)
       SELECT $1, d::date, $2 FROM unnest($3::date[]) AS d
       ON CONFLICT DO NOTHING`,
      [ins.rows[0].id, now, days]);
  }
}

// Four made-up members: days checked in this week (capped at the days elapsed
// so far), check-ins per checked day, and each habit's running streak.
const FAKE_MEMBERS = [
  { key: 'priya', username: 'Priya', habits: ['Meditate', 'Journal', 'Run'], days: 4, perDay: [3, 3, 3, 3], streaks: [41, 15, 8] },
  { key: 'marcus', username: 'Marcus', habits: ['Guitar practice', 'Water'], days: 3, perDay: [2, 2, 2], streaks: [18, 6] },
  { key: 'joan', username: 'Joan', habits: ['Garden', 'Read', 'Stretch'], days: 3, perDay: [2, 2, 1], streaks: [9, 5, 3] },
  { key: 'tomas', username: 'Tomás', habits: ['Spanish lesson'], days: 1, perDay: [1], streaks: [3] },
];

function fakeMemberStats(m, todayD) {
  const elapsed = daysBetween(todayD, mondayOf(todayD)) + 1;
  const days = Math.min(m.days, elapsed);
  return {
    userId: 'demo:' + m.key,
    username: m.username,
    habitNames: m.habits.join(', '),
    days,
    checkins: m.perDay.slice(0, days).reduce((a, b) => a + b, 0),
    streak: Math.max(...m.streaks),
  };
}

// ── GET /api/home ─────────────────────────────────────────────────────────
app.get('/api/home', async (req, res) => {
  const demo = demoRequested(req);
  const todayD = parseDay(req.query.today);
  const serverDay = parseDay(ymd(req.now));
  if (!todayD || !serverDay || Math.abs(daysBetween(todayD, serverDay)) > 1) {
    return res.status(400).json({ error: 'bad_today' });
  }
  const today = ymd(todayD);
  const weekStart = ymd(mondayOf(todayD));
  const userId = req.user ? req.user.id : null;

  try {
    // The staging demo seeds the viewer's own four habits once, on the
    // first demo request.
    if (demo && req.user) await seedDemoHabits(req.user, req.now);
    // The viewer's habits (demo rows on the demo, real rows otherwise).
    const habits = userId
      ? (await pool.query(
          `SELECT id, name, created_on::text AS created_on FROM habits
           WHERE user_id = $1 AND is_demo = $2 ORDER BY created_at, id`,
          [userId, demo])).rows
      : [];
    const checkedByHabit = new Map();
    if (habits.length) {
      const { rows } = await pool.query(
        `SELECT habit_id, day::text AS day FROM checkins WHERE habit_id = ANY($1)`,
        [habits.map((h) => h.id)]);
      for (const r of rows) {
        let set = checkedByHabit.get(r.habit_id);
        if (!set) { set = new Set(); checkedByHabit.set(r.habit_id, set); }
        set.add(r.day);
      }
    }
    const habitList = habits.map((h) => {
      const checked = checkedByHabit.get(h.id) || new Set();
      const createdOnD = parseDay(h.created_on);
      const grace = graceDayThisWeek(checked, todayD, createdOnD);
      return {
        id: h.id,
        name: h.name,
        checkedToday: checked.has(today),
        streak: streakFor(checked, todayD, createdOnD),
        graceDay: grace,
        week: weekDots(checked, todayD, grace),
      };
    });

    // Distinct days with at least one check-in this week, per person, plus
    // the check-in count — the leaderboard's numbers.
    let people;
    let weekStats = new Map(); // userId → { days: Set, count }
    if (demo) {
      if (userId) {
        const { rows } = await pool.query(
          `SELECT c.day::text AS day, count(*)::int AS n
           FROM checkins c JOIN habits h ON h.id = c.habit_id
           WHERE h.user_id = $1 AND h.is_demo = true AND c.day >= $2 AND c.day <= $3
           GROUP BY c.day`,
          [userId, weekStart, today]);
        const days = new Set();
        let count = 0;
        for (const r of rows) { days.add(r.day); count += r.n; }
        weekStats.set(userId, { days, count });
      }
      people = FAKE_MEMBERS.map((m) => fakeMemberStats(m, todayD));
      if (userId) {
        people = people.concat([{
          userId,
          username: req.user.username,
          habitNames: habitList.map((h) => h.name).join(', '),
          days: 0,
          checkins: 0,
          streak: 0,
        }]);
      }
    } else {
      try {
        people = await getMembers(req.token);
      } catch {
        people = null;
      }
      if (!people) people = await peopleWithHabits();
      people = people.map((p) => ({ userId: p.id, username: p.username }));
      const ids = people.map((p) => p.userId);
      if (ids.length) {
        const { rows } = await pool.query(
          `SELECT h.user_id AS user_id, c.day::text AS day, count(*)::int AS n
           FROM checkins c JOIN habits h ON h.id = c.habit_id
           WHERE h.is_demo = false AND c.day >= $1 AND c.day <= $2 AND h.user_id = ANY($3)
           GROUP BY h.user_id, c.day`,
          [weekStart, today, ids]);
        for (const r of rows) {
          let s = weekStats.get(r.user_id);
          if (!s) { s = { days: new Set(), count: 0 }; weekStats.set(r.user_id, s); }
          s.days.add(r.day);
          s.count += r.n;
        }
      }
    }

    const leaderboard = people.map((p) => {
      const s = weekStats.get(p.userId);
      return {
        userId: p.userId,
        username: p.username,
        you: !!userId && p.userId === userId,
        days: s ? s.days.size : (p.days || 0),
        checkins: s ? s.count : (p.checkins || 0),
      };
    })
      .sort((a, b) => b.days - a.days); // stable: ties keep member order
    let lastDays = null;
    let lastRank = 0;
    leaderboard.forEach((e, i) => {
      if (e.days !== lastDays) { lastRank = i + 1; lastDays = e.days; }
      e.rank = lastRank; // ties share a rank
    });

    // Everyone's streaks: each other member's habits by name, with their
    // longest running habit streak, longest first.
    let streaks;
    if (demo) {
      streaks = FAKE_MEMBERS.map((m) => {
        const s = fakeMemberStats(m, todayD);
        return { userId: s.userId, username: s.username, habitNames: s.habitNames, streak: s.streak };
      });
    } else {
      const { rows } = await pool.query(
        `SELECT h.user_id, h.username, h.id, h.name, h.created_on::text AS created_on, c.day::text AS day
         FROM habits h LEFT JOIN checkins c ON c.habit_id = h.id
         WHERE h.is_demo = false ORDER BY h.user_id, h.created_at, h.id`);
      const byUser = new Map();
      for (const r of rows) {
        let u = byUser.get(r.user_id);
        if (!u) { u = { username: r.username, habits: new Map() }; byUser.set(r.user_id, u); }
        let hb = u.habits.get(r.id);
        if (!hb) { hb = { name: r.name, createdOnD: parseDay(r.created_on), checked: new Set() }; u.habits.set(r.id, hb); }
        if (r.day) hb.checked.add(r.day);
      }
      streaks = [];
      for (const [uid, u] of byUser) {
        if (uid === userId) continue; // other members only
        let longest = 0;
        for (const hb of u.habits.values()) {
          const s = streakFor(hb.checked, todayD, hb.createdOnD);
          if (s > longest) longest = s;
        }
        streaks.push({
          userId: uid,
          username: u.username,
          habitNames: [...u.habits.values()].map((hb) => hb.name).join(', '),
          streak: longest,
        });
      }
      streaks.sort((a, b) => b.streak - a.streak);
    }

    res.json({
      today,
      weekday: WEEKDAYS[todayD.getUTCDay()],
      demo,
      account: !!req.user,
      username: req.user ? req.user.username : null,
      habits: habitList,
      leaderboard,
      streaks,
    });
  } catch (err) {
    console.error('GET /api/home failed: ' + (err && err.stack || err));
    res.status(500).json({ error: 'home_failed' });
  }
});

// ── Habits ────────────────────────────────────────────────────────────────
app.post('/api/habits', async (req, res) => {
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (name.length < 1 || name.length > 60) return res.status(400).json({ error: 'bad_name' });
  const demo = demoRequested(req);
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM habits WHERE user_id = $1 AND is_demo = $2`,
      [req.user.id, demo]);
    if (rows[0].n >= 5) return res.status(409).json({ error: 'limit' });
    const demoKey = demo ? 'added-' + req.now.getTime() : null;
    const ins = await pool.query(
      `INSERT INTO habits (user_id, username, name, created_on, created_at, is_demo, demo_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name`,
      [req.user.id, req.user.username, name, ymd(req.now), req.now, demo, demoKey]);
    res.status(201).json({ habit: { id: ins.rows[0].id, name: ins.rows[0].name } });
  } catch (err) {
    console.error('POST /api/habits failed: ' + (err && err.stack || err));
    res.status(500).json({ error: 'habit_failed' });
  }
});

async function ownedHabit(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return null;
  }
  const { rows } = await pool.query(`SELECT user_id FROM habits WHERE id = $1`, [id]);
  if (!rows.length) { res.status(404).json({ error: 'not_found' }); return null; }
  // user_id is stored as text; the token's id may arrive as a number.
  if (String(rows[0].user_id) !== String(req.user.id)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return id;
}

app.delete('/api/habits/:id', async (req, res) => {
  try {
    const id = await ownedHabit(req, res);
    if (id == null) return;
    await pool.query(`DELETE FROM habits WHERE id = $1`, [id]); // check-ins cascade
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/habits failed: ' + (err && err.stack || err));
    res.status(500).json({ error: 'habit_failed' });
  }
});

// The day must be a real date within one day of req.now: today only, with a
// margin for a device clock a zone or so away from the server's.
function checkinDay(req, res) {
  const day = parseDay(req.params.day);
  const serverDay = parseDay(ymd(req.now));
  if (!day || !serverDay || Math.abs(daysBetween(day, serverDay)) > 1) {
    res.status(400).json({ error: 'bad_day' });
    return null;
  }
  return ymd(day);
}

app.put('/api/habits/:id/checkins/:day', async (req, res) => {
  try {
    const id = await ownedHabit(req, res);
    if (id == null) return;
    const day = checkinDay(req, res);
    if (!day) return;
    await pool.query(
      `INSERT INTO checkins (habit_id, day, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (habit_id, day) DO NOTHING`,
      [id, day, req.now]);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT checkin failed: ' + (err && err.stack || err));
    res.status(500).json({ error: 'checkin_failed' });
  }
});

app.delete('/api/habits/:id/checkins/:day', async (req, res) => {
  try {
    const id = await ownedHabit(req, res);
    if (id == null) return;
    const day = checkinDay(req, res);
    if (!day) return;
    await pool.query(`DELETE FROM checkins WHERE habit_id = $1 AND day = $2`, [id, day]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE checkin failed: ' + (err && err.stack || err));
    res.status(500).json({ error: 'checkin_failed' });
  }
});

// ── Reports ───────────────────────────────────────────────────────────────
// "Report" tells the app's keepers about a habit name: it records the report
// and nothing more — it hides nothing.
app.post('/api/reports', async (req, res) => {
  const reported = req.body && typeof req.body.userId === 'string' ? req.body.userId : '';
  if (!reported) return res.status(400).json({ error: 'bad_user' });
  try {
    const { rows } = await pool.query(
      `SELECT name FROM habits WHERE user_id = $1 AND is_demo = false ORDER BY created_at, id`,
      [reported]);
    await pool.query(
      `INSERT INTO reports (reporter_id, reported_user_id, habit_names, created_at)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, reported, rows.map((r) => r.name).join(', '), req.now]);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('POST /api/reports failed: ' + (err && err.stack || err));
    res.status(500).json({ error: 'report_failed' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/streakcircle-1f3eda/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/streakcircle-1f3eda/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await ensureSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // Stop listening, drain for about 3s, close the pool, exit.
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log('Shutting down');
    const done = () => {
      pool.end().catch(() => {}).finally(() => process.exit(0));
    };
    server.close(done);
    setTimeout(done, 3000);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });