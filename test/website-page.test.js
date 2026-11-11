// Run: node --test
// Checks the CRM page's recall logic (lot scanner results, "Check lot VINs with Nissan" button) with stand-ins for Firebase and the page.
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), vm = require("vm");
const src = fs.readFileSync(require("path").join(__dirname, "..", "website", "index.html"), "utf8");
const grab = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
const code = [grab("function vdoc(", "const dbsDay"), grab("const AUTO_EVERY_DAYS", '$("#vin-auto").addEventListener')].join("\n");
function setup(nissan) {
  const els = {}; const el = id => els[id] || (els[id] = { id, hidden: true, disabled: false, textContent: "", innerHTML: "", dataset: {} });
  const writes = [], posts = [];
  const ctx = {
    console, Date, Map, Set, JSON, Promise, setTimeout: (f) => setTimeout(f, 0), Math, String, Array, Object, Number,
    VIN_RE17: /^[A-HJ-NPR-Z0-9]{17}$/,
    S: { db: {}, readOnly: false, me: { id: "u1", name: "Pat" }, vchk: new Map(), lots: new Map() },
    $: s => el(s.replace("#", "")), busy: (b, on, l) => { b.disabled = on; if (on) b.textContent = l; }, toast() {}, renderAll2() {},
    nowISO: () => new Date().toISOString(), plural: (n, o) => `${n} ${n === 1 ? o : o + "s"}`, esc: s => String(s), authErr: e => String(e),
    commitWrites: async w => { writes.push(...w); },
    auth: { currentUser: { getIdToken: async () => "tok" } },
    fetch: async (url, o) => { const vins = JSON.parse(o.body).vins; posts.push(vins); const r = nissan(vins); return { ok: r.status === 200, status: r.status, json: async () => r.body }; },
  };
  vm.createContext(ctx); vm.runInContext(code + "\nthis.f={autoList,runAutoCheck,vcheck,isRemoved};", ctx);
  return { ctx, els, writes, posts };
}
const ago = d => new Date(Date.now() - d * 864e5).toISOString();
const V = i => ("5N1BT3BB2PC83640" + i);

test("uses the lot scanner's saved check, and the newest check wins", () => {
  const s = setup(); const { S } = s.ctx;
  S.lots.set("d1", { cars: [{ v: V(0), rt: ago(2), rc: [{ n: "20V-315", c: "PC735", t: "Hood", d: "2020-06-01" }] }, { v: V(1), rt: ago(2), rc: [] }, { v: V(2) }] });
  S.vchk.set(V(1), { v: V(1), at: ago(1), open: [{ c: "R25E2" }] });
  assert.deepEqual(JSON.parse(JSON.stringify(s.ctx.f.vcheck(V(0)).open)), [{ c: "PC735", d: "Hood", a: "2020-06-01" }]);
  assert.equal(s.ctx.f.vcheck(V(1)).open[0].c, "R25E2", "newer saved check beats older scanner check");
  assert.equal(s.ctx.f.vcheck(V(2)), null);
  assert.equal(s.ctx.f.isRemoved({ v: V(0) }), false);
  S.lots = new Map([["d1", { cars: [{ v: V(0), rt: ago(0), rc: [] }] }]]); // Firebase sends a new list
  assert.equal(s.ctx.f.isRemoved({ v: V(0) }), true, "scanner found no recalls: off the list");
});

