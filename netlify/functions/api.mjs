/**
 * TJC Fam: sign-in and Google Calendar access for the calendar page.
 *
 * One Netlify Function, no dependencies. It lets one browser stay signed in to several
 * Google accounts at once (e.g. jiwon@thisjanuary.com and jiwonbaeq@gmail.com) and reads and
 * writes their calendars on the page's behalf.
 *
 * The Google refresh tokens never reach the page: they live in a single HttpOnly cookie,
 * encrypted with AES-256-GCM using SESSION_SECRET. The page only ever sees email addresses,
 * calendars and events.
 *
 * Environment variables (set in Netlify → Site configuration → Environment variables):
 *   GOOGLE_CLIENT_ID      OAuth client ID ("Web application") from Google Cloud
 *   GOOGLE_CLIENT_SECRET  its secret
 *   SESSION_SECRET        any long random string (32+ characters); changing it signs everyone out
 *   PUBLIC_URL            where the page lives, no trailing slash: https://www.jiwonbaeq.com/fam
 *   ALLOWED_EMAILS        optional, comma-separated; only these Google accounts may sign in
 */
import crypto from "node:crypto";

export const config = { path: ["/api/*", "/fam/api/*"] };

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const CAL = "https://www.googleapis.com/calendar/v3";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar"];
const SESSION_COOKIE = "fam_s";
const STATE_COOKIE = "fam_st";
const YEAR = 60 * 60 * 24 * 365;

const env = k => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? "").trim();
const publicUrl = () => env("PUBLIC_URL").replace(/\/+$/, "");
const cookiePath = () => { try { return new URL(publicUrl()).pathname.replace(/\/+$/, "") || "/"; } catch { return "/"; } };
const redirectUri = () => publicUrl() + "/api/auth/callback";

/* ---------- small helpers ---------- */
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const fail = (status, error, message, extra = {}) => json({ error, message, ...extra }, status);
const redirect = (location, cookies = []) => {
  const h = new Headers({ location, "cache-control": "no-store" });
  cookies.forEach(c => h.append("set-cookie", c));
  return new Response(null, { status: 302, headers: h });
};
function readCookies(req) {
  const out = {};
  (req.headers.get("cookie") || "").split(/;\s*/).forEach(p => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1)); });
  return out;
}
const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=${cookiePath()}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/* ---------- encrypted session: [{e: email, r: refresh token}] ---------- */
const key = () => crypto.createHash("sha256").update(env("SESSION_SECRET")).digest();
function seal(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}
function unseal(s) {
  try {
    const b = Buffer.from(s, "base64url"), d = crypto.createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
  } catch { return null; }
}
const readSession = req => { const v = readCookies(req)[SESSION_COOKIE]; const s = v && unseal(v); return Array.isArray(s?.a) ? s.a : []; };
const sessionCookie = accounts => accounts.length ? setCookie(SESSION_COOKIE, seal({ a: accounts }), YEAR) : setCookie(SESSION_COOKIE, "", 0);

/* ---------- Google access tokens (cached per warm function instance) ---------- */
const tokenCache = new Map();
class Reauth extends Error { constructor(email) { super(`Sign in to ${email} again.`); this.email = email; } }
async function accessToken(acct) {
  const hit = tokenCache.get(acct.e);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const r = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), refresh_token: acct.r, grant_type: "refresh_token" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { tokenCache.delete(acct.e); throw new Reauth(acct.e); }
  tokenCache.set(acct.e, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}
async function google(acct, method, path, { query, body } = {}) {
  const url = new URL(CAL + path);
  Object.entries(query || {}).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && url.searchParams.set(k, String(v)));
  const go = async token => fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let r = await go(await accessToken(acct));
  if (r.status === 401) { tokenCache.delete(acct.e); r = await go(await accessToken(acct)); }
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j?.error?.message || `Google Calendar returned ${r.status}`); e.status = r.status; throw e; }
  return j;
}

