/**
 * Recall scan template
 * --------------------
 * Checks dealer websites for Nissans, decodes each VIN, and lists the exact recalls
 * still open on each car, from Nissan's own recall lookup (the one on nissanusa.com).
 *
 * Steps for each dealer:
 *   1. Find pages that list inventory (robots.txt -> sitemaps -> common inventory pages)
 *   2. Pull every valid VIN out of those pages (17 characters, correct check digit)
 *   3. Keep the VINs for the make you care about (by the first 3 characters, the WMI)
 *   4. Decode year / model / trim with NHTSA's free VIN decoder (vPIC)
 *   5. Ask Nissan's recall lookup about each VIN: it answers with the recalls not yet repaired on that car
 *   6. Print a summary and save a CSV
 *
 * Run it:  node recall-scan-template.js        (Node 18 or newer; no packages needed)
 *
 * "Open recalls" are per car: the recalls Nissan shows as not yet repaired for that VIN.
 * A car Nissan's lookup couldn't answer for is marked "couldn't check", never "0 recalls".
 * The lookup only knows Nissan and INFINITI vehicles; another make needs its own maker's lookup.
 */

const fs = require("fs");

/* ============================== 1. Settings ============================== */

const CONFIG = {
  // Dealers to check. Add as many as you like.
  dealers: [
    { name: "Example Toyota", website: "https://www.example-toyota.com" },
    { name: "Example Used Cars", website: "https://www.example-usedcars.com" },
  ],

  // Which make to keep, by VIN prefix (World Manufacturer Identifier).
  // Nissan: 1N4 1N6 3N1 3N6 3N8 5N1 JN1 JN6 JN8.
  wmi: ["1N4", "1N6", "3N1", "3N6", "3N8", "5N1", "JN1", "JN6", "JN8"],
  make: "NISSAN", // must match NHTSA's make name

  // Inventory pages to try when the sitemap has no VINs. {make} is filled in.
  pages: ["/inventory?make={make}", "/used-vehicles/?make={make}", "/inventory/used?make={make}", "/used-inventory/index.htm", "/searchused.aspx?Make={make}"],

  maxSitemaps: 6,          // child sitemaps to open per dealer
  delayMs: 800,            // pause between dealers, to be polite
  recallDelayMs: 400,      // pause between recall lookups, to be polite
  outputCsv: "recall-scan-results.csv",
  userAgent: "Mozilla/5.0 (compatible; RecallScanTemplate/1.0)",
};

/* ============================== 2. VIN tools ============================== */

// Letter values and position weights from the VIN standard (49 CFR 565).
const VALUE = {};
"0123456789".split("").forEach((c, i) => (VALUE[c] = i));
[["ABCDEFGH", 1], ["JKLMN", 1], ["P", 7], ["R", 9], ["STUVWXYZ", 2]].forEach(([letters, start]) =>
  letters.split("").forEach((c, i) => (VALUE[c] = start + i)));
const WEIGHT = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** True if the 9th character (check digit) matches the rest of the VIN. */
function isValidVin(vin) {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false; // no I, O or Q
  const sum = vin.split("").reduce((s, c, i) => s + VALUE[c] * WEIGHT[i], 0);
  const r = sum % 11;
  return vin[8] === (r === 10 ? "X" : String(r));
}

/** Every valid VIN in a page, with a link to its listing when the link contains the VIN. */
function findVins(text, pageUrl) {
  const found = new Map();
  const links = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
  const re = /(?:^|[^A-Za-z0-9])([A-HJ-NPR-Za-hj-npr-z0-9]{17})(?=[^A-Za-z0-9]|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const vin = m[1].toUpperCase();
    if (found.has(vin) || !isValidVin(vin)) continue;
    const link = links.find((u) => u.toUpperCase().includes(vin) && !/\.(jpe?g|png|webp|gif)/i.test(u));
    found.set(vin, { vin, url: link || pageUrl });
  }
  return [...found.values()];
}

const wantedMake = (vin) => CONFIG.wmi.includes(vin.slice(0, 3));

/* ============================== 3. Reading a dealer's site ============================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": CONFIG.userAgent }, redirect: "follow" });
    return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : "" };
  } catch (e) {
    return { ok: false, status: 0, text: "" };
  }
}

/** Disallow rules and sitemap links for all robots ("User-agent: *"). */
function readRobots(text) {
  const rules = [], sitemaps = [];
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^sitemap$/i.test(key)) sitemaps.push(value);
    else if (/^user-agent$/i.test(key)) applies = value === "*";
    else if (applies && /^disallow$/i.test(key) && value) rules.push(value);
  }
  return { rules, sitemaps };
}
const allowed = (robots, path) => !robots.rules.some((rule) => path.startsWith(rule.replace(/\*.*$/, "")));

