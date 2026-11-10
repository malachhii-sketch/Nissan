// Run: node --test
// Loads the Apps Script scanner with stand-ins for Google's services and Firebase, and checks the recall-by-VIN step.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PAGE = '<div class="c_021-0B light" data-json-url="/content/x/vinrecalllookup_ab12.recallinfo.json">';
const NONE = JSON.stringify({ status_code: "Recalls Not Found Error", status_message: '{"success":false,"code":404,"message":"No data found for request"}' });
const open = (vin) => JSON.stringify({ recalls: [
  { vin, typeCode: "Safety Recall", modelYear: "2015", brand: "NISSAN", modelName: "ALTIMA", secondaryDescription: "Hood Latch", effectiveDate: "2020-06-01",
    govtRecallId: "20V-315", nissanRecallId: "PC735", primaryDescription: "The hood may open.", riskIfNotRepaired: "Crash risk.", remedyDescription: "Replace the latch." },
  { vin, secondaryDescription: "Hood Latch", govtRecallId: "20V-315", nissanRecallId: "PC735" },
] });

function load(answerFor) {
  const props = {}, db = {}, calls = [], commits = [];
  const resp = (code, text) => ({ getResponseCode: () => code, getContentText: () => text });
  const ctx = {
    console, JSON, Date, Math, Object, Array, String, Number, RegExp, Error, encodeURIComponent,
    Logger: { log() {} },
    Utilities: { sleep() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
    UrlFetchApp: {
      fetch: (url) => { calls.push(url); return resp(200, PAGE); },
      fetchAll: (reqs) => reqs.map((q) => { calls.push(q.url); const vin = JSON.parse(q.payload.vinNums)[0]; return resp(...answerFor(vin, q.url)); }),
    },
  };
  vm.createContext(ctx);
  let src = fs.readFileSync(path.join(__dirname, "..", "lot-scanner-code.txt"), "utf8");
  src += "\nfsList_ = function (c) { return __db.list(c); }; fsGet_ = function (p) { return __db.get(p); }; fsCommit_ = function (w) { __db.commit(w); }; this.CONFIG = CONFIG;";
  ctx.__db = {
    list: () => JSON.parse(JSON.stringify(Object.keys(db).filter((k) => k.startsWith("lots/")).map((k) => Object.assign({ id: k.slice(5) }, db[k])))),
    get: (p) => (db[p] ? JSON.parse(JSON.stringify(db[p])) : null),
    commit: (w) => { commits.push(w); w.forEach((x) => { const d = JSON.parse(JSON.stringify(x.data)); delete d.id; db[x.path] = d; }); },
  };
  vm.runInContext(src, ctx);
  return { ctx, db, calls, commits, props };
}

test("reads Nissan's answers: open recalls, none, and couldn't check", () => {
  const { ctx } = load(() => [200, "{}"]);
  const a = ctx.parseRecallAnswer(200, open("1N4AL3AP5DC123456"), "1N4AL3AP5DC123456");
  assert.equal(a.ok, true);
  assert.equal(a.recalls.length, 1, "the same campaign listed twice counts once");
  assert.equal(a.recalls[0].n, "20V-315");
  assert.equal(a.recalls[0].c, "PC735");
  assert.equal(a.recalls[0].m, "Replace the latch.");
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.parseRecallAnswer(404, NONE, "X"))), { ok: true, code: 404, recalls: [] });
  assert.equal(ctx.parseRecallAnswer(404, "<html>Not found</html>", "X").ok, false, "a plain 404 page is not 'no recalls'");
  assert.equal(ctx.parseRecallAnswer(500, "", "X").ok, false);
  assert.equal(ctx.parseRecallAnswer(200, "<html>", "X").ok, false);
  assert.equal(ctx.parseRecallAnswer(403, "", "X").blocked, true);
  assert.equal(ctx.parseRecallAnswer(200, open("OTHERVIN"), "1N4AL3AP5DC123456").recalls.length, 0, "ignores another car's recalls");
});

test("finds the lookup address in Nissan's page, and only on Nissan's site", () => {
  const { ctx } = load(() => [200, "{}"]);
  assert.equal(ctx.recallUrlFromPage(PAGE), "https://www.nissanusa.com/content/x/vinrecalllookup_ab12.recallinfo.json");
  assert.equal(ctx.recallUrlFromPage('data-json-url="https://evil.example/x.recallinfo.json"'), "");
  assert.equal(ctx.recallUrlFromPage('data-json-url="//evil.example/x.recallinfo.json"'), "");
  assert.equal(ctx.recallUrlFromPage("<html></html>"), "");
});

