// ═══════════════════════════════════════════════════════════════
// Abreys FieldPlan Relay v9.2 — Cloudflare Worker  (v9 = + Irrigation app routes; v9.1 = + /assets from the Checklist App asset list;
//   v9.2 (11/11/26) = irrigation saves keep every field-level setting the app sends (priority 'pr', Out of scab 'os', and any
//   added later), and the app's own address https://irrigation.abreys.app is allowed alongside matthewabrey.github.io)
// v2: editors must supply their save PIN. PINs live ONLY here
//     (in the EDITOR_PINS secret), never in the public app.
// v3: adds GET /omnia; v4 adds GET /report (Our Cropping CSV for Excel)
// v3 detail: GET /omnia — serves the Omnia daily CSV export to the
//     app. The SAS token lives ONLY here (OMNIA_SAS secret).
//     Solves CORS: the browser talks to this Worker, the Worker
//     talks to Omnia's Azure storage.
// Secrets required: GH_TOKEN, EDITOR_PINS, OMNIA_SAS, ONION_SECRET
// ═══════════════════════════════════════════════════════════════

const OWNER = 'matthewabrey';
const REPO = 'Abrey-Cropping';
// v9.2: sites allowed to call the relay from a browser (the first is the default)
const ALLOWED_ORIGINS = ['https://matthewabrey.github.io', 'https://irrigation.abreys.app'];
const ALLOWED_ORIGIN = ALLOWED_ORIGINS[0];
const OMNIA_BASE = 'https://omniabiusers.blob.core.windows.net/d4580fc1-e18b-4ce7-b81e-67900ef445de';
const OMNIA_FILES = ['Cropping.csv','Crops.csv','Fields.csv','HoldingYears.csv','Holdings.csv',
  'Operations.csv','Plans.csv','Records.csv','StockTransactions.csv','Stocks.csv','Users.csv','Varieties.csv'];

function parseCsv(t) {
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  const rows = []; let cur = [], fld = '', q = false, header = null;
  const endRow = () => {
    cur.push(fld); fld = '';
    if (cur.length > 1 || cur[0] !== '') {
      if (!header) header = cur;
      else { const o = {}; for (let j = 0; j < header.length; j++) o[header[j]] = cur[j] || ''; rows.push(o); }
    }
    cur = [];
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { fld += '"'; i++; } else q = false; } else fld += c; }
    else if (c === '"') q = true;
    else if (c === ',') { cur.push(fld); fld = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; endRow(); }
    else fld += c;
  }
  if (fld !== '' || cur.length) endRow();
  return rows;
}

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

// ═══════════════════════════════════════════════════════════════
// v9 (10/11/26): IRRIGATION APP routes — GET /irr-data, POST /irr-save
//   Sign-in is the employee number only. A save is accepted from anyone on the
//   Irrigation app's Team list or any FieldPlan admin/edit user; only supervisors,
//   managers and admins/editors may change irrigation settings.
//   irr_data.json lives on branch 'irrigation-data' (made automatically) so the
//   many small saves don't trigger Pages builds; irr_live.json (read by FieldPlan's
//   Water page) is written to main at most every 15 min, only when totals change.
//   Uses GH_TOKEN only. Nothing in here touches the FieldPlan save, /omnia, /report
//   or /onion-upload.
// ═══════════════════════════════════════════════════════════════
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