test("button checks due VINs in groups of 4, saves answers, leaves failures unchecked", async () => {
  const s = setup(vins => ({ status: 200, body: { results: vins.map(v => v === V(3) ? { vin: v, ok: false, code: 500, open: [] } : { vin: v, ok: true, open: v === V(0) ? [{ c: "PC735", d: "Hood" }] : [] }) } }));
  const { S } = s.ctx;
  const cars = [0,1,2,3,4,5].map(i => ({ v: V(i) })); cars.push({ v: V(6), rt: ago(1), rc: [] }); // V6 recently checked
  S.lots.set("d1", { cars }); S.lots.set("d2", { cars: [{ v: V(0) }] }); // same car on two lots
  S.vchk.set(V(5), { v: V(5), removed: true });                       // removed by hand
  S.vchk.set(V(4), { v: V(4), at: ago(30), open: [], removed: false }); // put back by hand, old check
  assert.deepEqual([...s.ctx.f.autoList()], [V(0), V(1), V(2), V(3), V(4)]);
  await s.ctx.f.runAutoCheck();
  assert.deepEqual(s.posts.map(p => p.length), [3, 2]);
  const saved = Object.fromEntries(s.writes.map(([c, id, d]) => [id, d]));
  assert.deepEqual(Object.keys(saved).sort(), [V(0), V(1), V(2), V(4)]);
  assert.equal(saved[V(0)].open[0].c, "PC735"); assert.equal(saved[V(0)].src, "Nissan.com"); assert.equal(saved[V(0)].updatedByName, "Pat");
  assert.equal(saved[V(4)].removed, false, "keeps a by-hand 'put back'");
  assert.match(s.els["vin-auto-out"].innerHTML, /Saved 4 VIN checks: <b>1<\/b> with open campaigns, 3 with none.*1 car couldn't be checked and will be tried next time \(HTTP 500: 1\)/);
  assert.deepEqual([...s.ctx.f.autoList()], [V(3)], "next run: only the failed car");
});

test("stops when Nissan refuses, and explains a missing function", async () => {
  let s = setup(vins => ({ status: 200, body: { results: vins.map(v => ({ vin: v, ok: false, blocked: true, open: [] })) } }));
  s.ctx.S.lots.set("d1", { cars: [0,1,2,3,4,5].map(i => ({ v: V(i) })) });
  await s.ctx.f.runAutoCheck();
  assert.equal(s.posts.length, 1); assert.match(s.els["vin-auto-out"].innerHTML, /refusing requests/);
  s = setup(() => ({ status: 404, body: {} }));
  s.ctx.S.lots.set("d1", { cars: [{ v: V(0) }] });
  await s.ctx.f.runAutoCheck();
  assert.match(s.els["vin-auto-out"].innerHTML, /isn't on the website yet/);
});

test("stops after two groups in a row with no answers, even after earlier successes", async () => {
  let n = 0;
  const s = setup(vins => { n++; return { status: 200, body: { results: vins.map(v => n === 1 ? { vin: v, ok: true, open: [] } : { vin: v, ok: false, code: 0, why: "no answer", open: [] }) } }; });
  s.ctx.S.lots.set("d1", { cars: Array.from({ length: 30 }, (_, i) => ({ v: "5N1BT3BB2PC8364" + String(i).padStart(2, "0") })) });
  await s.ctx.f.runAutoCheck();
  assert.equal(s.posts.length, 3, "one good group, then two empty ones");
  assert.match(s.els["vin-auto-out"].innerHTML, /Saved 3 VIN checks.*6 cars couldn't be checked.*\(no answer: 6\).*stopped answering/);
});

/* ---------- DBS vehicle pages pasted as text ---------- */
const dbsCode = grab("const DBS_LABELS", "let vinParsed = null;");
function dbsParse(text) {
  const ctx = { console, JSON, String, Number, Array, Object, RegExp, Math, VIN_RE17: /^[A-HJ-NPR-Z0-9]{17}$/ };
  vm.createContext(ctx); vm.runInContext(dbsCode + "\nthis.parse = parseVinResults;", ctx);
  return JSON.parse(JSON.stringify(ctx.parse(text)));
}
const TOP = (vin, n) => `2015 NISSAN ALTIMA\nVIN: ${vin}\nModel Line: ALTIMA\nWINDOW STICKER\nOpen Campaigns\n${n}\nStop Sales\n1 Stop Sale Records Found.\nBranded Title\nNo Branded Title Found\nTSBs\n136 Active TSB(s)\n`;
const LINES = "Open Campaign Information\nCampaign #: R21A6\nActivation Date: June 24, 2021\nCampaign Description\nALTIMA HOOD LATCH NTB21-055\nLearn More.\nRepair Complete\nNO\nStop Sale\nYES\nParts Restriction\nNO\n";
const COLUMNS = "Open Campaign Information\nCampaign #: R21A6\tActivation Date: June 24, 2021\nCampaign Description\tRepair Complete\tStop Sale\tParts Restriction\nALTIMA HOOD LATCH NTB21-055\tNO\tYES\tNO\nLearn More.\n";
const R21A6 = { c: "R21A6", d: "ALTIMA HOOD LATCH NTB21-055", a: "2021-06-24", ss: true };

test("reads a pasted DBS page, laid out as lines or as columns", () => {
  for (const body of [LINES, COLUMNS]) {
    const r = dbsParse(TOP("1N4AL3AP1FC286673", "1 Active Campaign(s)") + body);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.rows, [{ vin: "1N4AL3AP1FC286673", open: [R21A6], src: "DBS" }]);
  }
});

test("several DBS pages pasted one after another, including a car with none", () => {
  const second = "Campaign #: PC948\nActivation Date: March 3, 2024\nCampaign Description\nCVT SOFTWARE\nRepair Complete\nNO\nStop Sale\nNO\nParts Restriction\nYES\n";
  const r = dbsParse(TOP("1N4AL3AP1FC286673", "2 Active Campaign(s)") + LINES + second + "\n" + TOP("3N1AB8CV5MY123456", "No Active Campaign(s)"));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows[0].open.map((o) => o.c), ["R21A6", "PC948"]);
  assert.deepEqual(r.rows[0].open[1], { c: "PC948", d: "CVT SOFTWARE", a: "2024-03-03", pr: true });
  assert.deepEqual(r.rows[1], { vin: "3N1AB8CV5MY123456", open: [], src: "DBS" });
});

test("won't save a car as clean when its campaign details weren't copied", () => {
  const r = dbsParse(TOP("1N4AL3AP1FC286673", "1 Active Campaign(s)"));
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0], /1N4AL3AP1FC286673: DBS says 1 active campaign, but the details weren't copied/);
  const u = dbsParse("VIN: 1N4AL3AP1FC286673\nOpen Campaigns\n");
  assert.equal(u.rows.length, 0); assert.match(u.errors[0], /couldn't find its campaigns/);
});

test("a campaign DBS shows as repaired isn't counted as open; typed lines still work", () => {
  const done = LINES.replace("Repair Complete\nNO", "Repair Complete\nYES");
  assert.deepEqual(dbsParse(TOP("1N4AL3AP1FC286673", "1 Active Campaign(s)") + done).rows[0].open, []);
  assert.deepEqual(dbsParse("5N1BT3BB2PC836400: R25E2\n3N1AB8CV5MY123456: none").rows.map((x) => x.open.length), [1, 0]);
});

/* ---------- Open-campaign lists pasted as text ---------- */
const VX = (vin, code, desc, y, md, dealer, street, city, zip) => `${vin}\n${code}\n${desc}\n${y}\t\nNissan\n${md}\n${dealer}\n${street}\n${city}\n${zip}\t\n\n\n`;
const LIST = VX("JN8AZ1MW7EW526861", "P0A08", "BRAKE FLUID FLUSH", 2014, "Murano", "Decisive Auto Sales", "8105 Smiley Ave", "Shelby Township", 48316) +
  VX("5N1AT2MV4EC836473", "PC459", "LIFTGATE STAY", 2014, "Rogue", "Suburban Auto Sales 2018 LLC", "26312 John R Road", "Madison Heights", 48071) +
  VX("5N1AT2MV4EC836473", "PC490", "CVT REPROGRAM", 2014, "Rogue", "Suburban Auto Sales 2018 LLC", "26312 John R Road", "Madison Heights", 48071) +
  VX("5N1AT2MV4EC836473", "R21B9", "DASH SIDE HARNESS", 2014, "Rogue", "Suburban Auto Sales 2018 LLC", "26312 John R Road", "Madison Heights", 48071) +
  VX("1N4AL4FV0LN307459", "R23C3", "REAR-VIEW CAMERA", 2020, "Altima", "Your Choice Auto Sales", "3332 Wyoming Avenue", "Dearborn", 48120);

test("reads a pasted open-campaign list: one row per VIN with all its open campaigns", () => {
  const r = dbsParse(LIST);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[1], { vin: "5N1AT2MV4EC836473", src: "Nissan", seen: "Suburban Auto Sales 2018 LLC · Madison Heights",
    lot: { dn: "Suburban Auto Sales 2018 LLC", street: "26312 John R Road", city: "Madison Heights", zip: "48071" }, car: { y: 2014, md: "Rogue" },
    open: [{ c: "PC459", d: "LIFTGATE STAY" }, { c: "PC490", d: "CVT REPROGRAM" }, { c: "R21B9", d: "DASH SIDE HARNESS" }] });
  assert.deepEqual(r.rows[0].open, [{ c: "P0A08", d: "BRAKE FLUID FLUSH" }]);
});

