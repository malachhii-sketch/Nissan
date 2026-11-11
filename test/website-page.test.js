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
  assert.deepEqual(s.posts.map(p => p.length), [4, 1]);
  const saved = Object.fromEntries(s.writes.map(([c, id, d]) => [id, d]));
  assert.deepEqual(Object.keys(saved).sort(), [V(0), V(1), V(2), V(4)]);
  assert.equal(saved[V(0)].open[0].c, "PC735"); assert.equal(saved[V(0)].src, "Nissan.com"); assert.equal(saved[V(0)].updatedByName, "Pat");
  assert.equal(saved[V(4)].removed, false, "keeps a by-hand 'put back'");
  assert.match(s.els["vin-auto-out"].innerHTML, /Saved 4 VIN checks: <b>1<\/b> with open campaigns, 3 with none.*1 car couldn't be checked/);
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
