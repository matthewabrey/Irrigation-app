// ═══════════════════════════════════════════════════════════════
// Abreys IRRIGATION RELAY v1.0 — Cloudflare Worker "irrigation-relay"  (23/11/26)
//   The Irrigation app's own relay, separate from fieldplan-relay so that changes made for
//   FieldPlan / the Spray List / other apps can never overwrite the irrigation routes, and
//   irrigation changes never touch theirs. ONLY the Irrigation app project edits this file.
//   Routes: GET /            → health check {ok, name, version, routes} (the app's early warning)
//           GET /irr-data    · POST /irr-save   (records, moves, settings — irr_data.json)
//           GET /irr-runs    · POST /irr-runs   (run maps from the Admin page — irr_runs.json)
//           GET /assets      (irrigators from the Checklist App asset list, if ASSET_LIST_URL is set)
//   Data: branch 'irrigation-data' of matthewabrey/Abrey-Cropping; irr_live.json (FieldPlan's Water page) on main.
//   Omnia data is still read from fieldplan-relay (/omnia) — read-only, nothing to change there.
//   Secrets: GH_TOKEN (GitHub fine-grained token, Contents read & write on Abrey-Cropping).
//   Optional: ASSET_LIST_URL, IRR_PINS.
// ═══════════════════════════════════════════════════════════════
const RELAY_NAME = 'irrigation-relay', RELAY_VERSION = '1.0';
const ROUTES = ['irr-data', 'irr-save', 'irr-runs', 'assets'];
const OWNER = 'matthewabrey', REPO = 'Abrey-Cropping';

async function loadUsers() {
  const rawRes = await fetch(
    `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/FieldPlan.html`,
    { cf: { cacheTtl: 300, cacheEverything: true } }
  );
  if (!rawRes.ok) return null;
  const raw = await rawRes.text();
  const m = raw.match(/var USERS=(\[[\s\S]*?\]);/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}


const IRR_REPO = 'matthewabrey/Abrey-Cropping';
const IRR_BRANCH = 'main';               // FieldPlan + irr_live.json
const IRR_DATA_BRANCH = 'irrigation-data'; // irr_data.json
const IRR_MIN_MM = 5;            // passes of 5mm or less never count
const IRR_M3_PER_ACIN = 102.79;
const IRR_MON = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const IRR_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function irrJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...IRR_CORS } });
}

// PIN check. If the worker already has its own PIN function (used by the FieldPlan save),
// call that instead and delete this one. This version accepts EDITOR_PINS as either
// {"1234":"5678",...} or [{"emp":"1234","pin":"5678"},...].
function irrPinIn(json, emp, pin) {
  try {
    const P = JSON.parse(json || '{}');
    if (Array.isArray(P)) return P.some(x => String(x.emp) === String(emp) && String(x.pin) === String(pin));
    return P[String(emp)] != null && String(P[String(emp)]) === String(pin);
  } catch (e) { return false; }
}
function irrCheckPin(env, emp, pin) { return !!pin && (irrPinIn(env.EDITOR_PINS, emp, pin) || irrPinIn(env.IRR_PINS, emp, pin)); }

// FieldPlan's USERS list — uses the relay's own loadUsers(), remembered for 10 min
let IRR_USERS = null, IRR_USERS_T = 0;
async function irrUsers() {
  if (IRR_USERS && Date.now() - IRR_USERS_T < 600000) return IRR_USERS;
  const u = await loadUsers();
  if (u) { IRR_USERS = u; IRR_USERS_T = Date.now(); }
  return IRR_USERS || [];
}
async function irrAllowed(env, data, emp, pin) {
  emp = String(emp || ''); if (!emp) return false;
  if (data && data.cfg && data.cfg.team && data.cfg.team[emp]) return true;
  try { const u = (await irrUsers()).find(x => String(x.emp) === emp); if (u && (u.role === 'admin' || u.role === 'edit')) return true; } catch (e) {}
  return irrCheckPin(env, emp, pin);   // old PIN route still accepted
}
// settings (machines, team, runs, warning days) — supervisors, managers and FieldPlan admins/editors only
async function irrCanConfigure(data, emp) {
  const t = data && data.cfg && data.cfg.team && data.cfg.team[String(emp)];
  if (t && (t.r === 'sup' || t.r === 'mgr')) return true;
  try { const u = (await irrUsers()).find(x => String(x.emp) === String(emp)); return !!(u && (u.role === 'admin' || u.role === 'edit')); } catch (e) { return false; }
}

