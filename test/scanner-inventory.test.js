// Run: node --test
// Checks that the lot scanner doesn't mistake a homepage's featured cars for a dealer's whole lot.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Valid VINs (correct check digit) with a given 3-character maker prefix.
const VAL = {}; "0123456789".split("").forEach((c, i) => (VAL[c] = i));
[["ABCDEFGH", 1], ["JKLMN", 1], ["P", 7], ["R", 9], ["STUVWXYZ", 2]].forEach(([l, s]) => l.split("").forEach((c, i) => (VAL[c] = s + i)));
const W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
function vin(prefix, n) {
  const v = (prefix + "AL3AP" + "0" + "JC" + String(100000 + n)).split("");
  const r = v.reduce((s, c, i) => s + VAL[c] * W[i], 0) % 11;
  v[8] = r === 10 ? "X" : String(r);
  return v.join("");
}
const listPage = (vins) => "<html><body>" + vins.map((v) => `<div class="car" data-vin="${v}">${v}</div>`).join("") + "</body></html>";

function load(site) {
  const ctx = { console, JSON, Date, Math, Object, Array, String, Number, RegExp, Error, encodeURIComponent, decodeURIComponent, Logger: { log() {} } };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, "..", "lot-scanner-code.txt"), "utf8") +
    "\nhttp_ = function (reqs) { return __web(reqs); }; this.DealerJob = DealerJob; this.runJobs_ = runJobs_;";
  const asked = [];
  ctx.__web = (reqs) => reqs.map((q) => { asked.push(q.url); const page = site(q.url); return page == null ? { code: 404, text: "" } : { code: 200, text: page }; });
  vm.runInContext(src, ctx);
  return { ctx, asked };
}

const BASE = "https://www.example-chevy.com";
const featured = Array.from({ length: 27 }, (_, i) => vin("1G1", i));          // 27 Chevys on the homepage carousel
const nissans = [vin("1N4", 1), vin("3N1", 2), vin("5N1", 3), vin("JN8", 4)];  // the used Nissans in the inventory

test("homepage featured cars don't count as reading the lot: the scanner goes on to the inventory", () => {
  const { ctx, asked } = load((u) => {
    if (u === BASE + "/") return listPage(featured);
    if (u === BASE + "/inventory?make=Nissan") return listPage(nissans);
    return null;
  });
  const job = new ctx.DealerJob({ id: "d1", name: "Example Chevy", website: BASE }, null, {});
  const r = ctx.runJobs_([job])[0];
  assert.ok(asked.includes(BASE + "/inventory?make=Nissan"), "opened an inventory page");
  assert.equal(r.status, "ok");
  assert.equal(r.method, "page");
  assert.deepEqual(r.nissan.map((x) => x.vin).sort(), [...nissans].sort());
  assert.equal(r.learned.r[0].u, BASE + "/inventory?make=Nissan", "remembers the inventory page, not the homepage");
});

test("a dealer whose only cars are on the homepage is flagged, and not remembered that way", () => {
  const { ctx } = load((u) => (u === BASE + "/" ? listPage(featured.concat([nissans[0]])) : null));
  const r = ctx.runJobs_([new ctx.DealerJob({ id: "d1", name: "Example", website: BASE }, null, {})])[0];
  assert.equal(r.status, "ok", "the cars it did see are still kept");
  assert.equal(r.method, "home");
  assert.match(r.diag, /only the homepage's featured cars/);
  assert.equal(r.learned, undefined);
  assert.equal(r.nissan.length, 1);
});

test("an old learned 'homepage' method is dropped and the site is looked at again", () => {
  const { ctx, asked } = load((u) => {
    if (u === BASE + "/") return listPage(featured);
    if (u === BASE + "/inventory?make=Nissan") return listPage(nissans);
    return null;
  });
  const learned = { m: "page", b: BASE, r: [{ u: BASE + "/" }] };
  const r = ctx.runJobs_([new ctx.DealerJob({ id: "d1", name: "Example", website: BASE }, learned, { s: "ok" })])[0];
  assert.ok(asked.includes(BASE + "/robots.txt"), "rediscovered the site");
  assert.equal(r.method, "page");
  assert.equal(r.nissan.length, 4);
});

test("a sitemap full of vehicle pages still counts as reading the lot", () => {
  const { ctx, asked } = load((u) => {
    if (u === BASE + "/") return listPage(featured.slice(0, 5));
    if (u === BASE + "/sitemap.xml") return "<urlset>" + nissans.concat(featured).map((v) => `<url><loc>${BASE}/used/${v}.htm</loc></url>`).join("") + "</urlset>";
    return null;
  });
  const r = ctx.runJobs_([new ctx.DealerJob({ id: "d1", name: "Example", website: BASE }, null, {})])[0];
  assert.equal(r.method, "sitemap");
  assert.equal(r.nissan.length, 4);
  assert.ok(!asked.includes(BASE + "/inventory?make=Nissan"), "no need for inventory pages");
});
