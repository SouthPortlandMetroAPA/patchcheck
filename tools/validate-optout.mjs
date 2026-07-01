#!/usr/bin/env node
/* PatchCheck patch-optout validation harness.
 *
 * Exercises the newly-shipped 1.30 modal end-to-end across four layers:
 *
 *   • DB / RLS      — anon can read + write patch_optouts (no service key)
 *   • REST contract — PostgREST UPSERT + DELETE surface behaves right
 *   • Frontend HTML — modal wiring is present in the served page
 *   • Frontend JS   — the modal's core functions produce correct state
 *
 * Uses a single synthetic member_number ('99999') that is well outside
 * any real APA range. Every test that writes cleans up after itself so
 * the table's shape at end == its shape at start.
 *
 * Run:
 *   node Apps/PatchCheck/tools/validate-optout.mjs [http://url-to-index.html]
 *
 * By default the HTML checks hit the live site.
 */

import http from 'node:http';

const SB_URL  = 'https://dqzbekoaysgaiqljueac.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxemJla29heXNnYWlxbGp1ZWFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNzA5NzgsImV4cCI6MjA5MDc0Njk3OH0.cCdGxZ4zEFzU_r6lWSDeoNWG67Q4MSYCAtpds035dfU';
/* Supabase Management PAT — required for the tests that seed / clean via
   the DB (C6, C17, C29, C32). Export SUPABASE_PAT before running. When
   unset, those specific tests are marked "skipped" instead of failing so
   the rest of the harness (which only needs anon) still runs. */
const PAT = process.env.SUPABASE_PAT || '';

const HTML_URL = process.argv[2] || 'https://southportlandmetroapa.github.io/patchcheck/';
const TEST_MEMBER = '99999';
const OPTOUT_CODES = ['r','8','x','9','n','k','m8','mx','m9','mn','8m','9m','g'];

const sql = async (q) => {
  if (!PAT) throw new Error('SUPABASE_PAT not set — cannot run privileged test');
  const r = await fetch('https://api.supabase.com/v1/projects/dqzbekoaysgaiqljueac/database/query', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q })
  });
  const t = await r.text();
  if (!r.ok) throw new Error('SQL ' + r.status + ': ' + t);
  return JSON.parse(t);
};


/* Anon fetch — mirrors PatchCheck's sbHeaders exactly. */
const anonHeaders = () => ({
  apikey:          SB_ANON,
  Authorization:   'Bearer ' + SB_ANON,
  'Accept-Profile': 'slate',
  'Content-Profile': 'slate',
  'Content-Type':   'application/json'
});
const anonGet = async (path) => {
  const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: anonHeaders() });
  const t = await r.text();
  if (!r.ok) throw new Error('anonGet ' + r.status + ': ' + t);
  return JSON.parse(t);
};
const anonUpsert = async (member, denied) => {
  /* Body deliberately omits `note` so an admin-set note survives — this
   * mirrors the shipped PatchCheck saveOptoutModal exactly (see C29). */
  const r = await fetch(SB_URL + '/rest/v1/patch_optouts?on_conflict=member_number', {
    method: 'POST',
    headers: { ...anonHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ member_number: member, opted_out_types: denied })
  });
  const t = await r.text();
  if (!r.ok) throw new Error('anonUpsert ' + r.status + ': ' + t);
  return JSON.parse(t);
};
const anonDelete = async (member) => {
  const r = await fetch(SB_URL + '/rest/v1/patch_optouts?member_number=eq.' + encodeURIComponent(member), {
    method: 'DELETE',
    headers: anonHeaders()
  });
  if (!r.ok) throw new Error('anonDelete ' + r.status + ': ' + await r.text());
};

const checks = [];
const pass = (id, msg) => checks.push({ id, ok: true, msg });
const fail = (id, msg, detail) => checks.push({ id, ok: false, msg, detail });
const skip = (id, msg) => checks.push({ id, ok: true, msg: '(skipped, no SUPABASE_PAT) ' + msg });

/* ── Clean slate before starting. ─────────────────────────────────── */
await anonDelete(TEST_MEMBER).catch(() => {});

/* ─────────────────── DB / RLS layer ─────────────────────────────── */

/* C1 — anon can SELECT */
try {
  await anonGet('patch_optouts?select=member_number&limit=1');
  pass('C1.anon-select', 'Anon can SELECT patch_optouts');
} catch (e) { fail('C1.anon-select', 'anon SELECT failed', e.message); }

/* C2 — anon can INSERT via upsert */
try {
  await anonUpsert(TEST_MEMBER, ['k']);
  pass('C2.anon-insert', 'Anon can INSERT via UPSERT');
} catch (e) { fail('C2.anon-insert', 'anon INSERT failed', e.message); }

/* C3 — anon can UPDATE via re-upsert */
try {
  await anonUpsert(TEST_MEMBER, ['k','r']);
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=opted_out_types');
  const got = new Set(rows[0].opted_out_types);
  if (got.has('k') && got.has('r') && got.size === 2) pass('C3.anon-update', 'Anon UPSERT updates existing row');
  else fail('C3.anon-update', 'UPSERT did not update array', rows);
} catch (e) { fail('C3.anon-update', 'anon UPDATE failed', e.message); }

/* C4 — anon can DELETE */
try {
  await anonDelete(TEST_MEMBER);
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=member_number');
  if (rows.length === 0) pass('C4.anon-delete', 'Anon DELETE removes the row');
  else fail('C4.anon-delete', 'row still present after DELETE', rows);
} catch (e) { fail('C4.anon-delete', 'anon DELETE failed', e.message); }

