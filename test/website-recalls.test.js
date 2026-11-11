// Run: node --test
// Checks the website's Netlify Function (website/netlify/functions/nissan-recalls.mjs) with stand-ins for Firestore and Nissan.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const load = () => import(path.join(__dirname, "..", "website", "netlify", "functions", "nissan-recalls.mjs"));

const PAGE = '<div data-json-url="/content/x/vinrecalllookup_ab12.recallinfo.json">';
const NONE = JSON.stringify({ status_code: "Recalls Not Found Error", status_message: '{"success":false,"code":404,"message":"No data found for request"}' });
const OPEN = (vin) => JSON.stringify({ recalls: [
  { vin, typeCode: "Safety Recall", secondaryDescription: "Hood Latch", effectiveDate: "2020-06-01", govtRecallId: "20V-315", nissanRecallId: "PC735" },
  { vin, secondaryDescription: "Hood Latch", govtRecallId: "20V-315", nissanRecallId: "PC735" },
  { vin, secondaryDescription: "No Nissan number", govtRecallId: "24V-798" },
] });
const VIN_A = "5N1BT3BB2PC836400", VIN_B = "3N1AB8CV5MY123456";

// A fake ID token: header.payload.signature, where only the payload matters to the function.
const token = (claims) => "x." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".sig";
const resp = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const teamDoc = (fields) => ({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "boolean" ? { booleanValue: v } : { stringValue: v }])) });

function fakeFetch({ team = teamDoc({ active: true, role: "member" }), teamStatus = 200, nissan } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.includes("firestore.googleapis.com")) return resp(teamStatus, team);
    if (url.endsWith("recalls-vin.html")) return resp(200, PAGE);
    const vin = JSON.parse(new URLSearchParams(opts.body).get("vinNums"))[0];
    return resp(...nissan(vin, url));
  };
  return { fn, calls };
}
const req = (body, auth) => new Request("https://site/.netlify/functions/nissan-recalls", {
  method: "POST", headers: auth ? { Authorization: "Bearer " + auth } : {}, body: JSON.stringify(body),
});

test("reads Nissan's answers into the CRM's campaign format", async () => {
  const f = await load();
  const a = f.parseRecallAnswer(200, OPEN(VIN_A), VIN_A);
  assert.equal(a.ok, true);
  assert.deepEqual(a.open, [
    { c: "PC735", n: "20V-315", d: "Hood Latch", a: "2020-06-01" },
    { c: "24V798", n: "24V-798", d: "No Nissan number" },
  ], "same campaign counts once; NHTSA number used when Nissan gives none");
  assert.deepEqual(f.parseRecallAnswer(404, NONE, VIN_A).open, []);
  assert.equal(f.parseRecallAnswer(404, NONE, VIN_A).ok, true);
  assert.equal(f.parseRecallAnswer(404, "<html>gone</html>", VIN_A).ok, false, "a plain 404 page is not 'no recalls'");
  assert.equal(f.parseRecallAnswer(429, "", VIN_A).blocked, true);
  assert.equal(f.parseRecallAnswer(200, OPEN("OTHERVIN"), VIN_A).open.length, 0, "ignores another car's recalls");
});

test("only takes the lookup address from Nissan's own site", async () => {
  const f = await load();
  assert.equal(f.recallUrlFromPage(PAGE), "https://www.nissanusa.com/content/x/vinrecalllookup_ab12.recallinfo.json");
  assert.equal(f.recallUrlFromPage('data-json-url="//evil.example/x.recallinfo.json"'), "");
  assert.equal(f.recallUrlFromPage('data-json-url="https://evil.example/x.recallinfo.json"'), "");
});