async function irrGh(env, path, opt = {}) {
  return fetch('https://api.github.com/repos/' + IRR_REPO + path, {
    ...opt,
    headers: {
      'Authorization': 'Bearer ' + env.GH_TOKEN,
      'Accept': opt.accept || 'application/vnd.github+json',
      'User-Agent': 'fieldplan-relay',
      'Content-Type': 'application/json',
    },
  });
}
async function irrReadFile(env, path, branch) {
  const r = await irrGh(env, '/contents/' + path + '?ref=' + branch, { accept: 'application/vnd.github.raw' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub read ' + r.status);
  return JSON.parse(await r.text());
}
async function irrReadData(env) { return irrReadFile(env, 'irr_data.json', IRR_DATA_BRANCH); }
async function irrEnsureBranch(env) {
  const r = await irrGh(env, '/git/ref/heads/' + IRR_DATA_BRANCH);
  if (r.ok) return;
  const main = await (await irrGh(env, '/git/ref/heads/' + IRR_BRANCH)).json();
  await irrGh(env, '/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + IRR_DATA_BRANCH, sha: main.object.sha }) });
}
function irrEmpty(season) { return { v: 1, season, cfg: { gap: {}, add: {}, hide: {}, irrHa: {}, runs: {}, runLen: {}, mach: [], team: {} }, log: {}, ops: {} }; }

// FieldPlan Water-page contract: m³ for the current season by estate (spaces→_, Blakeney+Wretham combined) and month.
function irrLive(data) {
  const est = {}, mon = {}, fields = [];
  for (const [k, rec] of Object.entries(data.log || {})) {
    const ac = +rec.ac || 0, e = rec.e || '';
    if (!ac || !e) continue;
    for (const x of rec.p || []) {
      const ap = +x[2] || 0;
      if (ap <= IRR_MIN_MM) continue;
      const m3 = ap / 25.4 * ac * IRR_M3_PER_ACIN;
      est[e] = (est[e] || 0) + m3;
      const mo = IRR_MON[+String(x[0]).slice(5, 7)];
      if (mo) mon[mo] = (mon[mo] || 0) + m3;
      fields.push([k, x[0], +x[1] || 0, ap]);
    }
  }
  for (const k in est) est[k] = Math.round(est[k]);
  for (const k in mon) mon[k] = Math.round(mon[k]);
  return { asOf: new Date().toISOString(), season: data.season, est, mon, fields };
}

// Field-level merge so two people saving at once don't wipe each other:
// status/booking/area come from the saver; passes are a union by pass id minus the saver's deletions.
// v9.2: every other field-level setting the app sends is kept as sent (priority 'pr', Out of scab 'os',
// and anything added later) — v9.1 rebuilt the record from a fixed list and dropped them.
function irrMerge(data, body) {
  data.log = data.log || {};
  for (const [k, cli] of Object.entries(body.fields || {})) {
    const srv = data.log[k] || {};
    if (cli === null) { delete data.log[k]; continue; }
    if (typeof cli !== 'object' || Array.isArray(cli)) continue;
    const gone = new Set((body.del || {})[k] || []);
    const byId = new Map();
    for (const x of srv.p || []) if (!gone.has(x[4])) byId.set(x[4], x);
    for (const x of cli.p || []) if (!gone.has(x[4])) byId.set(x[4], x);
    const p = [...byId.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const rec = { ...cli, st: cli.st || 0, mm2: cli.mm2 || 0, g: cli.g || [], p, e: cli.e || srv.e, ac: cli.ac || srv.ac, n: cli.n || srv.n };
    if (!rec.mm2) delete rec.mm2;
    if (!rec.pr) delete rec.pr;     // priority: 'r' | 'o' | 'g'
    if (!rec.os) delete rec.os;     // Out of scab: 1
    data.log[k] = rec;
  }
  // operations (planned moves, machine starts): union by id, newest edit wins; deletions are tombstones (x:1)
  data.ops = data.ops || {};
  for (const [id, o] of Object.entries(body.ops || {})) {
    if (!o) continue;
    const cur = data.ops[id];
    if (!cur || (+o.u || 0) >= (+cur.u || 0)) data.ops[id] = o;
  }
  // keep the file small: drop tombstones and finished plans older than 3 days (passes stay in log for the season)
  const cutoff = Date.now() - 3 * 864e5;
  for (const [id, o] of Object.entries(data.ops)) if ((o.x || (o.t === 'plan' && o.done)) && (+o.u || 0) < cutoff) delete data.ops[id];
  if (body.cfg) data.cfg = body.cfg;
  return data;
}

async function irrCommit(env, files, message, branch = IRR_BRANCH) {
  const ref = await (await irrGh(env, '/git/ref/heads/' + branch)).json();
  const head = ref.object.sha;
  const commit = await (await irrGh(env, '/git/commits/' + head)).json();
  const tree = await (await irrGh(env, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: commit.tree.sha, tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) }),
  })).json();
  const nc = await (await irrGh(env, '/git/commits', {
    method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [head] }),
  })).json();
  const up = await irrGh(env, '/git/refs/heads/' + branch, { method: 'PATCH', body: JSON.stringify({ sha: nc.sha }) });
  return up.ok; // false = someone else committed in between → caller retries
}