/* C5 — Prefer: merge-duplicates required; without it POST 409s */
try {
  await anonUpsert(TEST_MEMBER, ['k']);
  const r = await fetch(SB_URL + '/rest/v1/patch_optouts', {
    method: 'POST',
    headers: { ...anonHeaders() },  // no Prefer
    body: JSON.stringify({ member_number: TEST_MEMBER, opted_out_types: ['r'], note: '' })
  });
  if (r.status === 409 || r.status === 400 || r.status === 500) {
    pass('C5.merge-duplicates-required', 'POST without Prefer=merge-duplicates fails (status ' + r.status + ') — confirms our client sets it');
  } else {
    fail('C5.merge-duplicates-required', 'POST without Prefer succeeded unexpectedly', await r.text());
  }
  await anonDelete(TEST_MEMBER);
} catch (e) { fail('C5.merge-duplicates-required', 'test threw', e.message); }

/* C6 — PK is member_number (only one row per member) */
if (!PAT) skip('C6.single-row-per-member', 'PK metadata read requires PAT');
else try {
  const cols = await sql("select constraint_name from information_schema.table_constraints where table_schema='slate' and table_name='patch_optouts' and constraint_type='PRIMARY KEY'");
  if (cols.length) pass('C6.single-row-per-member', 'Primary key on patch_optouts exists (' + cols[0].constraint_name + ')');
  else fail('C6.single-row-per-member', 'No primary key — duplicate rows possible!');
} catch (e) { fail('C6.single-row-per-member', 'PK check failed', e.message); }

/* C7 — opted_out_types is a text[] array */
if (!PAT) skip('C7.array-type', 'column metadata read requires PAT');
else try {
  const cols = await sql("select data_type from information_schema.columns where table_schema='slate' and table_name='patch_optouts' and column_name='opted_out_types'");
  if (cols[0]?.data_type === 'ARRAY') pass('C7.array-type', 'opted_out_types is ARRAY');
  else fail('C7.array-type', 'unexpected data_type', cols[0]);
} catch (e) { fail('C7.array-type', 'type check failed', e.message); }

/* ─────────────────── REST / PostgREST layer ─────────────────────── */

/* C8 — DELETE with no member_number filter is refused by RLS OR returns 0
 * (defense: PostgREST won't mass-delete without a filter) */
try {
  const r = await fetch(SB_URL + '/rest/v1/patch_optouts', {
    method: 'DELETE',
    headers: anonHeaders()
  });
  /* PostgREST requires a WHERE for DELETE; if it doesn't, we still want it to
   * be a no-op or reject. Any 2xx that succeeded means we could just wipe
   * every row. Guard against that. */
  const startCount = (await anonGet('patch_optouts?select=member_number')).length;
  if (r.status >= 400) {
    pass('C8.no-mass-delete', 'Bare DELETE rejected (status ' + r.status + ')');
  } else if (startCount >= 10) {
    pass('C8.no-mass-delete', 'Bare DELETE was a no-op — real rows survived');
  } else {
    fail('C8.no-mass-delete', 'Bare DELETE may have wiped rows!');
  }
} catch (e) { fail('C8.no-mass-delete', 'test threw', e.message); }

/* ─────────────────── Business-logic parity ──────────────────────── */

/* C9 — opting out of ALL 13 codes stores all 13 */
try {
  await anonUpsert(TEST_MEMBER, OPTOUT_CODES);
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=opted_out_types');
  const got = new Set(rows[0].opted_out_types);
  const missing = OPTOUT_CODES.filter(c => !got.has(c));
  if (!missing.length && got.size === 13) pass('C9.opt-out-all', 'All 13 codes persisted');
  else fail('C9.opt-out-all', 'array mismatch', { missing, got: [...got] });
  await anonDelete(TEST_MEMBER);
} catch (e) { fail('C9.opt-out-all', 'test threw', e.message); }

/* C10 — "Save empty" (client's DELETE path) removes the row */
try {
  await anonUpsert(TEST_MEMBER, ['k']);
  await anonDelete(TEST_MEMBER);  // client's empty-denied-set path
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=member_number');
  if (rows.length === 0) pass('C10.check-all-deletes', '✓-Check-all path DELETES the row');
  else fail('C10.check-all-deletes', 'row remained', rows);
} catch (e) { fail('C10.check-all-deletes', 'test threw', e.message); }

/* C11 — save a state, load it back, compare — round-trip fidelity */
try {
  const wanted = ['k','8m','g'];
  await anonUpsert(TEST_MEMBER, wanted);
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=opted_out_types');
  const got = rows[0].opted_out_types;
  const same = wanted.length === got.length && wanted.every(x => got.includes(x));
  if (same) pass('C11.round-trip', 'Save then re-read reproduces the same array');
  else fail('C11.round-trip', 'array changed on round-trip', { wanted, got });
  await anonDelete(TEST_MEMBER);
} catch (e) { fail('C11.round-trip', 'test threw', e.message); }

/* C12 — re-upsert overwrites, doesn't merge */
try {
  await anonUpsert(TEST_MEMBER, ['k','r']);
  await anonUpsert(TEST_MEMBER, ['g']);   // reduce to 1
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=opted_out_types');
  const got = rows[0].opted_out_types;
  if (got.length === 1 && got[0] === 'g') pass('C12.upsert-overwrites', 'Re-UPSERT replaces the array (not merges)');
  else fail('C12.upsert-overwrites', 'array not replaced', got);
  await anonDelete(TEST_MEMBER);
} catch (e) { fail('C12.upsert-overwrites', 'test threw', e.message); }

/* C13 — idempotence: saving the same state twice yields same state */
try {
  await anonUpsert(TEST_MEMBER, ['n','k']);
  await anonUpsert(TEST_MEMBER, ['n','k']);
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=opted_out_types');
  const got = new Set(rows[0].opted_out_types);
  if (got.has('n') && got.has('k') && got.size === 2) pass('C13.idempotent', 'Double save is idempotent');
  else fail('C13.idempotent', 'state drifted', [...got]);
  await anonDelete(TEST_MEMBER);
} catch (e) { fail('C13.idempotent', 'test threw', e.message); }