test("only active team members can use it", async () => {
  const f = await load();
  const nissan = () => [404, NONE];
  const good = token({ email: "Tech@Example.com", email_verified: true });
  let r = await f.handle(req({ vins: [VIN_A] }), fakeFetch({ nissan }).fn);
  assert.equal(r.status, 401, "no token");
  r = await f.handle(req({ vins: [VIN_A] }, good), fakeFetch({ nissan, teamStatus: 401 }).fn);
  assert.equal(r.status, 401, "token Firestore rejects");
  r = await f.handle(req({ vins: [VIN_A] }, good), fakeFetch({ nissan, teamStatus: 404 }).fn);
  assert.equal(r.status, 403, "not on the team");
  r = await f.handle(req({ vins: [VIN_A] }, good), fakeFetch({ nissan, team: teamDoc({ active: false }) }).fn);
  assert.equal(r.status, 403, "inactive");
  r = await f.handle(req({ vins: [VIN_A] }, good), fakeFetch({ nissan, team: teamDoc({ active: true, role: "scanner" }) }).fn);
  assert.equal(r.status, 403, "the scanner robot");
  r = await f.handle(req({ vins: [VIN_A] }, token({ email: "t@example.com", email_verified: false })), fakeFetch({ nissan, team: teamDoc({ active: true, requireVerify: true }) }).fn);
  assert.equal(r.status, 403, "unverified email when required");

  const ff = fakeFetch({ nissan });
  r = await f.handle(req({ vins: [VIN_A] }, good), ff.fn);
  assert.equal(r.status, 200);
  const teamCall = ff.calls.find((c) => c.url.includes("firestore"));
  assert.match(teamCall.url, /\/team\/tech%40example\.com$/, "looks up the lowercased email");
  assert.equal(teamCall.opts.headers.Authorization, "Bearer " + good, "passes the caller's own token to Firestore");
});

test("checks each VIN and reports the ones Nissan didn't answer", async () => {
  const f = await load();
  const auth = token({ email: "tech@example.com", email_verified: true });
  const ff = fakeFetch({ nissan: (vin) => (vin === VIN_A ? [200, OPEN(vin)] : [500, ""]) });
  const r = await f.handle(req({ vins: [VIN_A.toLowerCase(), VIN_B, "NOT-A-VIN"] }, auth), ff.fn);
  const { results } = await r.json();
  assert.equal(results.length, 2, "bad VINs are dropped, lowercase is accepted");
  assert.equal(results[0].vin, VIN_A); assert.equal(results[0].ok, true); assert.equal(results[0].open[0].c, "PC735");
  assert.equal(results[1].vin, VIN_B); assert.equal(results[1].ok, false);

  let bad = await f.handle(req({ vins: [] }, auth), ff.fn);
  assert.equal(bad.status, 400);
  bad = await f.handle(req({ vins: [VIN_A, VIN_B, "1N4AL3AP8JC231503", "JN8AT2MV9HW000000", "5N1AT2MV0HC000001"] }, auth), ff.fn);
  assert.equal(bad.status, 400, "more than 4 VINs");
});

test("asks one VIN at a time, explains failures, and stays inside the time limit", async () => {
  const f = await load();
  assert.equal(f.failWhy(0, ""), "no answer");
  assert.equal(f.failWhy(200, "<html><title>Access Denied</title>Reference #18.abc"), "bot check page");
  assert.equal(f.failWhy(200, "<!DOCTYPE html><p>Owners</p>"), "web page instead of data");
  assert.equal(f.failWhy(502, ""), "Nissan server error");
  assert.equal(f.parseRecallAnswer(200, "<html>", VIN_A).why, "web page instead of data");

  let inFlight = 0, most = 0;
  const slowFetch = async (url, opts = {}) => {
    if (url.endsWith("recalls-vin.html")) return resp(200, PAGE);
    inFlight++; most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return resp(404, NONE);
  };
  const r = await f.checkVins([VIN_A, VIN_B], slowFetch);
  assert.equal(most, 1, "never two lookups at once");
  assert.ok(r.every((x) => x.ok));

  const late = await f.checkVins([VIN_A, VIN_B], slowFetch, Date.now() - 7000);
  assert.ok(late.every((x) => !x.ok && x.why === "out of time"), "doesn't start a lookup it can't finish in time");
});