/* ---------- routes ---------- */
export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*?\/api\//, "");
  const method = req.method.toUpperCase();

  if (!env("GOOGLE_CLIENT_ID") || !env("GOOGLE_CLIENT_SECRET") || env("SESSION_SECRET").length < 16 || !publicUrl())
    return fail(500, "setup", "The site isn't set up yet: add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET and PUBLIC_URL in Netlify.");

  /* writes must come from the page itself */
  if (method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin && origin !== new URL(publicUrl()).origin) return fail(403, "origin", "Requests must come from the calendar page.");
  }

  try {
    /* ---- sign-in ---- */
    if (route === "auth/start" && method === "GET") {
      const state = crypto.randomBytes(16).toString("base64url");
      const q = new URLSearchParams({
        client_id: env("GOOGLE_CLIENT_ID"), redirect_uri: redirectUri(), response_type: "code",
        scope: SCOPES.join(" "), access_type: "offline", include_granted_scopes: "true",
        prompt: "consent select_account", state,
      });
      if (url.searchParams.get("hint")) q.set("login_hint", url.searchParams.get("hint"));
      return redirect(`${GOOGLE_AUTH}?${q}`, [setCookie(STATE_COOKIE, state, 600)]);
    }

    if (route === "auth/callback" && method === "GET") {
      const back = (msg) => redirect(`${publicUrl()}/?${msg}`, [setCookie(STATE_COOKIE, "", 0)]);
      if (url.searchParams.get("error")) return back("signin=cancelled");
      const state = url.searchParams.get("state"), code = url.searchParams.get("code");
      if (!state || state !== readCookies(req)[STATE_COOKIE] || !code) return back("signin=expired");
      const r = await fetch(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), redirect_uri: redirectUri(), grant_type: "authorization_code" }),
      });
      const t = await r.json().catch(() => ({}));
      if (!r.ok || !t.id_token) return back("signin=failed");
      /* the id_token comes straight from Google over TLS, so reading its payload is enough here */
      const claims = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString("utf8"));
      const email = String(claims.email || "").toLowerCase();
      const allowed = env("ALLOWED_EMAILS").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
      if (!email || (allowed.length && !allowed.includes(email))) return back("signin=notallowed");
      if (!String(t.scope || "").includes("auth/calendar")) return back("signin=noscope");
      const accounts = readSession(req).filter(a => a.e !== email);
      const prev = readSession(req).find(a => a.e === email);
      const rt = t.refresh_token || prev?.r;
      if (!rt) return back("signin=norefresh");
      accounts.push({ e: email, r: rt });
      tokenCache.set(email, { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 });
      return redirect(`${publicUrl()}/?signedin=${encodeURIComponent(email)}`, [sessionCookie(accounts), setCookie(STATE_COOKIE, "", 0)]);
    }

    if (route === "auth/signout" && method === "POST") {
      const { email } = await req.json().catch(() => ({}));
      const all = readSession(req), gone = all.find(a => a.e === email);
      if (gone) fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(gone.r)}`, { method: "POST" }).catch(() => {});
      tokenCache.delete(email);
      const rest = all.filter(a => a.e !== email);
      return json({ accounts: rest.map(a => ({ email: a.e })) }, 200, { "set-cookie": sessionCookie(rest) });
    }

    if (route === "accounts" && method === "GET")
      return json({ accounts: readSession(req).map(a => ({ email: a.e })) });

    /* everything below needs a signed-in account */
    const accounts = readSession(req);
    const pick = email => accounts.find(a => a.e === String(email || "").toLowerCase());

    /* ---- calendars from every signed-in account ---- */
    if (route === "calendars" && method === "GET") {
      const out = [], errors = [];
      await Promise.all(accounts.map(async acct => {
        try {
          let pageToken;
          do {
            const j = await google(acct, "GET", "/users/me/calendarList", { query: { maxResults: 250, minAccessRole: "reader", pageToken } });
            (j.items || []).forEach(c => out.push({ acct: acct.e, id: c.id, name: c.summaryOverride || c.summary || c.id, accessRole: c.accessRole, primary: !!c.primary }));
            pageToken = j.nextPageToken;
          } while (pageToken);
        } catch (e) { errors.push({ acct: acct.e, error: e instanceof Reauth ? "reauth" : "failed", message: e.message }); }
      }));
      return json({ calendars: out, errors });
    }

    /* ---- events ---- */
    if (route === "events") {
      const p = method === "GET" || method === "DELETE" ? Object.fromEntries(url.searchParams) : await req.json().catch(() => ({}));
      const acct = pick(p.acct);
      if (!acct) return fail(401, "reauth", `Sign in to ${p.acct || "that Google account"} in Settings.`, { acct: p.acct });
      const cal = encodeURIComponent(p.cal || "primary");

      if (method === "GET") {
        const events = []; let pageToken, accessRole;
        for (let i = 0; i < 10; i++) {
          const j = await google(acct, "GET", `/calendars/${cal}/events`, { query: { timeMin: p.min, timeMax: p.max, singleEvents: true, orderBy: "startTime", maxResults: 250, pageToken } });
          accessRole = j.accessRole || accessRole;
          events.push(...(j.items || []));
          if (!(pageToken = j.nextPageToken)) break;
        }
        return json({ accessRole, events });
      }
      if (method === "POST") {
        const ev = await google(acct, "POST", `/calendars/${cal}/events`, { query: { sendUpdates: p.event?.attendees?.length ? "all" : "none" }, body: p.event });
        return json({ event: ev });
      }
      if (method === "PATCH") {
        const id = encodeURIComponent(p.id), patch = { ...(p.patch || {}) };
        const add = (p.addAttendees || []).map(s => String(s).toLowerCase());
        if (add.length) {
          const cur = await google(acct, "GET", `/calendars/${cal}/events/${id}`);
          const list = cur.attendees || [];
          add.forEach(email => { if (!list.some(a => String(a.email).toLowerCase() === email)) list.push({ email }); });
          patch.attendees = list;
        }
        const ev = await google(acct, "PATCH", `/calendars/${cal}/events/${id}`, { query: { sendUpdates: add.length ? "all" : "none" }, body: patch });
        return json({ event: ev });
      }
      if (method === "DELETE") {
        await google(acct, "DELETE", `/calendars/${cal}/events/${encodeURIComponent(p.id)}`, { query: { sendUpdates: "none" } });
        return json({ ok: true });
      }
    }
    return fail(404, "notfound", "Unknown request.");
  } catch (e) {
    if (e instanceof Reauth) return fail(401, "reauth", e.message, { acct: e.email });
    return fail(e.status || 500, "google", e.message || "Something went wrong talking to Google Calendar.");
  }
};