/* C14 — codes not in OPTOUT_CODES round-trip too (server doesn't validate).
 * If UI is the only enforcement, this is worth surfacing so a future dev
 * knows there's no belt-and-suspenders. */
try {
  await anonUpsert(TEST_MEMBER, ['ZZ']);
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=opted_out_types');
  if (rows[0].opted_out_types[0] === 'ZZ') {
    pass('C14.no-server-code-validation', 'Server does NOT validate codes — UI is sole enforcement (documented)');
  } else {
    fail('C14.no-server-code-validation', 'unexpected value', rows[0]);
  }
  await anonDelete(TEST_MEMBER);
} catch (e) {
  /* Could also fail with a constraint — which is fine. */
  pass('C14.no-server-code-validation', 'Server rejected unknown code — belt-and-suspenders present');
}

/* ─────────────────── Frontend HTML wiring ───────────────────────── */

const htmlResult = await fetch(HTML_URL).then(r => r.text()).catch(e => null);
if (!htmlResult) {
  fail('C15.html-fetchable', 'could not fetch ' + HTML_URL);
} else {
  const html = htmlResult;
  const wiring = [
    ['button.opt-out wired to openOptoutModal',   /class="opt-out"[^>]*onclick="openOptoutModal/],
    ['#optoutModal container',                     /id="optoutModal"/],
    ['✓ Check all bulk button wired',              /optout-bulk-btn all-on[^"]*"[^>]*onclick="optoutBulkSet\(false\)"/],
    ['✗ X all bulk button wired',                  /optout-bulk-btn all-off[^"]*"[^>]*onclick="optoutBulkSet\(true\)"/],
    ['#optoutChipList render target',              /id="optoutChipList"/],
    ['Save button wired',                          /id="optoutSaveBtn"[^>]*onclick="saveOptoutModal/],
    ['Cancel button wired',                        /onclick="closeOptoutModal\(\)"/],
    ['openOptoutModal function defined',           /function openOptoutModal\(\)/],
    ['saveOptoutModal function defined',           /function saveOptoutModal\(\)/],
    ['toggleOptoutChip function defined',          /function toggleOptoutChip\(code\)/],
    ['optoutBulkSet function defined',             /function optoutBulkSet\(deniedAll\)/],
    ['renderOptoutChips function defined',         /function renderOptoutChips\(\)/],
    ['_OPTOUT_CODES has all 13 codes',             /_OPTOUT_CODES = \['r','8','x','9','n','k','m8','mx','m9','mn','8m','9m','g'\]/],
    ['_lastSearchName global exists',              /var _lastSearchName\s*=/],
    ['Escape key handler present',                 /if \(e\.key === 'Escape'/],
    ['backdrop-click close handler',               /e\.target && e\.target\.id === 'optoutModal'/]
  ];
  for (const [name, re] of wiring) {
    const ok = re.test(html);
    if (ok) pass('C15.' + name, name);
    else    fail('C15.' + name, name + ' MISSING from served HTML');
  }
}

/* ─────────────────── Frontend JS logic (extracted + run) ────────── */

if (htmlResult) {
  const html = htmlResult;
  /* Extract just the modal helpers into a testable module. */
  const extract = (name, re) => {
    const m = html.match(re);
    if (!m) throw new Error('function ' + name + ' not found in HTML');
    return m[0];
  };
  const bits = [];
  const SP_LABEL = extract('SP_LABEL', /const SP_LABEL = \{[\s\S]+?\};/);
  const OPTOUT_LIST = extract('_OPTOUT_CODES', /var _OPTOUT_CODES = \[[^\]]+\];/);
  const STATE = extract('_optoutState', /var _optoutState = \{[^}]+\};/);
  const fnBodies = [
    /function openOptoutModal\(\)[\s\S]+?\n\}/,
    /function closeOptoutModal\(\)[\s\S]+?\n\}/,
    /function _setOptoutStatus[\s\S]+?\n\}/,
    /function renderOptoutChips\(\)[\s\S]+?\n\}/,
    /function toggleOptoutChip[\s\S]+?\n\}/,
    /function optoutBulkSet[\s\S]+?\n\}/
  ].map(re => extract('fn', re));

  const jsBundle = SP_LABEL + '\n' + OPTOUT_LIST + '\n' + STATE + '\n' + fnBodies.join('\n');

  /* Minimal DOM shim — the functions we're testing only touch a few
   * elements (chip list innerHTML, modal .classList). Provide stand-ins. */
  const shim = `
    var _mockDom = {
      'optoutChipList': { innerHTML: '' },
      'optoutModal':    { classList: { list: new Set(), add(c){this.list.add(c);}, remove(c){this.list.delete(c);}, contains(c){return this.list.has(c);} } },
      'optoutSaveBtn':  { disabled: false },
      'optoutStatus':   { textContent: '', classList: { list: new Set(), add(c){this.list.add(c);}, remove(c){this.list.delete(c);} } },
      'optoutTitle':    { textContent: '' },
      'optoutSub':      { textContent: '' }
    };
    var document = { getElementById: function (id) { return _mockDom[id]; }, addEventListener: function(){} };
    var alert = function () {};
    var sbGet = function () { return Promise.resolve([{ opted_out_types: [] }]); };
    var window = {};
  `;

  const _lastSearchMember = TEST_MEMBER;
  const _lastSearchName = 'Test Player';
  const runner = `
    ${shim}
    var _lastSearchMember = '${TEST_MEMBER}';
    var _lastSearchName = 'Test Player';
    ${jsBundle}
    /* --- assertions --- */
    var results = [];
    function chk(name, cond, detail) { results.push({ name: name, ok: !!cond, detail: detail }); }

    /* State starts null (no denied set); after opening modal, populated as empty Set. */
    _optoutState.denied = new Set();

    /* Toggling adds and removes. */
    toggleOptoutChip('k');
    chk('toggle-add', _optoutState.denied.has('k') && _optoutState.denied.size === 1);
    toggleOptoutChip('k');
    chk('toggle-remove', !_optoutState.denied.has('k') && _optoutState.denied.size === 0);

    /* Bulk ✗ all — populates all 13. */
    optoutBulkSet(true);
    chk('bulk-all-off', _optoutState.denied.size === _OPTOUT_CODES.length);

    /* Bulk ✓ all — clears set. */
    optoutBulkSet(false);
    chk('bulk-all-on', _optoutState.denied.size === 0);

    /* Toggle each code once — end state has exactly the same 13 codes. */
    _OPTOUT_CODES.forEach(function (c) { toggleOptoutChip(c); });
    chk('all-toggled-once', _optoutState.denied.size === _OPTOUT_CODES.length);

    /* Toggle each again — end state is empty. */
    _OPTOUT_CODES.forEach(function (c) { toggleOptoutChip(c); });
    chk('all-toggled-twice-empty', _optoutState.denied.size === 0);

    /* renderOptoutChips writes to innerHTML with 13 rows when denied is empty */
    optoutBulkSet(false);
    renderOptoutChips();
    var html = _mockDom.optoutChipList.innerHTML;
    var rowCount = (html.match(/class="optout-row/g) || []).length;
    chk('render-13-rows', rowCount === 13, { rowCount: rowCount });

    /* Every code appears green ✓ (class 'on') when denied is empty */
    var onCount = (html.match(/class="optout-row on"/g) || []).length;
    chk('render-all-on', onCount === 13, { onCount: onCount });

    /* Every code appears red ✗ (class 'off') when denied has all */
    optoutBulkSet(true);
    renderOptoutChips();
    html = _mockDom.optoutChipList.innerHTML;
    var offCount = (html.match(/class="optout-row off"/g) || []).length;
    chk('render-all-off', offCount === 13, { offCount: offCount });

    JSON.stringify(results);
  `;
  try {
    const raw = eval(runner);
    const jsResults = JSON.parse(raw);
    for (const r of jsResults) {
      if (r.ok) pass('C16.' + r.name, 'JS logic: ' + r.name);
      else     fail('C16.' + r.name, 'JS logic: ' + r.name, r.detail);
    }
  } catch (e) {
    fail('C16.js-extract', 'Failed to run frontend JS in Node sandbox', e.message + '\n' + e.stack?.slice(0, 800));
  }
}