// Every open screen polls this every ~20 s. To stay well inside GitHub's API limit the latest
// copy is held in the Cloudflare edge cache for 10 s (and replaced immediately on every save),
// and a caller that already has the latest version just gets {same:true}.
const IRR_CACHE_KEY = 'https://irr-cache.internal/irr_data.json';
async function irrCachedData(env) {
  const c = caches.default, hit = await c.match(IRR_CACHE_KEY);
  if (hit) return hit.json();
  const data = await irrReadData(env);
  await irrCachePut(data);
  return data;
}
async function irrCachePut(data) {
  try { await caches.default.put(IRR_CACHE_KEY, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=10' } })); } catch (e) {}
}
async function irrData(request, env) {
  const q = new URL(request.url).searchParams, emp = q.get('emp') || '', since = q.get('since') || '';
  if (!emp) return irrJson({ ok: false, error: 'emp required' }, 400);
  try {
    const data = await irrCachedData(env);
    if (since && data && data.updated === since) return irrJson({ ok: true, same: true });
    return irrJson({ ok: true, data: data || null });
  } catch (e) { return irrJson({ ok: false, error: String(e.message || e) }, 502); }
}

async function irrSave(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return irrJson({ ok: false, error: 'bad json' }, 400); }
  const season = String(body.season || '2027');
  let current = null;
  try { current = await irrReadData(env); } catch (e) {}
  if (!(await irrAllowed(env, current, body.emp, body.pin)))
    return irrJson({ ok: false, error: 'employee ' + body.emp + ' is not set up to record irrigation — ask Matthew to add you under Settings → Team' }, 403);
  if (body.cfg && !(await irrCanConfigure(current, body.emp))) body.cfg = null;   // staff can record, not change settings
  try { await irrEnsureBranch(env); } catch (e) {}
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      let data = (await irrReadData(env)) || irrEmpty(season);
      if (String(data.season) !== season) return irrJson({ ok: false, error: 'season mismatch: saved file is ' + data.season }, 409);
      data = irrMerge(data, body);
      data.updated = new Date().toISOString();
      data.by = String(body.emp);
      const live = irrLive(data);
      const n = Object.keys(body.fields || {}).length, no = Object.keys(body.ops || {}).length;
      const ok = await irrCommit(env, [{ path: 'irr_data.json', content: JSON.stringify(data) }],
        'Irrigation: ' + n + ' field' + (n === 1 ? '' : 's') + (no ? ', ' + no + ' moves' : '') + (body.cfg ? ' + settings' : '') + ' — by ' + body.emp, IRR_DATA_BRANCH);
      if (!ok) continue;
      await irrCachePut(data);
      // publish the FieldPlan contract on main only when it changed and the last copy is >15 min old
      try {
        const old = await irrReadFile(env, 'irr_live.json', IRR_BRANCH);
        const same = old && JSON.stringify(old.est) === JSON.stringify(live.est) && JSON.stringify(old.mon) === JSON.stringify(live.mon);
        const fresh = old && old.asOf && (Date.now() - Date.parse(old.asOf)) < 15 * 60000;
        if (!same && !fresh) await irrCommit(env, [{ path: 'irr_live.json', content: JSON.stringify(live) }], 'Irrigation: water used for FieldPlan', IRR_BRANCH);
      } catch (e) {}
      return irrJson({ ok: true, data, live });
    } catch (e) {
      if (attempt === 2) return irrJson({ ok: false, error: String(e.message || e) }, 502);
    }
  }
  return irrJson({ ok: false, error: 'busy — please press Save again' }, 409);
}