test("Campaign list copied as table rows, and an entry whose VIN wasn't copied", () => {
  const rows = "JN1BJ1CP8JW196579\tP9327\tAEB\t2018\tNissan\tRogue Sport\tYour Choice Auto Sales\t3332 Wyoming Avenue\tDearborn\t48120\n" +
    "5N1AT3BB1MC734206\tPD108\tEEM LOGIC\t2021\tNissan\tRogue\tYour Choice Auto Sales\t3332 Wyoming Avenue\tDearborn\t48120\n";
  const r = dbsParse(rows);
  assert.deepEqual(r.rows.map((x) => [x.vin, x.open[0].c, x.seen]), [["JN1BJ1CP8JW196579", "P9327", "Your Choice Auto Sales · Dearborn"], ["5N1AT3BB1MC734206", "PD108", "Your Choice Auto Sales · Dearborn"]]);

  const cut = "P1A25\nREAR O2 SENSOR\n2014\t\nNissan\nSentra\nToyota of Ann Arbor\n3745 Jackson Road\nAnn Arbor\n48103\t\n\n\n" + LIST;
  const c = dbsParse(cut);
  assert.equal(c.rows.length, 3, "the rest is still read");
  assert.equal(c.errors.length, 1);
  assert.match(c.errors[0], /Skipped P1A25 REAR O2 SENSOR \(2014 · Sentra · Toyota of Ann Arbor\): its VIN wasn't in what was copied/);
});

/* ---------- Adding dealers and cars from a pasted campaign list ---------- */
function listCtx() {
  const ctx = { console, JSON, String, Number, Array, Object, RegExp, Math, Map, Set, Date, VIN_RE17: /^[A-HJ-NPR-Z0-9]{17}$/,
    slug: (s) => String(s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60), localISO: () => "2026-11-11",
    S: { me: { id: "u1", name: "Pat", email: "pat@example.com" }, dealers: new Map(), lotsRaw: new Map(), lots: new Map() } };
  vm.createContext(ctx);
  vm.runInContext(grab("const DBS_LABELS", "let vinParsed = null;") + "\nthis.f = { parse: parseVinResults, plan: listDealerWrites, find: findDealerId, rebuild: rebuildLots };", ctx);
  return ctx;
}
const ENTRY = (vin, code, y, md, dealer, street, city, zip) => `${vin}\n${code}\nDESC ${code}\n${y}\t\nNissan\n${md}\n${dealer}\n${street}\n${city}\n${zip}\t\n\n`;

test("a pasted list adds missing dealers and their cars, and matches dealers the CRM already has", () => {
  const ctx = listCtx(), S = ctx.S;
  S.dealers.set("d-golling-toyota", { name: "Golling Toyota", city: "Warren", addr: "", phones: [] });
  S.dealers.set("d-galeanas", { name: "Galeana's Van Dyke Dodge", city: "Warren", addr: "28400 Van Dyke Ave", zip: "48093" });
  S.lotsRaw.set("d-galeanas", { cars: [{ v: "KNMAT2MV3GP678076" }] });
  const text = ENTRY("JN1BJ1CP6KW230858", "R22C9", 2019, "Rogue Sport", "Golling Toyota", "27100 Van Dyke Ave", "Warren", 48093) +
    ENTRY("KNMAT2MV3GP678076", "PC490", 2016, "Rogue", "Galeana's Van Dyke Dodge-Ram", "28400 Van Dyke Ave", "Warren", 48093) +
    ENTRY("JN1BJ1CP8JW196579", "P9327", 2018, "Rogue Sport", "Your Choice Auto Sales", "3332 Wyoming Avenue", "Dearborn", 48120) +
    ENTRY("1N4AL4FV0LN307459", "R23C3", 2020, "Altima", "Your Choice Auto Sales", "3332 Wyoming Avenue", "Dearborn", 48120) +
    ENTRY("1N4AL4FV0LN307459", "R25B1", 2020, "Altima", "Your Choice Auto Sales", "3332 Wyoming Avenue", "Dearborn", 48120);
  const { rows } = ctx.f.parse(text);
  const plan = JSON.parse(JSON.stringify(ctx.f.plan(rows, "2026-11-11T12:00:00Z")));
  assert.deepEqual(plan.added, ["Your Choice Auto Sales"]);
  assert.equal(plan.carsAdded, 3, "Galeana's car is already on its scanned lot");
  const byId = Object.fromEntries(plan.writes.map(([, id, d]) => [id, d]));
  assert.deepEqual(Object.keys(byId).sort(), ["d-golling-toyota", "d-your-choice-auto-sales-dearborn"]);
  const yc = byId["d-your-choice-auto-sales-dearborn"];
  assert.equal(yc.addr, "3332 Wyoming Avenue"); assert.equal(yc.city, "Dearborn"); assert.equal(yc.zip, "48120"); assert.equal(yc.source, "Campaign list");
  assert.deepEqual(yc.listed.map((c) => [c.v, c.y, c.md]), [["JN1BJ1CP8JW196579", 2018, "Rogue Sport"], ["1N4AL4FV0LN307459", 2020, "Altima"]]);
  assert.equal(byId["d-golling-toyota"].addr, "27100 Van Dyke Ave", "fills a missing address");

  // The cars then show on those dealers' lots, next to what the scanner found.
  plan.writes.forEach(([, id, d]) => S.dealers.set(id, d));
  ctx.f.rebuild();
  assert.deepEqual(S.lots.get("d-your-choice-auto-sales-dearborn").cars.map((c) => c.v), ["JN1BJ1CP8JW196579", "1N4AL4FV0LN307459"]);
  assert.deepEqual(S.lots.get("d-galeanas").cars.map((c) => c.v), ["KNMAT2MV3GP678076"]);

  // Pasting the same list again adds nothing new.
  assert.equal(ctx.f.plan(rows, "2026-11-12T12:00:00Z").writes.length, 0);
});

/* ---------- Cars-to-check spreadsheet ---------- */
function sheetCtx() {
  const ctx = { console, JSON, String, Number, Array, Object, RegExp, Math, Map, Set, Date, VIN_RE17: /^[A-HJ-NPR-Z0-9]{17}$/,
    plural: (n, o) => `${n} ${n === 1 ? o : o + "s"}`, S: { lots: new Map(), dealers: new Map(), vchk: new Map() },
    C: { "21V135000": { comp: "ELECTRICAL SYSTEM:STOP LAMP SWITCH" }, "16V244000": { comp: "AIR BAGS" } },
    compParts: (c) => ({ title: String(c).split(":").pop().toLowerCase().replace(/^./, (x) => x.toUpperCase()) }),
    carKey: (md) => String(md || "").toUpperCase() || null, isRemoved: () => false };
  ctx.carRecalls = (c) => (c.md === "Sentra" ? ["21V135000", "16V244000"] : []);
  ctx.vcheck = (vin) => { const k = ctx.S.vchk.get(vin); return k && k.at ? k : null; };
  vm.createContext(ctx);
  vm.runInContext(grab("const colName", "/** One-sheet .xlsx") + grab("const NISSAN_CODES", "$(\"#vin-xlsx\")") + grab("function parseCheckSheet", "$(\"#vin-xlsx-in\")") +
    "\nthis.f = { sheet: checkSheet, parse: parseCheckSheet, head: CHECK_HEAD };", ctx);
  return ctx;
}

test("cars-to-check spreadsheet: one row per car, dropdowns of Nissan campaign numbers (not NHTSA numbers)", () => {
  const ctx = sheetCtx(), S = ctx.S, now = new Date().toISOString();
  S.dealers.set("d1", { name: "Glassman Hyundai", city: "Southfield", phones: [{ n: "(248) 555-0100" }] });
  S.dealers.set("d2", { name: "Another Store", city: "Troy" });
  S.lots.set("d1", { cars: [{ v: "3N1AB7AP1KY233254", y: 2019, md: "Sentra" }, { v: "1N4AL3AP1FC286673", y: 2015, md: "Altima" }, { v: "1N4AL3AP2FC000001", y: 2015, md: "Altima" }] });
  S.lots.set("d2", { cars: [{ v: "3N1AB7AP1KY233254", y: 2019, md: "Sentra" }] }); // the same car listed by a second dealer
  S.vchk.set("1N4AL3AP2FC000001", { at: now, open: [{ c: "R21A6", d: "ALTIMA HOOD LATCH" }, { c: "21V551000" }] }); // already checked in DBS
  const { rows, vals } = JSON.parse(JSON.stringify(ctx.f.sheet()));
  assert.deepEqual(rows.map((r) => r[0]), ["1N4AL3AP1FC286673", "3N1AB7AP1KY233254"], "no duplicates; the checked car isn't listed");
  const sentra = rows[1], altima = rows[0];
  assert.equal(sentra[6], "PM971 Stop lamp switch; Air bags (Nissan number not listed)");
  assert.deepEqual(vals[1], { ref: "H3:M3", list: ["PM971", "None"] });
  assert.equal(altima[6], "R21A6 ALTIMA HOOD LATCH", "learned from another 2015 Altima checked in DBS; NHTSA numbers aren't offered");
  assert.deepEqual(vals[0].list, ["R21A6", "None"]);
  assert.ok(!JSON.stringify(vals).includes("21V"), "no NHTSA numbers in the dropdowns");
});

test("reads a filled-in cars-to-check spreadsheet: picked and typed campaigns are open, None is clean, blank isn't checked", () => {
  const ctx = sheetCtx(), H = [...ctx.f.head];
  const row = (vin, possible, picks, other) => [vin, 2019, "Sentra", "Dealer", "City", "", possible].concat(picks.concat(Array(6 - picks.length).fill("")), [other, ""]);
  const r = JSON.parse(JSON.stringify(ctx.f.parse([H,
    row("5N1AT2MV4EC836473", "PC459 Liftgate stay; PC490 CVT reprogram", ["PC490"], "pd108, R21B9"),
    row("1N4AL3AP1FC286673", "R21A6 Hood latch", ["None"], ""),
    row("3N1AB7AP1KY233254", "PM971 Stop lamp switch", [], ""),
    row("5N1AR2MM3FC658711", "R24C6 Hood latch", ["maybe"], "")])));
  assert.deepEqual(r.rows, [
    { vin: "5N1AT2MV4EC836473", open: [{ c: "PC490", d: "CVT reprogram" }, { c: "PD108" }, { c: "R21B9" }], src: "Nissan" },
    { vin: "1N4AL3AP1FC286673", open: [], src: "Nissan" }]);
  assert.match(r.errors[0], /"maybe" isn't a campaign number/);
  assert.match(ctx.f.parse([["Name", "Phone"]]).errors[0], /isn't the cars-to-check spreadsheet/);
});