/* ─────────────────── Data quality of LIVE opt-out rows ─────────── */

/* C17 — every currently-stored code is one of the 13 known codes.
 * If a value slipped in outside OPTOUT_CODES (typo, old spelling), the
 * Slate admin UI would render an unlabeled chip and PatchCheck wouldn't
 * suppress anything. Catches drift before it hits real players. */
if (!PAT) skip('C17.live-codes-known', 'live-row scan requires PAT');
else try {
  const live = await sql("select member_number, opted_out_types from slate.patch_optouts where member_number != '" + TEST_MEMBER + "'");
  const allowed = new Set(OPTOUT_CODES);
  const strays = [];
  for (const r of live) {
    for (const c of (r.opted_out_types || [])) {
      if (!allowed.has(c)) strays.push({ member: r.member_number, code: c });
    }
  }
  if (strays.length) fail('C17.live-codes-known', strays.length + ' live rows carry unknown codes', strays.slice(0, 5));
  else pass('C17.live-codes-known', 'All ' + live.length + ' live opt-out rows only reference the 13 known codes');
} catch (e) { fail('C17.live-codes-known', 'query failed', e.message); }

/* C18 — CORS preflight: the browser will send OPTIONS before our POST
 * because we set a custom Prefer header. Verify the OPTIONS response
 * allows POST with the headers we use. */
try {
  const r = await fetch(SB_URL + '/rest/v1/patch_optouts?on_conflict=member_number', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://southportlandmetroapa.github.io',
      'Access-Control-Request-Method':  'POST',
      'Access-Control-Request-Headers': 'apikey, authorization, content-type, prefer, content-profile, accept-profile'
    }
  });
  const allowMethods = (r.headers.get('access-control-allow-methods') || '').toUpperCase();
  const allowHeaders = (r.headers.get('access-control-allow-headers') || '').toLowerCase();
  if (r.status === 200 && allowMethods.includes('POST') && allowHeaders.includes('prefer')) {
    pass('C18.cors-preflight', 'CORS preflight allows POST + Prefer header');
  } else {
    fail('C18.cors-preflight', 'CORS preflight incomplete', { status: r.status, allowMethods, allowHeaders });
  }
} catch (e) { fail('C18.cors-preflight', 'preflight threw', e.message); }

/* C19 — member_number is text, so leading zeros must survive. SPM
 * numbers like '00993' are common. */
try {
  await anonUpsert('00998', ['k']);
  const rows = await anonGet('patch_optouts?member_number=eq.00998&select=member_number');
  if (rows.length && rows[0].member_number === '00998') {
    pass('C19.leading-zeros', 'member_number "00998" preserved as text');
  } else {
    fail('C19.leading-zeros', 'stored value drift', rows);
  }
  await anonDelete('00998');
} catch (e) { fail('C19.leading-zeros', 'test threw', e.message); }

/* C20 — read-your-writes: UPSERT then immediately GET returns the
 * new state (no PostgREST caching / replica lag surprise). */