/** Finds the make's VINs on one dealer's website. */
async function scanDealer(dealer) {
  const base = new URL(dealer.website).origin;
  const vins = new Map();
  const add = (list) => list.forEach((v) => vins.has(v.vin) || vins.set(v.vin, v));
  let reachable = false, anyVins = 0;

  // robots.txt: which paths we may visit, and where the sitemaps are
  const robotsRes = await get(base + "/robots.txt");
  const robots = robotsRes.ok ? readRobots(robotsRes.text) : { rules: [], sitemaps: [] };

  // Sitemaps: many dealer platforms list every vehicle page, often with the VIN in the address
  const queue = [...new Set([base + "/sitemap.xml", ...robots.sitemaps])];
  const opened = new Set();
  while (queue.length && opened.size < CONFIG.maxSitemaps) {
    const url = queue.shift();
    if (opened.has(url)) continue;
    opened.add(url);
    const res = await get(url);
    if (!res.ok) continue;
    reachable = true;
    const children = [...res.text.matchAll(/<sitemap>\s*<loc>\s*([^<\s]+)/gi)].map((x) => x[1]);
    queue.push(...children.filter((u) => /inventory|vehicle|used|vdp|cars/i.test(u)));
    const list = findVins(res.text, url);
    anyVins += list.length;
    add(list.filter((v) => wantedMake(v.vin)));
  }

  // Inventory pages, if the sitemaps had no vehicles in them
  if (anyVins < 3) {
    for (const p of CONFIG.pages) {
      const path = p.replace("{make}", encodeURIComponent(CONFIG.make[0] + CONFIG.make.slice(1).toLowerCase()));
      if (!allowed(robots, path)) continue;
      const res = await get(base + path);
      if (!res.ok) continue;
      reachable = true;
      const list = findVins(res.text, base + path);
      anyVins += list.length;
      add(list.filter((v) => wantedMake(v.vin)));
    }
  }

  // Note: some sites load their inventory with JavaScript after the page opens, and some block
  // automated visits. Those come back with no VINs and need a site-specific approach.
  const status = anyVins >= 3 ? "read" : reachable ? "couldn't find inventory" : "no answer / blocked";
  return { dealer, status, vins: [...vins.values()] };
}

/* ============================== 4. Decoding VINs ============================== */

/** Year, make, model and trim for up to 50 VINs per request (NHTSA vPIC, free, no key). */
async function decodeVins(vins) {
  const out = {};
  for (let i = 0; i < vins.length; i += 50) {
    const body = new URLSearchParams({ format: "json", data: vins.slice(i, i + 50).join(";") });
    const res = await fetch("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValuesBatch/", { method: "POST", body });
    if (!res.ok) continue;
    for (const r of (await res.json()).Results || []) {
      out[r.VIN] = { year: Number(r.ModelYear) || null, make: (r.Make || "").toUpperCase(), model: r.Model || "", trim: r.Trim || r.Series || "" };
    }
  }
  return out;
}

/* ============================== 5. Exact recalls by VIN ============================== */

// Nissan's public recall lookup. Its form posts the VIN to an address written in the page itself,
// so that address is read from the page (it can change when Nissan edits the page).
const RECALL_SITE = "https://www.nissanusa.com";
const RECALL_PAGE = RECALL_SITE + "/owners/recalls-vin.html";
let recallUrl = RECALL_SITE + "/content/nissan_prod/en_US/index/owners/recalls-vin/jcr:content/freeEditorial/pagesection_50b2/page-section-par/columns12_ee1c/col1-par/vinrecalllookup_31c7.recallinfo.json";
let recallUrlRead = false;

function recallUrlFromPage(html) {
  const m = String(html || "").match(/data-json-url="([^"]+\.recallinfo\.json)"/);
  if (!m) return "";
  const p = m[1].replace(/&amp;/g, "&");
  if (p[0] === "/" && p[1] !== "/") return RECALL_SITE + p;
  return p.startsWith(RECALL_SITE + "/") ? p : "";
}

async function readRecallUrl() {
  recallUrlRead = true;
  try {
    const res = await fetch(RECALL_PAGE);
    if (res.ok) recallUrl = recallUrlFromPage(await res.text()) || recallUrl;
  } catch (e) { /* keep the address we have */ }
}

