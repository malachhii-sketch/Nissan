/**
 * Recall scan template
 * --------------------
 * Checks dealer websites for vehicles of one make (Nissan by default), decodes each VIN,
 * and lists the NHTSA recalls for that model and year.
 *
 * Steps for each dealer:
 *   1. Find pages that list inventory (robots.txt -> sitemaps -> common inventory pages)
 *   2. Pull every valid VIN out of those pages (17 characters, correct check digit)
 *   3. Keep the VINs for the make you care about (by the first 3 characters, the WMI)
 *   4. Decode year / model / trim with NHTSA's free VIN decoder (vPIC)
 *   5. Look up recalls for that make / model / year with NHTSA's free recalls API
 *   6. Print a summary and save a CSV
 *
 * Run it:  node recall-scan-template.js        (Node 18 or newer; no packages needed)
 *
 * "Possible recalls" are recalls listed for the model and year. Whether a specific car
 * still has a recall open comes from the automaker (NNA for Nissan), so confirm by VIN.
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
  // Nissan: 1N4 1N6 3N1 3N6 3N8 5N1 JN1 JN6 JN8. For another make, swap these
  // (e.g. Toyota: 4T1 4T3 5TD 5TF 2T1 2T3 JTD JTE JTM JTN).
  wmi: ["1N4", "1N6", "3N1", "3N6", "3N8", "5N1", "JN1", "JN6", "JN8"],
  make: "NISSAN", // must match NHTSA's make name

  // Inventory pages to try when the sitemap has no VINs. {make} is filled in.
  pages: ["/inventory?make={make}", "/used-vehicles/?make={make}", "/inventory/used?make={make}", "/used-inventory/index.htm", "/searchused.aspx?Make={make}"],

  maxSitemaps: 6,          // child sitemaps to open per dealer
  delayMs: 800,            // pause between dealers, to be polite
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

/* ============================== 5. Recalls by model and year ============================== */

const recallCache = new Map();

/** NHTSA recalls for a make / model / year (free, no key). Cached so each model-year is asked once. */
async function recallsFor(make, model, year) {
  const key = `${make}|${model}|${year}`.toUpperCase();
  if (recallCache.has(key)) return recallCache.get(key);
  const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`;
  let list = [];
  try {
    const res = await fetch(url);
    if (res.ok) {
      list = ((await res.json()).results || []).map((r) => ({
        campaign: r.NHTSACampaignNumber,
        component: r.Component,
        summary: r.Summary,
        remedy: r.Remedy,
        date: r.ReportReceivedDate,
      }));
    }
  } catch (e) { /* leave empty */ }
  recallCache.set(key, list);
  return list;
}

/* ============================== 6. Putting it together ============================== */

async function main() {
  const rows = [];
  for (const dealer of CONFIG.dealers) {
    const scan = await scanDealer(dealer);
    const decoded = await decodeVins(scan.vins.map((v) => v.vin));
    console.log(`\n${dealer.name}: ${scan.status}, ${scan.vins.length} ${CONFIG.make} vehicle(s)`);
    for (const v of scan.vins) {
      const info = decoded[v.vin] || {};
      if (info.make && info.make !== CONFIG.make) continue; // decoder says it's another make
      const recalls = info.model && info.year ? await recallsFor(CONFIG.make, info.model, info.year) : [];
      console.log(`  ${info.year || "?"} ${info.model || "?"} ${info.trim || ""}  ${v.vin}  ${recalls.length} possible recall(s)` +
        (recalls.length ? `: ${recalls.map((r) => r.campaign).join(", ")}` : ""));
      rows.push([dealer.name, dealer.website, v.vin, info.year || "", info.model || "", info.trim || "", recalls.length, recalls.map((r) => r.campaign).join(" "), v.url]);
    }
    await sleep(CONFIG.delayMs);
  }
  const csv = [["Dealer", "Website", "VIN", "Year", "Model", "Trim", "Possible recalls", "Campaigns", "Listing"], ...rows]
    .map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
  fs.writeFileSync(CONFIG.outputCsv, csv);
  console.log(`\nSaved ${rows.length} vehicle(s) to ${CONFIG.outputCsv}`);
}

if (require.main === module) main();
module.exports = { CONFIG, main, isValidVin, findVins, readRobots, scanDealer, decodeVins, recallsFor };