export default {
  async fetch(request, env) {
    // v9.2: answer with the caller's own site when it's one of ours (browsers accept only one site per reply)
    const reqOrigin = request.headers.get('Origin') || '';
    const CORS = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (obj, status) =>
      new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const gh = (url2, init = {}) =>
      fetch('https://api.github.com' + url2, {
        ...init,
        headers: {
          'Authorization': 'Bearer ' + env.GH_TOKEN,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'abrey-fieldplan-relay',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.headers || {}),
        },
      });

    // ── GET /onion-upload?secret=...&data=... — live onion tonnes from the Sales Planner (v6) ──
    const url0 = new URL(request.url);
    if (request.method === 'GET' && url0.pathname === '/onion-upload') {
      const secret = url0.searchParams.get('secret') || '';
      if (!env.ONION_SECRET || secret !== env.ONION_SECRET) return json({ error: 'Bad secret' }, 403);
      let data;
      try { data = JSON.parse(url0.searchParams.get('data') || ''); } catch (e) { return json({ error: 'Bad data' }, 400); }
      if (typeof data !== 'object' || Array.isArray(data)) return json({ error: 'Bad data shape' }, 400);
      // v6: accept either the old flat {type:tonnes} shape or {types:{...},fields:[[name,type,ha],...]}
      const src = (data.types && typeof data.types === 'object' && !Array.isArray(data.types)) ? data.types : data;
      const clean = {};
      Object.keys(src).slice(0, 40).forEach((k) => {
        const v = Number(src[k]);
        if (!isNaN(v)) clean[String(k).slice(0, 60)] = Math.round(v * 10) / 10;
      });
      let fields = null;
      if (Array.isArray(data.fields)) {
        fields = data.fields.slice(0, 150)
          .map((r) => Array.isArray(r) ? [String(r[0] || '').slice(0, 60), String(r[1] || '').slice(0, 30), Math.round((Number(r[2]) || 0) * 100) / 100] : null)
          .filter((r) => r && r[0]);
        if (!fields.length) fields = null;
      }
      const path = 'onion_live.json';
      const shaRes = await gh(`/repos/${OWNER}/${REPO}/contents/${path}?ref=main`);
      let sha = null, oldPayload = null;
      if (shaRes.ok) {
        const js = await shaRes.json();
        sha = js.sha;
        try {
          const prev = JSON.parse(atob((js.content || '').replace(/\n/g, '')));
          oldPayload = JSON.stringify({ t: prev.types, f: prev.fields || null });
        } catch (e) {}
      }
      if (oldPayload === JSON.stringify({ t: clean, f: fields }))
        return new Response('unchanged ' + new Date().toISOString(), { status: 200, headers: CORS });
      const body = JSON.stringify({ asOf: new Date().toISOString(), types: clean, ...(fields ? { fields } : {}) });
      const putRes = await gh(`/repos/${OWNER}/${REPO}/contents/${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Onion live tonnes update — from Sales Planner',
          content: btoa(body),
          ...(sha ? { sha } : {}),
          branch: 'main',
        }),
      });
      if (!putRes.ok) { const o = await putRes.json(); return json({ error: o.message || 'Commit failed' }, 502); }
      return new Response('updated ' + new Date().toISOString(), { status: 200, headers: CORS });
    }

    // ── GET /omnia?file=Cropping.csv&emp=1234 — Omnia data proxy (v3) ──
    const url = new URL(request.url);

    // ── Irrigation app (v9) ──
    if (url.pathname === '/irr-data' && request.method === 'GET') return irrData(request, env);
    if (url.pathname === '/irr-save' && request.method === 'POST') return irrSave(request, env);
    if (url.pathname === '/assets' && request.method === 'GET') return irrAssets(request, env);
    if (request.method === 'GET' && url.pathname === '/omnia') {
      const file = url.searchParams.get('file') || '';
      const emp = url.searchParams.get('emp') || '';
      if (!OMNIA_FILES.includes(file)) return json({ error: 'Unknown file' }, 400);
      if (!env.OMNIA_SAS) return json({ error: 'OMNIA_SAS secret not set' }, 500);
      const users = await loadUsers();
      if (!users) return json({ error: 'Could not load user list' }, 500);
      if (!users.find((u) => String(u.emp) === String(emp)))
        return json({ error: 'Employee number not recognised' }, 403);
      const blobUrl = `${OMNIA_BASE}/${file}?${env.OMNIA_SAS}`;
      // cache at the edge for an hour — Omnia refreshes daily ~4am
      const blobRes = await fetch(blobUrl, { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!blobRes.ok) return json({ error: 'Omnia fetch failed (' + blobRes.status + ')' }, 502);
      return new Response(blobRes.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Cache-Control': 'public, max-age=1800',
          ...CORS,
        },
      });
    }

    // ── GET /report?emp=1234[&year=2027] — Our Cropping sheet for Excel (v4) ──
    if (request.method === 'GET' && url.pathname === '/report') {
      const emp = url.searchParams.get('emp') || '';
      const year = url.searchParams.get('year') || '2027';
      if (!/^20\d\d$/.test(year)) return json({ error: 'Bad year' }, 400);
      if (!env.OMNIA_SAS) return json({ error: 'OMNIA_SAS secret not set' }, 500);
      const users = await loadUsers();
      if (!users) return json({ error: 'Could not load user list' }, 500);
      if (!users.find((u) => String(u.emp) === String(emp)))
        return json({ error: 'Employee number not recognised' }, 403);

      // serve from edge cache (compute at most hourly)
      const cacheKey = new Request('https://cache.local/report-v7?year=' + year, { method: 'GET' });
      const cache = caches.default;
      const hit = await cache.match(cacheKey);
      if (hit) return new Response(hit.body, { status: 200, headers: { ...Object.fromEntries(hit.headers), ...CORS } });

      const [fTxt, cTxt] = await Promise.all([
        fetch(`${OMNIA_BASE}/Fields.csv?${env.OMNIA_SAS}`, { cf: { cacheTtl: 3600, cacheEverything: true } }).then((r) => r.text()),
        fetch(`${OMNIA_BASE}/Cropping.csv?${env.OMNIA_SAS}`, { cf: { cacheTtl: 3600, cacheEverything: true } }).then((r) => r.text()),
      ]);
      const fields = parseCsv(fTxt).filter((r) => r.HoldingId === '15859');
      const fmap = {};
      fields.forEach((r) => { fmap[r.FieldId] = r; });
      const G2E = { 'Ingham Place Farms': 'Genevieve', Euston: 'Euston', Rymer: 'Euston', Wretham: 'Wretham', Chandler: 'Chandler',
        Pickenham: 'Pickenham', Edwardstone: 'Edwardstone', Rackham: 'Rackham Farms',
        'Manor Farm': 'Rackham Farms', 'Moorland Stud': 'Rackham Farms', 'Dolphin Farm': 'Rackham Farms',
        'Manor Farm - Roudham': 'Rackham Farms', 'Blakeney Park Farms': 'Blakeney',
        'Blakeney park Farms': 'Blakeney', Beard: 'Beard', Gooderham: 'Gooderham',
        WFP: 'Warren/David Hill', 'Field Barn Farm': 'Warren/David Hill' };
      const NONCROP = ['grass margin','amenity','uncropped','solar','pig','chicken','pheasant','game',
        'els/hls','mid tier','sfi','woodland','carbon','hedgerow','trees','other','cover crop',
        'stubble turnip','wild bird','grass'];
      const VEG = ['potato','carrot','parsnip','onion','shallot'];
      // fields whose rye is Abreys-farmed in 2027 (Euston Rye/Conventional Rye, Pickenham Rye A) — 2027 is locked
      const RYE_OURS = ['759187','759188','759189','759194','759211','759213','759223','759228','759238','759255','759270','759292','759304','759331'];
      function ours(group, fid, crop) {
        const est = G2E[group];
        if (!est) return false;
        const c = crop.toLowerCase();
        for (const n of NONCROP) if (c.includes(n)) return false;
        const isveg = VEG.some((v) => c.includes(v));
        if (est === 'Wretham' || est === 'Chandler' || est === 'Edwardstone') return true;
        if (c.includes('rye')) return RYE_OURS.includes(fid);
        if (est === 'Euston') {
          if (c.includes('maize') || c.includes('sugar beet') || c.includes('rllong') || c.includes('sunflower')) return false;
          return isveg || c.includes('wheat') || c.includes('barley');
        }
        if (est === 'Rackham Farms' || est === 'Beard') return c.includes('potato');
        if (est === 'Blakeney' || est === 'Gooderham' || est === 'Warren/David Hill' || est === 'Pickenham' || est === 'Genevieve') return isveg;
        return false;
      }
      const out = [['Estate','Area','Field','Area (ha)','Crop','Type','Variety']];
      parseCsv(cTxt).forEach((r) => {
        if (r.HoldingId !== '15859' || r.Year !== year) return;
        const f = fmap[r.FieldId];
        if (!f) return;
        if (!ours(f.FieldGroup, r.FieldId, r.CropName || '')) return;
        out.push([G2E[f.FieldGroup], f.FieldGroup, f.FieldName,
          (Math.round(parseFloat(r.Area || '0') * 100) / 100).toFixed(2), r.CropName,
          (r.CropDescr || '').trim(), r.VarietyName || '']);
      });
      const hdr = out.shift();
      out.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
      out.unshift(hdr);
      const csv = out.map((row) => row.map((v) => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(',')).join('\r\n');
      const res = new Response(csv, { status: 200, headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        ...CORS } });
      await cache.put(cacheKey, res.clone());
      return res;
    }

    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    let body;
    try { body = await request.json(); }
    catch (e) { return json({ error: 'Bad request body' }, 400); }

    const { emp, pin, message, content, path } = body;
    if (!emp || !content) return json({ error: 'Missing emp or content' }, 400);
    const filePath = path === 'FieldMap.html' ? 'FieldMap.html' : 'FieldPlan.html';

    // ── 1. Role check against the live user list ──
    const users = await loadUsers();
    if (!users) return json({ error: 'Could not load user list' }, 500);

    const user = users.find((u) => String(u.emp) === String(emp));
    if (!user) return json({ error: 'Employee number not recognised' }, 403);
    if (user.role !== 'admin' && user.role !== 'edit')
      return json({ error: 'Your account is view-only' }, 403);

    // ── 2. PIN check ──
    let pinMap = {};
    try { pinMap = JSON.parse(env.EDITOR_PINS || '{}'); } catch (e) {}
    const expected = pinMap[String(emp)];
    if (!expected) return json({ error: 'No save PIN set for this user — ask Matt', pin_required: true }, 401);
    if (String(pin || '') !== String(expected))
      return json({ error: 'Save PIN incorrect', pin_required: true }, 401);

    // ── 3. Commit on their behalf ──
    const commitMsg =
      (message || 'FieldPlan update') + ' — by ' + user.name + ' (' + user.emp + ')';

    async function attemptPush() {
      const shaRes = await gh(`/repos/${OWNER}/${REPO}/contents/${filePath}?ref=main`);
      const shaJson = await shaRes.json();
      if (!shaRes.ok) throw new Error(shaJson.message || 'SHA fetch failed');
      return gh(`/repos/${OWNER}/${REPO}/contents/${filePath}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: commitMsg, content, sha: shaJson.sha, branch: 'main',
        }),
      });
    }

    let putRes = await attemptPush();
    if (putRes.status === 409 || putRes.status === 422) putRes = await attemptPush();
    const out = await putRes.json();
    if (!putRes.ok) return json({ error: out.message || 'Push failed' }, putRes.status);

    return json({ ok: true, sha: out.content && out.content.sha, by: user.name });
  },
};