/**
 * Reads the lookup's answer for one VIN.
 * 200 with a "recalls" list: the recalls still open on the car.
 * 404 "Recalls Not Found": no open recall. Anything else: couldn't check.
 */
function parseRecallAnswer(status, text, vin) {
  let j = null;
  try { j = JSON.parse(text); } catch (e) { j = null; }
  if (status === 200 && j && Array.isArray(j.recalls)) {
    const str = (x) => String(x == null ? "" : x).replace(/\s+/g, " ").trim();
    const seen = new Set(), recalls = [];
    for (const r of j.recalls) {
      if (!r || (r.vin && String(r.vin).toUpperCase() !== vin)) continue;
      const x = {
        nhtsaId: str(r.govtRecallId), nissanId: str(r.nissanRecallId), name: str(r.secondaryDescription), type: str(r.typeCode),
        date: str(r.effectiveDate), summary: str(r.primaryDescription), risk: str(r.riskIfNotRepaired), remedy: str(r.remedyDescription),
      };
      const id = x.nissanId || x.nhtsaId || x.name;
      if (!id || seen.has(id)) continue;
      seen.add(id); recalls.push(x);
    }
    return { checked: true, recalls };
  }
  if (status === 404 && j && /not found|no data/i.test(`${j.status_code || ""} ${j.status_message || ""}`)) return { checked: true, recalls: [] };
  return { checked: false, status, recalls: [] };
}

async function askRecalls(vin) {
  try {
    const res = await fetch(recallUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
      body: new URLSearchParams({ vinNums: JSON.stringify([vin]) }),
    });
    return parseRecallAnswer(res.status, await res.text(), vin);
  } catch (e) {
    return { checked: false, status: 0, recalls: [] };
  }
}

/** The recalls still open on one car, straight from Nissan's lookup. */
async function openRecallsForVin(vin) {
  if (!recallUrlRead) await readRecallUrl();
  return askRecalls(vin);
}

/* ============================== 6. Putting it together ============================== */

async function main() {
  const rows = [];
  let stopped = "";
  for (const dealer of CONFIG.dealers) {
    const scan = await scanDealer(dealer);
    const decoded = await decodeVins(scan.vins.map((v) => v.vin));
    console.log(`\n${dealer.name}: ${scan.status}, ${scan.vins.length} ${CONFIG.make} vehicle(s)`);
    for (const v of scan.vins) {
      const info = decoded[v.vin] || {};
      if (info.make && info.make !== CONFIG.make) continue; // decoder says it's another make
      let answer = { checked: false, recalls: [] };
      if (!stopped) {
        answer = await openRecallsForVin(v.vin);
        // Nissan's site is turning us away: stop asking, and mark the rest "couldn't check".
        if (answer.status === 403 || answer.status === 429) stopped = `Nissan's lookup refused the request (HTTP ${answer.status})`;
        await sleep(CONFIG.recallDelayMs);
      }
      const r = answer.recalls;
      const ids = r.map((x) => x.nhtsaId || x.nissanId);
      console.log(`  ${info.year || "?"} ${info.model || "?"} ${info.trim || ""}  ${v.vin}  ` +
        (answer.checked ? `${r.length} open recall(s)` + (r.length ? `: ${r.map((x) => `${x.nhtsaId || x.nissanId} ${x.name}`).join("; ")}` : "") : "couldn't check"));
      rows.push([dealer.name, dealer.website, v.vin, info.year || "", info.model || "", info.trim || "",
        answer.checked ? r.length : "couldn't check", ids.join(" "), r.map((x) => x.nissanId).join(" "), r.map((x) => x.name).join("; "),
        r.map((x) => x.remedy).join(" | "), v.url]);
    }
    await sleep(CONFIG.delayMs);
  }
  if (stopped) console.log(`\n${stopped}. Cars after that point are marked "couldn't check"; run it again later.`);
  const csv = [["Dealer", "Website", "VIN", "Year", "Model", "Trim", "Open recalls", "NHTSA IDs", "Nissan IDs", "Recall names", "Remedies", "Listing"], ...rows]
    .map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
  fs.writeFileSync(CONFIG.outputCsv, csv);
  console.log(`\nSaved ${rows.length} vehicle(s) to ${CONFIG.outputCsv}`);
}

if (require.main === module) main();
module.exports = { CONFIG, main, isValidVin, findVins, readRobots, scanDealer, decodeVins, openRecallsForVin, parseRecallAnswer, recallUrlFromPage };