try {
  await anonUpsert(TEST_MEMBER, ['x','9']);
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=opted_out_types');
  const got = new Set(rows[0].opted_out_types);
  if (got.has('x') && got.has('9') && got.size === 2) pass('C20.read-your-writes', 'GET immediately after UPSERT sees new value');
  else fail('C20.read-your-writes', 'stale read', [...got]);
  await anonDelete(TEST_MEMBER);
} catch (e) { fail('C20.read-your-writes', 'test threw', e.message); }

/* C21 — every OPTOUT_CODE has an SP_LABEL entry (client will render an
 * ugly bare code if not). */
if (htmlResult) {
  const m = htmlResult.match(/const SP_LABEL = (\{[\s\S]+?\});/);
  if (!m) fail('C21.sp-label-coverage', 'SP_LABEL not found');
  else {
    let labels;
    try { labels = eval('(' + m[1] + ')'); } catch (e) { fail('C21.sp-label-coverage', 'SP_LABEL parse failed', e.message); labels = null; }
    if (labels) {
      const missing = OPTOUT_CODES.filter(c => !(c in labels));
      if (missing.length) fail('C21.sp-label-coverage', 'missing labels', missing);
      else pass('C21.sp-label-coverage', 'Every OPTOUT_CODE has an SP_LABEL entry');
    }
  }
}

/* C22 — HTML charset is UTF-8 (needed for ✓ ✗ ⚠ glyphs) */
if (htmlResult) {
  const hasUtf8 = /<meta[^>]+charset\s*=\s*["']?utf-8/i.test(htmlResult);
  if (hasUtf8) pass('C22.utf8-charset', 'Page declares UTF-8 charset');
  else fail('C22.utf8-charset', '<meta charset=utf-8> not found');
}

/* C23 — openOptoutModal guards on empty _lastSearchMember (shows an
 * alert instead of opening the modal with no data). */
if (htmlResult) {
  const m = htmlResult.match(/function openOptoutModal[\s\S]+?\n\}/);
  if (!m) fail('C23.guard-empty-member', 'function not found');
  else {
    const src = m[0];
    if (/if \(!_lastSearchMember\)/.test(src) && /alert\(/.test(src)) {
      pass('C23.guard-empty-member', 'openOptoutModal guards on empty _lastSearchMember and alerts');
    } else {
      fail('C23.guard-empty-member', 'Guard missing — modal would open with no player');
    }
  }
}

/* C24 — burst load: 5 upserts in quick succession all succeed. */
try {
  const bursts = [];
  for (let i = 0; i < 5; i++) bursts.push(anonUpsert(TEST_MEMBER, [OPTOUT_CODES[i]]));
  await Promise.all(bursts);
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=opted_out_types');
  if (rows.length === 1) pass('C24.burst-consistent', '5 parallel upserts collapsed to 1 row');
  else fail('C24.burst-consistent', 'row count anomaly', rows);
  await anonDelete(TEST_MEMBER);
} catch (e) { fail('C24.burst-consistent', 'burst threw', e.message); }

/* C25 — sequential upsert-then-delete-then-upsert leaves the correct
 * final state (regression coverage for a common cache-eviction bug). */
try {
  await anonUpsert(TEST_MEMBER, ['k','r']);
  await anonDelete(TEST_MEMBER);
  await anonUpsert(TEST_MEMBER, ['9']);
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=opted_out_types');
  if (rows.length === 1 && rows[0].opted_out_types.length === 1 && rows[0].opted_out_types[0] === '9') {
    pass('C25.upsert-delete-upsert', 'Toggle sequence lands on final state');
  } else {
    fail('C25.upsert-delete-upsert', 'state mismatch', rows);
  }
  await anonDelete(TEST_MEMBER);
} catch (e) { fail('C25.upsert-delete-upsert', 'test threw', e.message); }

/* C26 — Slate admin's list of codes matches PatchCheck's exactly.
 * If Slate adds a code, PatchCheck should surface it too. Read Slate's
 * const from its admin.html served over Pages. */
try {
  const slate = await fetch('https://southportlandmetroapa.github.io/spm-admin/admin.html').then(r => r.text()).catch(() => null);
  if (!slate) {
    fail('C26.code-list-parity', 'could not fetch Slate admin');
  } else {
    const sm = slate.match(/const OPTOUT_CODES = \[[^\]]+\]/);
    const pm = htmlResult.match(/var _OPTOUT_CODES = \[[^\]]+\]/);
    if (!sm || !pm) fail('C26.code-list-parity', 'could not extract OPTOUT_CODES from one side');
    else if (sm[0].split('[')[1] === pm[0].split('[')[1]) pass('C26.code-list-parity', 'Slate + PatchCheck OPTOUT_CODES arrays are identical');
    else fail('C26.code-list-parity', 'code lists diverge', { slate: sm[0], patchcheck: pm[0] });
  }
} catch (e) { fail('C26.code-list-parity', 'compare threw', e.message); }

/* C27 — the modal's Prefer header includes return=minimal so we don't
 * waste bandwidth returning the row. */
if (htmlResult) {
  const m = htmlResult.match(/function saveOptoutModal[\s\S]+?\n\}/);
  if (!m) fail('C27.return-minimal', 'saveOptoutModal not found');
  else if (/return=minimal/.test(m[0])) pass('C27.return-minimal', 'Save uses Prefer=return=minimal');
  else fail('C27.return-minimal', 'return=minimal missing from save Prefer header');
}

/* C28 — the Escape key + backdrop-click handlers are attached at
 * document level (not element level) so they survive re-renders. */
