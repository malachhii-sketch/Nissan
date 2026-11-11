/**
 * Nissan recall check for the CRM ("Check all lot VINs with Nissan" button).
 *
 * POST /.netlify/functions/nissan-recalls
 *   Authorization: Bearer <the signed-in team member's Firebase ID token>
 *   Body: { "vins": ["5N1BT3BB2PC836400", ...] }   (up to 4 per request)
 * Answer: { results: [{ vin, ok, code, blocked, open: [{ c, n, d, a }] }] }
 *   ok: true  -> Nissan answered; "open" lists the campaigns still open on that exact car ([] = none).
 *   ok: false -> Nissan didn't answer for that car; leave it unchecked and try again later.
 *
 * Browsers can't call nissanusa.com from another site, so the CRM page asks this function instead.
 * Only active CRM team members can use it: the token is checked by reading the caller's own
 * team/{email} entry from Firestore with it, which also applies the project's security rules.
 */

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "macomb-recall-crm";
const MAX_VINS = 4;
const TIMEOUT_MS = 7000;

// Nissan's public recall lookup. Its form posts the VIN to an address written in the page itself,
// so that address is read from the page (it can change when Nissan edits the page).
const RECALL_SITE = "https://www.nissanusa.com";
const RECALL_PAGE = RECALL_SITE + "/owners/recalls-vin.html";
const RECALL_URL = RECALL_SITE + "/content/nissan_prod/en_US/index/owners/recalls-vin/jcr:content/freeEditorial/pagesection_50b2/page-section-par/columns12_ee1c/col1-par/vinrecalllookup_31c7.recallinfo.json";
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

let lookup = { url: "", at: 0 }; // kept between calls while the function stays warm

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

/* ---------- who is asking ---------- */

function tokenEmail(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return { email: String(p.email || "").trim().toLowerCase(), verified: p.email_verified === true };
  } catch (e) {
    return { email: "", verified: false };
  }
}

/** Active team members (not the scanner robot) may use the checker. */
export async function checkCaller(authHeader, fetchFn = fetch) {
  const token = String(authHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "Sign in to the CRM first." };
  const { email, verified } = tokenEmail(token);
  if (!email) return { ok: false, status: 401, error: "Your sign-in couldn't be read. Sign out and back in." };
  let res;
  try {
    res = await fetchFn(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/team/${encodeURIComponent(email)}`,
      { headers: { Authorization: "Bearer " + token } });
  } catch (e) {
    return { ok: false, status: 502, error: "Couldn't confirm your CRM access. Try again." };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, status: 401, error: "Your sign-in has expired. Sign out and back in." };
  if (res.status === 404) return { ok: false, status: 403, error: "Your account isn't on the CRM team." };
  if (!res.ok) return { ok: false, status: 502, error: "Couldn't confirm your CRM access. Try again." };
  const f = ((await res.json()) || {}).fields || {};
  const active = f.active && f.active.booleanValue === true;
  const role = f.role && f.role.stringValue;
  const needsVerify = f.requireVerify && f.requireVerify.booleanValue === true;
  if (!active || role === "scanner" || (needsVerify && !verified)) return { ok: false, status: 403, error: "Your account can't run recall checks." };
  return { ok: true, email };
}

/* ---------- Nissan's lookup ---------- */

export function recallUrlFromPage(html) {
  const m = String(html || "").match(/data-json-url="([^"]+\.recallinfo\.json)"/);
  if (!m) return "";
  const p = m[1].replace(/&amp;/g, "&");
  if (p[0] === "/" && p[1] !== "/") return RECALL_SITE + p;
  return p.startsWith(RECALL_SITE + "/") ? p : "";
}

async function lookupUrl(fresh, fetchFn) {
  if (!fresh && lookup.url && Date.now() - lookup.at < 6 * 36e5) return lookup.url;
  try {
    const res = await fetchFn(RECALL_PAGE, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const u = res.ok ? recallUrlFromPage(await res.text()) : "";
    if (u) { lookup = { url: u, at: Date.now() }; return u; }
  } catch (e) { /* keep what we have */ }
  return lookup.url || RECALL_URL;
}

/**
 * Reads Nissan's answer for one VIN, in the shape the CRM saves in vinchecks/{VIN}.open:
 * c = campaign # (Nissan's, or NHTSA's without dashes if Nissan gave none), n = NHTSA #, d = name, a = date.
 * 200 with a "recalls" list: open campaigns. 404 "Recalls Not Found": none open. Anything else: couldn't check.
 */
export function parseRecallAnswer(status, text, vin) {
  let j = null;
  try { j = JSON.parse(text); } catch (e) { j = null; }
  if (status === 200 && j && Array.isArray(j.recalls)) {
    const str = (x, n) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n);
    const seen = new Set(), open = [];
    for (const r of j.recalls) {
      if (!r || (r.vin && String(r.vin).toUpperCase() !== vin)) continue; // another car's answer
      const n = str(r.govtRecallId, 20);
      const c = (str(r.nissanRecallId, 20) || n).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
      if (c.length < 3 || seen.has(c)) continue;
      seen.add(c);
      const x = { c };
      if (n) x.n = n;
      const d = str(r.secondaryDescription, 160) || str(r.primaryDescription, 160);
      if (d) x.d = d;
      const a = str(r.effectiveDate, 30).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(a)) x.a = a;
      open.push(x);
    }
    return { vin, ok: true, code: status, open };
  }
  if (status === 404 && j && /not found|no data/i.test(`${j.status_code || ""} ${j.status_message || ""}`)) return { vin, ok: true, code: status, open: [] };
  return { vin, ok: false, code: status, blocked: status === 403 || status === 429, open: [] };
}

async function ask(url, vin, fetchFn) {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { Accept: "application/json", "Cache-Control": "no-store", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ vinNums: JSON.stringify([vin]) }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return parseRecallAnswer(res.status, await res.text(), vin);
  } catch (e) {
    return { vin, ok: false, code: 0, open: [] };
  }
}

export async function checkVins(vins, fetchFn = fetch) {
  let url = await lookupUrl(false, fetchFn);
  let results = await Promise.all(vins.map((v) => ask(url, v, fetchFn)));
  // Nothing could be read and Nissan isn't refusing us: the lookup may have moved. Read its address again, once.
  if (results.every((r) => !r.ok && !r.blocked)) {
    const u2 = await lookupUrl(true, fetchFn);
    if (u2 !== url) results = await Promise.all(vins.map((v) => ask(u2, v, fetchFn)));
  }
  return results;
}

/* ---------- handler ---------- */

export async function handle(req, fetchFn = fetch) {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  const who = await checkCaller(req.headers.get("authorization"), fetchFn);
  if (!who.ok) return json(who.status, { error: who.error });
  let body = null;
  try { body = await req.json(); } catch (e) { body = null; }
  const vins = [...new Set(((body && body.vins) || []).map((v) => String(v || "").replace(/\s/g, "").toUpperCase()))]
    .filter((v) => VIN_RE.test(v));
  if (!vins.length) return json(400, { error: "Send { vins: [...] } with at least one 17-character VIN." });
  if (vins.length > MAX_VINS) return json(400, { error: `Send at most ${MAX_VINS} VINs per request.` });
  return json(200, { results: await checkVins(vins, fetchFn) });
}

export default (req) => handle(req);