test("picks never-checked cars first, then the oldest checks, and skips recent ones", () => {
  const { ctx } = load(() => [200, "{}"]);
  const now = Date.parse("2026-11-10T00:00:00Z"), ago = (d) => new Date(now - d * 864e5).toISOString();
  const lots = [{ cars: [{ v: "RECENT", rt: ago(1), rc: [] }, { v: "OLD", rt: ago(20), rc: [{ n: "1" }] }, { v: "NEW" }] }, { cars: [{ v: "OLDER", rt: ago(30), rc: [] }, { v: "NEW" }] }];
  const p = ctx.pickRecallChecks(lots, now, 7, 10);
  assert.deepEqual([...p.vins], ["NEW", "OLDER", "OLD"]);
  assert.equal(p.cars, 5); assert.equal(p.checked, 3); assert.equal(p.open, 1); assert.equal(p.waiting, 2);
  assert.deepEqual([...ctx.pickRecallChecks(lots, now, 7, 1).vins], ["NEW"]);
});

test("a run saves each car's exact open recalls, and leaves unanswered cars unchecked", () => {
  const s = load((vin) => (vin === "VIN_OPEN" ? [200, open(vin)] : vin === "VIN_FAIL" ? [500, ""] : [404, NONE]));
  s.db["lots/d1"] = { dealer: "d1", cars: [{ v: "VIN_OPEN", y: 2015, md: "Altima" }, { v: "VIN_CLEAR" }], gone: [] };
  s.db["lots/d2"] = { dealer: "d2", cars: [{ v: "VIN_FAIL" }, { v: "VIN_OPEN" }], gone: [] };
  const status = {};
  s.ctx.checkRecalls_(status, Date.now() + 60000);
  const [a, b] = s.db["lots/d1"].cars;
  assert.deepEqual(a.rc, [{ n: "20V-315", c: "PC735", t: "Hood Latch", d: "2020-06-01", ty: "Safety Recall" }]);
  assert.equal(a.md, "Altima", "keeps what was already on the car");
  assert.deepEqual(b.rc, []); assert.ok(b.rt);
  assert.equal(s.db["lots/d2"].cars[0].rt, undefined, "a failed lookup is not recorded as 'no recalls'");
  assert.equal(s.db["lots/d2"].cars[1].rc.length, 1, "the same VIN on two lots is filled in on both");
  assert.equal(s.db["scanner/recalls"].PC735.m, "Replace the latch.");
  assert.equal(s.calls.filter((u) => /recallinfo/.test(u)).length, 3, "one lookup per VIN");
  assert.equal(status.recalls.ran, 2); assert.equal(status.recalls.failed, 1);
  assert.equal(status.recalls.open, 2); assert.equal(status.recalls.waiting, 1);

  // Next run: only the car that failed is asked about again.
  s.calls.length = 0;
  s.ctx.checkRecalls_(status, Date.now() + 60000);
  assert.equal(s.calls.filter((u) => /recallinfo/.test(u)).length, 1);
});

test("stops and waits when Nissan's site turns the scanner away", () => {
  const s = load(() => [403, "Access Denied"]);
  s.db["lots/d1"] = { cars: Array.from({ length: 20 }, (_, i) => ({ v: "VIN" + i })) };
  const status = {};
  s.ctx.checkRecalls_(status, Date.now() + 60000);
  assert.equal(s.calls.filter((u) => /recallinfo/.test(u)).length, 4, "stops after the first group");
  assert.ok(Date.parse(status.recalls.pausedUntil) > Date.now());
  assert.equal(s.commits.length, 0);
  s.calls.length = 0;
  s.ctx.checkRecalls_(status, Date.now() + 60000);
  assert.equal(s.calls.length, 0, "stays away until the pause is over");
});

test("reads the lookup address again if Nissan moved it", () => {
  const s = load((vin, url) => (/ab12/.test(url) ? [404, NONE] : [404, "<html>gone</html>"]));
  s.db["lots/d1"] = { cars: [{ v: "VIN1" }] };
  const status = {};
  s.props.recallUrl = JSON.stringify({ u: "https://www.nissanusa.com/old.recallinfo.json", t: new Date().toISOString() });
  s.ctx.checkRecalls_(status, Date.now() + 60000);
  assert.deepEqual(s.db["lots/d1"].cars[0].rc, []);
  assert.match(JSON.parse(s.props.recallUrl).u, /ab12/);
});

test("the template reads the same answers", () => {
  const t = require("../recall-scan-template.js");
  const a = t.parseRecallAnswer(200, open("1N4AL3AP5DC123456"), "1N4AL3AP5DC123456");
  assert.equal(a.checked, true); assert.equal(a.recalls.length, 1); assert.equal(a.recalls[0].nhtsaId, "20V-315"); assert.equal(a.recalls[0].remedy, "Replace the latch.");
  assert.deepEqual(t.parseRecallAnswer(404, NONE, "X"), { checked: true, recalls: [] });
  assert.equal(t.parseRecallAnswer(503, "", "X").checked, false);
  assert.equal(t.recallUrlFromPage(PAGE), "https://www.nissanusa.com/content/x/vinrecalllookup_ab12.recallinfo.json");
});