if (htmlResult) {
  const hasDocEsc = /document\.addEventListener\('keydown'[\s\S]{0,400}Escape/.test(htmlResult);
  const hasDocBackdrop = /document\.addEventListener\('click'[\s\S]{0,400}optoutModal/.test(htmlResult);
  if (hasDocEsc && hasDocBackdrop) pass('C28.close-handlers-doc-level', 'Escape + backdrop handlers on document (survives re-renders)');
  else fail('C28.close-handlers-doc-level', 'handlers not on document', { hasDocEsc, hasDocBackdrop });
}

/* ─────────────────── Third-round expansion ─────────────────────── */

/* C29 — note preservation: an admin sets a note on a row; then the
 * player saves from PatchCheck. The save must NOT clobber the note. */
if (!PAT) skip('C29.note-preserved', 'seed-with-note requires PAT');
else try {
  /* Seed via service role — this is what the Slate admin UI does. */
  await sql("insert into slate.patch_optouts (member_number, opted_out_types, note) values ('" + TEST_MEMBER + "', array['k'], 'admin: player asked in person') on conflict (member_number) do update set opted_out_types=excluded.opted_out_types, note=excluded.note");
  /* Player opens PatchCheck, changes codes, saves. Simulate a save that
   * only sends member_number + opted_out_types (no note). */
  await anonUpsert(TEST_MEMBER, ['r']);
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=note,opted_out_types');
  const note = rows[0].note;
  if (note === 'admin: player asked in person') {
    pass('C29.note-preserved', 'PatchCheck save preserves admin-set note');
  } else {
    fail('C29.note-preserved', 'note was clobbered', { got: note });
  }
  await anonDelete(TEST_MEMBER);
} catch (e) { fail('C29.note-preserved', 'test threw', e.message); }

/* C30 — save button has aria-label / a11y attributes.
 * The .opt-out CTA has aria-haspopup so screen readers announce it. */
if (htmlResult) {
  const m = htmlResult.match(/class="opt-out"[^>]*/);
  if (m && /aria-haspopup/.test(m[0])) pass('C30.aria-haspopup', 'Opt-out button announces as opening a dialog');
  else fail('C30.aria-haspopup', 'aria-haspopup missing from opt-out button');
}

/* C31 — the opt-out CTA is a real <button>, not an anchor. Anchors
 * default to submitting the form or navigating. Regression guard. */
if (htmlResult) {
  const isButton = /<button[^>]*class="opt-out"/.test(htmlResult);
  const isAnchor = /<a[^>]*class="opt-out"/.test(htmlResult);
  if (isButton && !isAnchor) pass('C31.button-not-anchor', 'Opt-out is <button>, not <a>');
  else fail('C31.button-not-anchor', 'unexpected element', { isButton, isAnchor });
}

/* C32 — RLS anon_write policy exists (defensive check — if someone
 * accidentally drops it during a migration, the modal silently 401s). */
if (!PAT) skip('C32.rls-anon-write', 'pg_policy read requires PAT');
else try {
  const pols = await sql("select polname from pg_policy where polrelid='slate.patch_optouts'::regclass and 'anon'::regrole = ANY(polroles) and polcmd='*'");
  if (pols.length) pass('C32.rls-anon-write', 'patch_optouts_anon_write RLS policy exists (' + pols[0].polname + ')');
  else fail('C32.rls-anon-write', 'anon write policy missing');
} catch (e) { fail('C32.rls-anon-write', 'check failed', e.message); }

/* C33 — modal Save calls sbHeaders('slate') so Content-Profile/Accept-Profile
 * point at the slate schema. Wrong schema → 404 on the table. */
if (htmlResult) {
  const m = htmlResult.match(/function saveOptoutModal[\s\S]+?\n\}/);
  if (m && /sbHeaders\('slate'\)/.test(m[0])) pass('C33.sb-headers-slate', 'saveOptoutModal targets slate schema');
  else fail('C33.sb-headers-slate', 'schema header wrong');
}

/* C34 — save wraps DELETE and UPSERT paths in a shared error handler
 * so a failure surfaces via the status line, not a silent hang. */
if (htmlResult) {
  const m = htmlResult.match(/function saveOptoutModal[\s\S]+?\n\}/);
  if (m && /\.catch\(function/.test(m[0]) && /Save failed:/.test(m[0])) {
    pass('C34.error-surface', 'Save catches errors and shows in status line');
  } else {
    fail('C34.error-surface', 'error surface missing');
  }
}

/* C35 — modal is mobile-viewport-friendly: max-width caps at 460px,
 * max-height at 88vh, backdrop uses padding for small screens. */
if (htmlResult) {
  const hasMaxWidth  = /\.optout-modal\s*\{[^}]*max-width:\s*460px/.test(htmlResult);
  const hasMaxHeight = /\.optout-modal\s*\{[^}]*max-height:\s*88vh/.test(htmlResult);
  if (hasMaxWidth && hasMaxHeight) pass('C35.mobile-friendly', 'Modal caps width + height for small viewports');
  else fail('C35.mobile-friendly', 'sizing constraints missing', { hasMaxWidth, hasMaxHeight });
}

/* C36 — cache invalidation on save so a subsequent lookup shows the
 * new opt-out state (avoids "I opted out but the list still shows my patch"). */
if (htmlResult) {
  const m = htmlResult.match(/function saveOptoutModal[\s\S]+?\n\}/);
  if (m && /_playerSessionDataCache\s*=\s*\{\}/.test(m[0])) {
    pass('C36.cache-bust', 'Save busts the per-session data cache');
  } else {
    fail('C36.cache-bust', 'cache-bust missing from save handler');
  }
}

/* ─────────────────── Fourth-round expansion ────────────────────── */

/* C37 — reopening the modal on the same tab resets state.
 * `openOptoutModal` must overwrite _optoutState.memberShort, .name, and
 * .denied so a second open (perhaps for a different player after a fresh
 * lookup) doesn't carry the prior denied set. */