// Minimal .xlsx reader (no libraries): unzips with the built-in DecompressionStream and
// returns one sheet as an array of row arrays (strings/numbers). Works in browsers and
// Cloudflare Workers. Used for the Checklist App's AssetList.xlsx.
async function xlsxSheetRows(buf, sheetName) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not an xlsx file');
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true); const files = {};
  for (let k = 0; k < n; k++) {
    const meth = dv.getUint16(p + 10, true), csz = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true),
      xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
    files[name] = { meth, csz, lho }; p += 46 + nl + xl + cl;
  }
  async function read(name) {
    const f = files[name]; if (!f) return null;
    const o = f.lho + 30 + dv.getUint16(f.lho + 26, true) + dv.getUint16(f.lho + 28, true);
    const raw = u8.subarray(o, o + f.csz);
    if (f.meth === 0) return new TextDecoder().decode(raw);
    const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new TextDecoder().decode(await new Response(s).arrayBuffer());
  }
  const unx = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
  const wb = await read('xl/workbook.xml'), rels = await read('xl/_rels/workbook.xml.rels');
  let rid = null;
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const nm = /name="([^"]*)"/.exec(m[0]), id = /r:id="([^"]*)"/.exec(m[0]);
    if (nm && unx(nm[1]).trim() === sheetName.trim()) rid = id && id[1];
  }
  if (!rid) throw new Error('sheet "' + sheetName + '" not found');
  let target = null;
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) if (m[0].indexOf('Id="' + rid + '"') >= 0) target = /Target="([^"]*)"/.exec(m[0])[1];
  const path = target.replace(/^\//, '').replace(/^(?!xl\/)/, 'xl/');
  const ssx = await read('xl/sharedStrings.xml'), ss = [];
  if (ssx) for (const m of ssx.matchAll(/<si>([\s\S]*?)<\/si>/g)) ss.push(unx([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  const sx = await read(path), rows = [];
  const col = ref => { let c = 0; for (const ch of ref.replace(/\d+/g, '')) c = c * 26 + ch.charCodeAt(0) - 64; return c - 1; };
  for (const rm of sx.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const at = cm[1], r = /r="([A-Z]+\d+)"/.exec(at), t = /t="([^"]*)"/.exec(at), body = cm[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body), is = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
      let val = null;
      if (t && t[1] === 's' && v) val = ss[+v[1]];
      else if (t && t[1] === 'inlineStr' && is) val = unx(is[1]);
      else if (v) val = (t && (t[1] === 'str' || t[1] === 'e')) ? unx(v[1]) : (isNaN(+v[1]) ? unx(v[1]) : +v[1]);
      row[r ? col(r[1]) : row.length] = val;
    }
    rows.push(row);
  }
  return rows;
}
// Irrigators from the Checklist App's AssetList.xlsx ("Front Sheet": Check Type, NameColumn, MakeColumn, Crop, Year)
// NameColumn looks like "B1 A F Machinery 11920207 R64" or "P13 Pickenham E330047 / VR7 600".
function assetIrrigators(rows) {
  const out = [], seen = {};
  const head = (rows[0] || []).map(x => String(x || '').trim().toLowerCase());
  const iT = Math.max(0, head.indexOf('check type')), iN = head.indexOf('namecolumn') >= 0 ? head.indexOf('namecolumn') : 1,
    iM = head.indexOf('makecolumn') >= 0 ? head.indexOf('makecolumn') : 2;
  for (const r of rows.slice(1)) {
    if (!/irrigat/i.test(String(r[iT] || ''))) continue;
    const full = String(r[iN] || '').replace(/\s+/g, ' ').trim(); if (!full) continue;
    const m = /^(\S+)\s+(A F Machinery|Pickenham|Non Existant|[A-Za-z ]+?)\s+(.*)$/i.exec(full);
    const fleet = m ? m[1] : full.split(' ')[0], owner = m ? m[2] : '', rest = m ? m[3].trim() : '';
    if (/non exist/i.test(owner) || seen[fleet]) continue;
    seen[fleet] = 1;
    let serial = rest, model = '';
    if (rest.indexOf(' / ') >= 0) { serial = rest.split(' / ')[0].trim(); model = rest.split(' / ').slice(1).join(' / ').trim(); }
    else { const t = rest.split(' '); model = t.length > 1 ? t.pop() : ''; serial = t.join(' '); }
    const make = String(r[iM] || '').trim();
    out.push({ id: fleet, name: fleet + ' ' + (make ? make + ' ' : '') + model, make, model, serial: serial === 'n/a' ? '' : serial,
      owner, est: /pickenham/i.test(owner) ? 'Pickenham' : '' });
  }
  const key = s => { const m = /^([A-Z]*)(\d*)/i.exec(s); return [m[1].toUpperCase(), +(m[2] || 0)]; };
  out.sort((a, b) => { const x = key(a.id), y = key(b.id); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]; });
  return out;
}

