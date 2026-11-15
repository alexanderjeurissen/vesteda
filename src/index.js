import { DurableObject } from "cloudflare:workers";
import { BASE, diff, parseListings } from "./vesteda.js";

const SEARCH_URL = BASE + "/zoekopdracht/";
const UA = "Mozilla/5.0 (X11; Linux x86_64) vesteda-watch";
const INTERVAL_MS = 2 * 60 * 1000;

// One saved search = one coordination unit, so a single named instance.
export class Watcher extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY, address TEXT, city TEXT, status TEXT, price TEXT,
        bedrooms TEXT, area TEXT, active INTEGER NOT NULL DEFAULT 1,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, listing_id TEXT NOT NULL, ts INTEGER NOT NULL,
        kind TEXT NOT NULL, from_status TEXT, to_status TEXT);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
  }

  getMeta(key) {
    const row = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }

  setMeta(key, value) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, JSON.stringify(value));
  }

  // fetch with a cookie jar kept in storage; follows redirects by hand so Set-Cookie on 302s is kept.
  async request(url, form) {
    const jar = this.getMeta("cookies") ?? {};
    let method = form ? "POST" : "GET";
    let body = form ? new URLSearchParams(form) : undefined;
    for (let hop = 0; hop < 6; hop++) {
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(url, { method, body, redirect: "manual", headers: { "user-agent": UA, cookie } });
      for (const c of res.headers.getSetCookie()) {
        const nv = c.split(";")[0];
        const eq = nv.indexOf("=");
        jar[nv.slice(0, eq).trim()] = nv.slice(eq + 1);
      }
      this.setMeta("cookies", jar);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url).href;
        method = "GET";
        body = undefined;
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} from ${url} (server: ${res.headers.get("server")}): ${(await res.text()).slice(0, 300)}`);
      return { url, text: await res.text() };
    }
    throw new Error("Too many redirects");
  }

  async login() {
    // The first request only gets PHPSESSID; the Laravel session + CSRF token are only
    // stable from the second request on, so warm up first or the POST fails with "Sessie is verlopen".
    await this.request(BASE + "/login");
    const { text } = await this.request(BASE + "/login");
    const token = text.match(/name="_token" value="([^"]+)"/)?.[1];
    if (!token) throw new Error("No CSRF token on login page");
    await this.request(BASE + "/login", {
      postrequest: "login",
      _token: token,
      txtEmail: this.env.VESTEDA_EMAIL,
      txtWachtwoord: this.env.VESTEDA_PASSWORD,
    });
  }

  async searchPage() {
    let page = await this.request(SEARCH_URL);
    if (page.url.includes("/login")) {
      await this.login();
      page = await this.request(SEARCH_URL);
      if (page.url.includes("/login")) throw new Error("Login failed: still redirected to /login");
    }
    return page.text;
  }

  async check() {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    this.setMeta("last_check", now);
    try {
      const current = parseListings(await this.searchPage());
      // An empty page would mark everything "verdwenen" now and "nieuw" next time, so bail out instead.
      if (!Object.keys(current).length) throw new Error("No listings parsed; page layout changed or not logged in?");

      const known = Object.fromEntries(sql.exec("SELECT id, status, active FROM listings").toArray().map((r) => [r.id, r]));
      const firstRun = !Object.keys(known).length;
      const events = diff(known, current).map((e) => (firstRun ? { ...e, kind: "start" } : e));

      this.ctx.storage.transactionSync(() => {
        for (const [id, l] of Object.entries(current))
          sql.exec(
            `INSERT INTO listings (id, address, city, status, price, bedrooms, area, active, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET address = excluded.address, city = excluded.city, status = excluded.status,
               price = excluded.price, bedrooms = excluded.bedrooms, area = excluded.area, active = 1, last_seen = excluded.last_seen`,
            id, l.address, l.city, l.status, l.price, l.bedrooms, l.area, now, now);
        for (const e of events) {
          sql.exec("INSERT INTO events (listing_id, ts, kind, from_status, to_status) VALUES (?, ?, ?, ?, ?)",
            e.id, now, e.kind, e.from, e.to);
          if (e.kind === "verdwenen") sql.exec("UPDATE listings SET active = 0 WHERE id = ?", e.id);
        }
        this.setMeta("last_ok", now);
        this.setMeta("last_error", null);
      });

      console.log(JSON.stringify({ msg: "check ok", listings: Object.keys(current).length, events: events.length, firstRun }));
      if (!firstRun && events.length) {
        // State is already saved, so a failed push is logged, not retried.
        const results = await Promise.allSettled(events.map((e) =>
          this.notify(e, sql.exec("SELECT * FROM listings WHERE id = ?", e.id).one())));
        for (const r of results) if (r.status === "rejected") console.error(JSON.stringify({ msg: "notify failed", error: String(r.reason) }));
      }
    } catch (err) {
      this.setMeta("last_error", { ts: now, message: String(err?.message ?? err) });
      throw err;
    }
  }

  async notify(e, l) {
    const title = eventText(e);
    const message = `${l.address}, ${l.city}\n€ ${l.price} · ${l.bedrooms} slpk · ${l.area} m²`;
    console.log(JSON.stringify({ msg: "alert", title, listing: e.id }));
    if (!this.env.NTFY_TOPIC) return;
    const res = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: this.env.NTFY_TOPIC, title: `Vesteda – ${title}`, message,
        click: objectUrl(e.id), priority: e.to === "Te huur" ? 5 : 3, tags: ["house"],
      }),
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
  }

  async alarm() {
    if (this.env.PAUSED) return console.log(JSON.stringify({ msg: "paused", reason: this.env.PAUSED }));
    // Reschedule first and never throw: a throwing alarm is retried a few times and then dropped, which would end the loop.
    await this.ctx.storage.setAlarm(Date.now() + INTERVAL_MS);
    try {
      await this.check();
    } catch (err) {
      console.error(JSON.stringify({ msg: "check failed", error: String(err?.message ?? err) }));
    }
  }

  // Starts the alarm loop if it isn't running; called by the watchdog cron and every dashboard view.
  async ensureAlarm() {
    const next = await this.ctx.storage.getAlarm();
    if (next != null) return next;
    await this.ctx.storage.setAlarm(Date.now());
    console.log(JSON.stringify({ msg: "alarm loop started" }));
    return Date.now();
  }

  async snapshot() {
    const nextCheck = await this.ensureAlarm();
    const sql = this.ctx.storage.sql;
    return {
      nextCheck,
      listings: sql.exec("SELECT * FROM listings").toArray(),
      events: sql.exec("SELECT * FROM events ORDER BY ts DESC, seq DESC").toArray(),
      lastCheck: this.getMeta("last_check"),
      lastOk: this.getMeta("last_ok"),
      lastError: this.getMeta("last_error"),
    };
  }
}

const objectUrl = (id) => `${BASE}/object/${id}/`;

function eventText(e) {
  const from = e.from ?? e.from_status, to = e.to ?? e.to_status;
  return {
    start: `Eerste check: ${to}`,
    nieuw: `Nieuw: ${to}`,
    terug: `Weer zichtbaar: ${to}`,
    status: `${from} → ${to}`,
    verdwenen: "Verdwenen uit zoekresultaten",
  }[e.kind];
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", dateStyle: "short", timeStyle: "short" });
const time = (ts) => (ts ? fmt.format(new Date(ts)) : "–");
const statusClass = (s) => ({ "Te huur": "ok", Gereserveerd: "warn" }[s] ?? "muted");

function render({ listings, events, lastCheck, lastOk, lastError, nextCheck }) {
  const byListing = Object.groupBy(events, (e) => e.listing_id);
  const byId = Object.fromEntries(listings.map((l) => [l.id, l]));
  const groups = [
    ["Te huur", listings.filter((l) => l.active && l.status === "Te huur")],
    ["Gereserveerd", listings.filter((l) => l.active && l.status === "Gereserveerd")],
    ["Verhuurd onder voorbehoud", listings.filter((l) => l.active && l.status === "Verhuurd onder voorbehoud")],
    ["Overig", listings.filter((l) => l.active && !["Te huur", "Gereserveerd", "Verhuurd onder voorbehoud"].includes(l.status))],
    ["Niet meer in zoekresultaten", listings.filter((l) => !l.active)],
  ].filter(([, ls]) => ls.length);

  const card = (l) => `
    <article class="card${l.active ? "" : " gone"}">
      <header>
        <a href="${esc(objectUrl(l.id))}" target="_blank" rel="noopener">${esc(l.address)}</a>
        <span class="badge ${l.active ? statusClass(l.status) : "muted"}">${esc(l.status)}</span>
      </header>
      <p class="meta">${esc(l.city)} · € ${esc(l.price)} · ${esc(l.bedrooms)} slpk · ${esc(l.area)} m²</p>
      <details>
        <summary>Geschiedenis (${(byListing[l.id] ?? []).length})</summary>
        <ol>${(byListing[l.id] ?? []).map((e) => `<li><time>${time(e.ts)}</time> ${esc(eventText(e))}</li>`).join("")}</ol>
      </details>
    </article>`;

  const health = lastError
    ? `<p class="banner err">Laatste check mislukt (${time(lastError.ts)}): ${esc(lastError.message)}. Laatste geslaagde check: ${time(lastOk)}</p>`
    : `<p class="banner">Laatste check: ${time(lastCheck)} · volgende: ${time(nextCheck)} · ${listings.filter((l) => l.active).length} woningen in zoekopdracht</p>`;

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="120">
<title>Vesteda Watch</title>
<style>
  :root { --bg:#f6f5f2; --surface:#fff; --text:#1d1d1b; --muted:#6b6a66; --border:#e3e1dc;
          --ok:#1f7a4d; --ok-bg:#e3f3ea; --warn:#8a5a00; --warn-bg:#fbefd5; --err:#a8261d; --err-bg:#fbe5e3; --link:#0b5cad; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151514; --surface:#1f1f1d; --text:#ecebe8; --muted:#a09e98; --border:#33322f;
          --ok:#6fd3a0; --ok-bg:#183326; --warn:#f0c46a; --warn-bg:#3a2e14; --err:#ff8f86; --err-bg:#3d1916; --link:#7db8f5; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 32px 0 12px; }
  h2 small { color: var(--muted); font-weight: 400; }
  a { color: var(--link); }
  .banner { margin: 8px 0 0; color: var(--muted); }
  .banner.err { color: var(--err); background: var(--err-bg); padding: 10px 12px; border-radius: 8px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .card.gone { opacity: .65; }
  .card header { display: flex; justify-content: space-between; gap: 8px; align-items: start; font-weight: 600; }
  .card header a { text-decoration: none; }
  .card header a:hover { text-decoration: underline; }
  .meta { margin: 4px 0 8px; color: var(--muted); }
  .badge { flex: none; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 99px; white-space: nowrap; }
  .badge.ok { color: var(--ok); background: var(--ok-bg); }
  .badge.warn { color: var(--warn); background: var(--warn-bg); }
  .badge.muted { color: var(--muted); background: var(--bg); }
  details summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  ol { margin: 6px 0 0; padding-left: 18px; font-size: 13px; }
  time { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 4px; }
  .feed { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px 14px; margin: 0; list-style: none; }
  .feed li { padding: 6px 0; border-bottom: 1px solid var(--border); }
  .feed li:last-child { border: 0; }
</style>
</head>
<body><main>
  <h1>Vesteda Watch</h1>
  ${health}
  <h2>Recente wijzigingen</h2>
  <ul class="feed">${events.filter((e) => e.kind !== "start").slice(0, 15).map((e) => `<li><time>${time(e.ts)}</time>
    <a href="${esc(objectUrl(e.listing_id))}" target="_blank" rel="noopener">${esc(byId[e.listing_id]?.address)}</a> · ${esc(eventText(e))}</li>`).join("") || "<li>Nog geen wijzigingen.</li>"}</ul>
  ${groups.map(([name, ls]) => `<h2>${esc(name)} <small>${ls.length}</small></h2>
  <div class="grid">${ls.sort((a, b) => b.first_seen - a.first_seen).map(card).join("")}</div>`).join("")}
</main></body></html>`;
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/") return new Response("Not found", { status: 404 });
    const data = await env.WATCHER.getByName("default").snapshot();
    return new Response(render(data), { headers: { "content-type": "text/html; charset=utf-8" } });
  },

  // Watchdog only: the checks themselves run on the Durable Object alarm.
  async scheduled(controller, env) {
    await env.WATCHER.getByName("default").ensureAlarm();
  },
};