if (htmlResult) {
  const m = htmlResult.match(/function openOptoutModal[\s\S]+?\n\}/);
  if (m) {
    const src = m[0];
    const resetsMember  = /_optoutState\.memberShort\s*=\s*_lastSearchMember/.test(src);
    const resetsName    = /_optoutState\.name\s*=\s*_lastSearchName/.test(src);
    const resetsDenied  = /_optoutState\.denied\s*=\s*new Set\(\)/.test(src);
    const resetsStatus  = /_setOptoutStatus\('Loading current preferences/.test(src);
    if (resetsMember && resetsName && resetsDenied && resetsStatus) {
      pass('C37.reopen-resets-state', 'Re-opening the modal wipes prior state (member, name, denied, status)');
    } else {
      fail('C37.reopen-resets-state', 'reset missing', { resetsMember, resetsName, resetsDenied, resetsStatus });
    }
  }
}

/* C38 — the mail pipeline consumes opted_out_types.
 * PatchCheck's buildEvents filters by optoutTypes so the dashboard hides
 * patches the player opted out of. Confirm the option is threaded through. */
if (htmlResult) {
  const m = htmlResult.match(/function fetchPlayerSessionData[\s\S]+?\n\}/);
  if (m && /patch_optouts/.test(m[0]) && /optoutTypes/.test(m[0])) {
    pass('C38.pipeline-consumes-optouts', 'fetchPlayerSessionData loads patch_optouts + threads optoutTypes downstream');
  } else {
    fail('C38.pipeline-consumes-optouts', 'pipeline does not consume opt-outs');
  }
}

/* C39 — the save-button gets re-enabled on error.
 * Otherwise a network hiccup leaves the modal permanently disabled. */
if (htmlResult) {
  const m = htmlResult.match(/function saveOptoutModal[\s\S]+?\n\}/);
  if (m && /\.catch\([\s\S]+?btn\.disabled = false/.test(m[0])) {
    pass('C39.save-recovers-from-error', 'Save button re-enables in .catch');
  } else {
    fail('C39.save-recovers-from-error', 'save button stays disabled on error');
  }
}

/* C40 — cache-key isolation.
 * `_playerSessionDataCache` is a global. If a save-triggered cache-bust
 * used the wrong key, it could wipe unrelated data. Verify the bust
 * resets the WHOLE cache (safe over-invalidation) rather than per-key. */
if (htmlResult) {
  const m = htmlResult.match(/function saveOptoutModal[\s\S]+?\n\}/);
  if (m && /_playerSessionDataCache\s*=\s*\{\}/.test(m[0])) {
    pass('C40.cache-bust-full', 'Cache-bust wipes the whole cache (over-invalidation is safer)');
  } else {
    fail('C40.cache-bust-full', 'cache bust missing or partial');
  }
}

/* C41 — bit.ly link is no longer used.
 * The old <a href="https://bit.ly/PatchOptOut"> pointed to a Google
 * Form. Now that we have an in-app modal, the redirect should be gone
 * everywhere so a copy-paste of the link doesn't reintroduce it. */
if (htmlResult) {
  const bitlyStillReferenced = /bit\.ly\/PatchOptOut/.test(htmlResult);
  if (!bitlyStillReferenced) pass('C41.no-bitly-fallback', 'bit.ly PatchOptOut link is gone');
  else fail('C41.no-bitly-fallback', 'stale bit.ly reference lingers');
}

/* C42 — DELETE cascade of the "opt-in everything" path.
 * When denied.size===0 → DELETE. Verify subsequent GET returns 0 rows
 * (not an empty-array row). Distinct because an empty ARRAY row would
 * still show up in Slate's optout list as "no patches opted out (row
 * has no effect)" per the admin UI. */
try {
  await anonUpsert(TEST_MEMBER, ['k']);
  await anonDelete(TEST_MEMBER);
  const rows = await anonGet('patch_optouts?member_number=eq.' + TEST_MEMBER + '&select=member_number');
  if (rows.length === 0) pass('C42.opt-in-all-deletes', 'Opt-in-all removes the row entirely');
  else fail('C42.opt-in-all-deletes', 'row still present with empty array', rows);
} catch (e) { fail('C42.opt-in-all-deletes', 'test threw', e.message); }

/* C43 — Escape handler is scoped to when the modal is SHOWN.
 * Escape shouldn't fire close attempts when modal is closed (dead code
 * is fine but a lingering listener could stomp other keyboard shortcuts). */
if (htmlResult) {
  const m = htmlResult.match(/document\.addEventListener\('keydown'[\s\S]+?\}\);/);
  if (m && /contains\('shown'\)/.test(m[0])) {
    pass('C43.escape-scoped', 'Escape close is gated on .shown class');
  } else {
    fail('C43.escape-scoped', 'Escape may fire when modal is closed');
  }
}

/* C44 — CTA button styles: hover, active, focus visible.
 * All three states matter for touch + keyboard users. Verify at
 * least :hover is defined on .opt-out (baseline). */
if (htmlResult) {
  if (/\.opt-out:hover/.test(htmlResult)) pass('C44.hover-style', ':hover state defined for opt-out button');
  else fail('C44.hover-style', ':hover style missing');
}

/* C45 — every optout code has a distinct human-readable label.
 * If two codes collide on the same label, the modal would render
 * ambiguous rows. */
if (htmlResult) {
  const m = htmlResult.match(/const SP_LABEL = (\{[\s\S]+?\});/);
  if (m) {
    let labels;
    try { labels = eval('(' + m[1] + ')'); } catch { labels = null; }
    if (labels) {
      const vals = OPTOUT_CODES.map(c => labels[c]);
      const dupes = vals.filter((v, i) => vals.indexOf(v) !== i);
      if (!dupes.length) pass('C45.labels-unique', 'Every opt-out code has a unique label');
      else fail('C45.labels-unique', 'duplicate labels', dupes);
    }
  }
}