// ── GET /assets?emp=1234 — irrigators from the Checklist App's AssetList.xlsx (v9.1) ──
// Set the relay secret/variable ASSET_LIST_URL to a view-only share link for the file
// (OneDrive/SharePoint: Share → "Anyone with the link can view" → Copy link). Read at most hourly.
async function irrAssets(request, env) {
  const q = new URL(request.url).searchParams, emp = q.get('emp') || '';
  const users = await irrUsers();
  if (!users.find(u => String(u.emp) === String(emp))) return irrJson({ ok: false, error: 'Employee number not recognised' }, 403);
  if (!env.ASSET_LIST_URL) return irrJson({ ok: false, error: 'ASSET_LIST_URL not set on the relay' }, 404);
  const key = 'https://irr-cache.internal/assets.json';
  if (!q.get('fresh')) { const hit = await caches.default.match(key); if (hit) return irrJson(await hit.json()); }
  let link = env.ASSET_LIST_URL.trim();
  if (/sharepoint\.com|1drv\.ms|onedrive/i.test(link) && !/download=1/.test(link)) link += (link.includes('?') ? '&' : '?') + 'download=1';
  const r = await fetch(link, { redirect: 'follow' });
  if (!r.ok) return irrJson({ ok: false, error: 'asset list fetch failed (' + r.status + ')' }, 502);
  try {
    const list = assetIrrigators(await xlsxSheetRows(await r.arrayBuffer(), 'Front Sheet'));
    if (!list.length) throw new Error('no Irrigator rows found');
    const out = { ok: true, t: new Date().toISOString(), list };
    await caches.default.put(key, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' } }));
    return irrJson(out);
  } catch (e) {
    return irrJson({ ok: false, error: 'could not read the asset list: ' + e.message + ' — the link must download the .xlsx itself' }, 502);
  }
}

// ── v9.5 (23/11/26): IRRIGATION RUN MAPS — GET /irr-runs?emp=… (anyone signed in) · POST /irr-runs {emp, data} (supervisors/managers/admins) ──
// irr_runs.json sits next to irr_data.json on the 'irrigation-data' branch; the latest copy is held at the edge for 60 s.
const IRR_RUNS_KEY = 'https://irr-cache.internal/irr_runs.json';
async function irrRunsGet(request, env) {
  const emp = new URL(request.url).searchParams.get('emp') || '';
  if (!emp) return irrJson({ ok: false, error: 'emp required' }, 400);
  try {
    const hit = await caches.default.match(IRR_RUNS_KEY);
    if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', ...IRR_CORS } });
    const data = await irrReadFile(env, 'irr_runs.json', IRR_DATA_BRANCH);
    const body = JSON.stringify({ ok: true, data: data || null });
    await caches.default.put(IRR_RUNS_KEY, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } }));
    return new Response(body, { headers: { 'Content-Type': 'application/json', ...IRR_CORS } });
  } catch (e) { return irrJson({ ok: false, error: String(e.message || e) }, 502); }
}
async function irrRunsSave(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return irrJson({ ok: false, error: 'bad json' }, 400); }
  if (!body || !body.data || typeof body.data.fields !== 'object') return irrJson({ ok: false, error: 'no run map in the upload' }, 400);
  let current = null;
  try { current = await irrReadData(env); } catch (e) {}
  if (!(await irrCanConfigure(current, body.emp)))
    return irrJson({ ok: false, error: 'only supervisors, managers and FieldPlan admins can publish run maps' }, 403);
  const data = body.data;
  data.t = new Date().toISOString(); data.by = String(body.emp);
  try { await irrEnsureBranch(env); } catch (e) {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ok = await irrCommit(env, [{ path: 'irr_runs.json', content: JSON.stringify(data) }],
        'Irrigation run maps: ' + Object.keys(data.fields).length + ' fields' + (data.src ? ' from ' + String(data.src).slice(0, 80) : '') + ' — by ' + body.emp, IRR_DATA_BRANCH);
      if (!ok) continue;
      const out = JSON.stringify({ ok: true, data });
      try { await caches.default.put(IRR_RUNS_KEY, new Response(out, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } })); } catch (e) {}
      return irrJson({ ok: true, t: data.t, fields: Object.keys(data.fields).length });
    } catch (e) { if (attempt === 2) return irrJson({ ok: false, error: String(e.message || e) }, 502); }
  }
  return irrJson({ ok: false, error: 'busy — please press Publish again' }, 409);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), m = request.method;
    if (m === 'OPTIONS') return new Response(null, { headers: IRR_CORS });
    if (url.pathname === '/' && m === 'GET')
      return irrJson({ ok: true, name: RELAY_NAME, version: RELAY_VERSION, routes: ROUTES, token: !!env.GH_TOKEN });
    if (!env.GH_TOKEN) return irrJson({ ok: false, error: 'GH_TOKEN secret not set on irrigation-relay' }, 500);
    if (url.pathname === '/irr-data' && m === 'GET') return irrData(request, env);
    if (url.pathname === '/irr-save' && m === 'POST') return irrSave(request, env);
    if (url.pathname === '/irr-runs' && m === 'GET') return irrRunsGet(request, env);
    if (url.pathname === '/irr-runs' && m === 'POST') return irrRunsSave(request, env);
    if (url.pathname === '/assets' && m === 'GET') return irrAssets(request, env);
    return irrJson({ ok: false, error: 'no such route' }, 404);
  },
};