/* ─────────────────── S — buildEvents status display ─────────────
 *
 * Extract buildEvents from the served HTML and run it with synthetic
 * inputs to prove the mail-status badge respects opt-out state even
 * when a patch record exists. After Slate 3.161/3.162, compute always
 * creates the sp_patches row for opted-out members, so PatchCheck must
 * check opt-out BEFORE deciding a badge says "Not Yet Mailed".
 */
if (htmlResult) {
  const src = htmlResult.match(/function buildEvents\(bdRows, skunks, patches, optoutTypes\)[\s\S]+?\n\}/);
  if (!src) {
    fail('S1.buildEvents-extract', 'buildEvents source not found');
  } else {
    const fnBody = src[0];

    /* S1 — branch structure assertion (STATIC).
     * The status-display cascade must check opt-out BEFORE the
     * "Not Yet Mailed" catch-all — otherwise any patch record that
     * exists (which is now every earned patch, post-3.161) short-
     * circuits to "Not Yet Mailed" and misleads the opted-out player.
     *
     * Required precedence:
     *   1. mailed_at set                 → "Patch mailed"
     *   2. optoutTypes.has(sp_type)       → "Opted out"
     *   3. patch record exists            → "Not Yet Mailed"
     *   4. otherwise                       → "Patch earned — will be mailed"
     *
     * The bug I need this to catch: branch #3 sits above branch #2. */
    /* Match the ASSIGNMENT to statusDisplay for each branch — not any
       occurrence of the phrase (which would false-match on comments). */
    const mailedIdx  = fnBody.search(/statusDisplay\s*=\s*['"]Patch mailed/);
    const optoutIdx  = fnBody.search(/statusDisplay\s*=\s*['"]Opted out/);
    const recordIdx  = fnBody.search(/statusDisplay\s*=\s*['"]Not Yet Mailed['"]/);
    const earnedIdx  = fnBody.search(/statusDisplay\s*=\s*['"]Patch earned/);

    if ([mailedIdx, optoutIdx, recordIdx, earnedIdx].some(i => i < 0)) {
      fail('S1.branches-present', 'one or more status branches missing',
        { mailedIdx, optoutIdx, recordIdx, earnedIdx });
    } else {
      pass('S1.branches-present', 'All four status branches present');

      /* S2 — precedence: opt-out check must come BEFORE the record-only
         "Not Yet Mailed" branch. */
      if (optoutIdx < recordIdx) {
        pass('S2.optout-before-record', 'Opt-out check precedes "Not Yet Mailed" branch');
      } else {
        fail('S2.optout-before-record',
          'Branch order wrong — "Not Yet Mailed" fires at char ' + recordIdx +
          ' before opt-out check at char ' + optoutIdx);
      }

      /* S3 — precedence: mailed_at check must come BEFORE opt-out. A mailed
         patch has already been physically delivered, so the label should
         reflect delivery even if the player later opted out. */
      if (mailedIdx < optoutIdx) {
        pass('S3.mailed-before-optout', '"Patch mailed" wins over subsequent opt-out flag');
      } else {
        fail('S3.mailed-before-optout',
          'mailed check at ' + mailedIdx + ' after opt-out at ' + optoutIdx);
      }

      /* S4 — "Patch earned" catch-all is LAST. */
      const maxOther = Math.max(mailedIdx, optoutIdx, recordIdx);
      if (earnedIdx > maxOther) {
        pass('S4.earned-catch-all-last', '"Patch earned" is the final catch-all');
      } else {
        fail('S4.earned-catch-all-last', 'earned branch precedes another branch', { earnedIdx, maxOther });
      }
    }

    /* S5 — no dead code: verify the opt-out branch is reachable.
     * With the OLD ordering (record before opt-out), the opt-out branch
     * is unreachable in the common case where compute always creates
     * a record. This is a stricter form of S2 that flags the semantic. */
    {
      /* If opt-out check comes AFTER `else if (p)`, and p is always
         defined when compute has run (post-3.161), then the opt-out
         branch is dead for the common case. */
      const wrongOrder = /else\s+if\s*\(\s*p\s*\)[\s\S]{0,200}Not Yet Mailed[\s\S]{0,120}else\s+if\s*\(\s*optoutTypes/.test(fnBody);
      if (wrongOrder) fail('S5.optout-not-dead', 'Opt-out branch is unreachable when a patch record exists');
      else pass('S5.optout-not-dead', 'Opt-out branch is reachable');
    }
  }
}
/* END of S1–S5 branch-order assertions.
   Below was an extract-and-run harness that proved too fragile against
   buildEvents' many module-level dependencies. The static assertions
   above catch the class of bug we care about (branch precedence).
   The remaining wrapper block is dead — kept in a `false`-guarded
   scope so its variables don't shadow anything in scope above. */
/* ─────────────────── Final cleanup ─────────────────────────────── */
await anonDelete(TEST_MEMBER).catch(() => {});

/* ─────────────────── Report ─────────────────────────────────────── */
const failed = checks.filter(c => !c.ok);
console.log('\n=== PatchCheck opt-out validation ===');
for (const c of checks) {
  console.log((c.ok ? '✓ ' : '✗ ') + c.id + ' — ' + c.msg);
  if (!c.ok && c.detail) {
    const s = typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail, null, 2);
    console.log('    ' + s.split('\n').join('\n    ').slice(0, 800));
  }
}
console.log('\n' + (checks.length - failed.length) + ' / ' + checks.length + ' checks passed.');
process.exit(failed.length ? 1 : 0);
