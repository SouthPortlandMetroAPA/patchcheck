// ═══════════════════════════════════════════════════════════════════════
// PatchCheck Certs Worker — Cloudflare Worker
// ═══════════════════════════════════════════════════════════════════════
// Endpoints:
//   POST /certs/generate    — admin-triggered cert batch generation
//     Auth: Authorization: Bearer <SUPABASE_SERVICE_KEY>
//     Body: { session_id: number, session_slug: string, season_label: string }
//     Algorithm:
//       1. DELETE slate.certs WHERE session_id = X
//       2. R2 list + delete prefix `certs/{session_slug}/`
//       3. RPC slate.compute_session_cert_eligibility(X) → cert work queue
//       4. For each cert:
//          - Pick template by tier
//          - Substitute tokens
//          - Browser Rendering: setContent + screenshot
//          - R2 upload: certs/{slug}/{member}/{tier}-{sp_type}{-div_slug?}.png
//          - INSERT slate.certs row
//       5. Return { total, generated, errors[] }
//
//   GET /certs/list?session_id=X&apa=YYYYYYY    — public read for PatchCheck
//     Returns: [{ tier, sp_type, sp_label, cert_count, division_name, r2_url, generated_at }]
//
// Bindings (wrangler.toml):
//   R2 bucket binding:    R2 = apa-photos
//   Browser Rendering:    BROWSER = (CF browser binding)
//   Secrets (via wrangler secret put):
//     SUPABASE_URL              https://dqzbekoaysgaiqljueac.supabase.co
//     SUPABASE_ANON_KEY         (public anon JWT)
//     SUPABASE_SERVICE_KEY      (service role JWT — for /generate)
//     APA_PHOTOS_PROXY          https://apa-photos.spmapa.workers.dev
//
// R2 prerequisites (one-time upload via tools/claude/patchcheck-certs/setup-r2.mjs):
//   apa-photos/certs-templates/spring-2026-template.html                       (token-form)
//   apa-photos/certs-templates/spring-2026-the-most-template.html              (token-form)
//   apa-photos/certs-templates/spring-2026-exceptional-achievement-template.html
//   apa-photos/certs-templates/apa-logo-datauri.txt
//   apa-photos/certs-templates/spring-2026-watermark-datauri.txt
//
// PNG output paths (relative to apa-photos bucket):
//   certs/{session_slug}/{member_number}/{tier}-{sp_type}{-{division_slug}}.png
// ═══════════════════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const TEMPLATE_BY_TIER = {
  outstanding: 'certs-templates/spring-2026-template.html',
  the_most:    'certs-templates/spring-2026-the-most-template.html',
  exceptional: 'certs-templates/spring-2026-exceptional-achievement-template.html',
};

// ── Slugify helper (matches the slug-immutability rule in MEMORY.md) ──
function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
}

// ── Token substitution helper ──
function substitute(template, tokens) {
  let out = template;
  for (const [k, v] of Object.entries(tokens)) {
    out = out.replaceAll(`{{${k}}}`, v == null ? '' : String(v));
  }
  return out;
}

// ── Format a date "June 7, 2026" from an ISO date or pass-through ──
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T12:00:00Z' : ''));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

// ── Supabase PostgREST helpers ──
function sbHeaders(env, profile, useServiceRole) {
  return {
    apikey: useServiceRole ? env.SUPABASE_SERVICE_KEY : env.SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + (useServiceRole ? env.SUPABASE_SERVICE_KEY : env.SUPABASE_ANON_KEY),
    'Accept-Profile':  profile,
    'Content-Profile': profile,
    'Content-Type':    'application/json',
  };
}

async function sbGet(env, profile, path, useServiceRole) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    headers: sbHeaders(env, profile, useServiceRole),
  });
  if (!r.ok) throw new Error(`PostgREST ${r.status} on ${path}`);
  return r.json();
}

async function sbRpc(env, profile, fn, args, useServiceRole) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: sbHeaders(env, profile, useServiceRole),
    body: JSON.stringify(args || {}),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`PostgREST RPC ${r.status} on ${fn}: ${t}`);
  }
  return r.json();
}

async function sbDelete(env, profile, path) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    method: 'DELETE',
    headers: sbHeaders(env, profile, true),
  });
  if (!r.ok) throw new Error(`PostgREST DELETE ${r.status} on ${path}`);
}

async function sbInsert(env, profile, table, rows) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: {
      ...sbHeaders(env, profile, true),
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`PostgREST INSERT ${r.status} on ${table}: ${t}`);
  }
}

// ── R2 helpers ──
async function r2Get(env, key) {
  const obj = await env.R2.get(key);
  if (!obj) throw new Error(`R2 miss: ${key}`);
  return obj;
}

async function r2GetText(env, key) {
  return (await r2Get(env, key)).text();
}

async function r2Put(env, key, body, httpMetadata) {
  await env.R2.put(key, body, { httpMetadata: httpMetadata || { contentType: 'image/png' } });
}

async function r2DeletePrefix(env, prefix) {
  let cursor;
  do {
    const list = await env.R2.list({ prefix, cursor });
    if (list.objects.length) {
      // R2 deleteMany takes string[] of keys
      await env.R2.delete(list.objects.map(o => o.key));
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

// ── Render one cert via Browser Rendering API ──
async function renderCert(env, templateCache, cert, ctx) {
  const tplKey = TEMPLATE_BY_TIER[cert.tier];
  if (!tplKey) throw new Error('Unknown tier: ' + cert.tier);

  // Cache the template + asset URIs across this generation run
  if (!templateCache.byTier[cert.tier]) {
    templateCache.byTier[cert.tier] = await r2GetText(env, tplKey);
  }
  if (!templateCache.logoUri) {
    templateCache.logoUri = (await r2GetText(env, 'certs-templates/apa-logo-datauri.txt')).trim();
  }
  if (!templateCache.watermarkUri) {
    templateCache.watermarkUri = (await r2GetText(env, 'certs-templates/spring-2026-watermark-datauri.txt')).trim();
  }

  const tpl = templateCache.byTier[cert.tier];

  // Build token map — shared across tiers, unused tokens are no-ops.
  const tokens = {
    PLAYER_FIRST:        cert.player_first || '',
    PLAYER_LAST:         cert.player_last  || '',
    ACH_TYPE:            cert.sp_label,
    ACH_QUANTITY:        countWord(cert.cert_count) + ' (' + cert.cert_count + ')',
    ACH_COUNT:           String(cert.cert_count),
    TEAM_NAME:           cert.team_name     || '',
    DIVISION_NAME:       cert.division_name || '',
    SESSION:             ctx.session_label,        // e.g. "2026 Spring Session"
    SEAL_SEASON:         ctx.season_label,         // e.g. "SPRING 2026"
    DATE:                ctx.formatted_date,       // e.g. "June 7, 2026"
    APA_LOGO_DATAURI:    templateCache.logoUri,
    WATERMARK_DATAURI:   templateCache.watermarkUri,
  };

  const html = substitute(tpl, tokens);

  // Launch a browser via the Browser Rendering binding
  const browser = await env.BROWSER.launch();
  const page = await browser.newPage();
  // Set viewport to cert size at 96dpi (cert is letter, native 8.5x11in or 11x8.5in)
  const portrait = (cert.tier === 'outstanding');
  await page.setViewport({
    width:  portrait ? 816  : 1056,   // 8.5in × 96dpi or 11in × 96dpi
    height: portrait ? 1056 : 816,
    deviceScaleFactor: 2,             // 2x for crisp print
  });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  // Wait for fonts to settle
  await page.evaluate(() => document.fonts && document.fonts.ready);
  const png = await page.screenshot({ type: 'png', fullPage: false });
  await browser.close();
  return png;
}

// ── "One", "Two", ... up to 12. Beyond that, use the digit string. ──
function countWord(n) {
  const words = ['Zero','One','Two','Three','Four','Five','Six','Seven',
                 'Eight','Nine','Ten','Eleven','Twelve'];
  return (n >= 0 && n <= 12) ? words[n] : String(n);
}

// ══════════════════════════════════════════════════════════════════════
// Endpoint: POST /certs/generate
// ══════════════════════════════════════════════════════════════════════
async function handleGenerate(request, env) {
  // Auth gate
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/, '');
  if (!token || token !== env.SUPABASE_SERVICE_KEY) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, error: 'invalid json' }, 400); }

  const { session_id, session_slug, season_label, session_label, date_iso } = body;
  if (!session_id || !session_slug) {
    return jsonResponse({ ok: false, error: 'session_id and session_slug required' }, 400);
  }

  const errors = [];
  let generated = 0;

  try {
    // 1. Clear DB rows for this session
    await sbDelete(env, 'slate', 'certs?session_id=eq.' + encodeURIComponent(session_id));

    // 2. Clear R2 objects under certs/{session_slug}/
    await r2DeletePrefix(env, 'certs/' + session_slug + '/');

    // 3. Pull work queue from RPC
    const queue = await sbRpc(env, 'slate', 'compute_session_cert_eligibility',
      { p_session_id: session_id }, true);

    if (!Array.isArray(queue) || queue.length === 0) {
      return jsonResponse({ ok: true, total: 0, generated: 0, errors: [] });
    }

    // 4. Render + upload + insert each
    const ctx = {
      session_label: session_label || season_label || '',
      season_label:  season_label  || '',
      formatted_date: fmtDate(date_iso),
    };
    const templateCache = { byTier: {} };

    for (const cert of queue) {
      try {
        const png = await renderCert(env, templateCache, cert, ctx);

        const tierKey = cert.tier;
        const spKey   = slugify(cert.sp_type);
        const divKey  = cert.division_name ? '-' + slugify(cert.division_name) : '';
        const fname   = `${tierKey}-${spKey}${divKey}.png`;
        const path    = `certs/${session_slug}/${cert.member_number}/${fname}`;

        await r2Put(env, path, png);

        await sbInsert(env, 'slate', 'certs', [{
          session_id:      session_id,
          operator_id:     1,
          member_number:   cert.member_number,
          player_first:    cert.player_first || '',
          player_last:     cert.player_last  || '',
          sp_type:         cert.sp_type,
          sp_label:        cert.sp_label,
          division_id:     cert.division_id,
          division_number: cert.division_number,
          division_name:   cert.division_name,
          tier:            cert.tier,
          cert_count:      cert.cert_count,
          r2_path:         path,
        }]);

        generated++;
      } catch (e) {
        errors.push({
          cert: { tier: cert.tier, sp_type: cert.sp_type, member: cert.member_number,
                  division: cert.division_name },
          message: e.message || String(e),
        });
      }
    }

    return jsonResponse({
      ok: errors.length === 0,
      total: queue.length,
      generated,
      errors,
    });
  } catch (e) {
    return jsonResponse({
      ok: false,
      error: e.message || String(e),
      generated,
      errors,
    }, 500);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Endpoint: GET /certs/list
// ══════════════════════════════════════════════════════════════════════
async function handleList(url, env) {
  const session_id = url.searchParams.get('session_id');
  const apa        = url.searchParams.get('apa');
  if (!session_id || !apa) {
    return jsonResponse({ ok: false, error: 'session_id and apa required' }, 400);
  }

  // PatchCheck uses last-5 of APA number as member_number; accept either form
  const memberShort = String(apa).slice(-5);

  const rows = await sbGet(env, 'slate',
    'certs?session_id=eq.' + encodeURIComponent(session_id)
    + '&member_number=eq.' + encodeURIComponent(memberShort)
    + '&select=tier,sp_type,sp_label,cert_count,division_name,r2_path,generated_at'
    + '&order=tier.desc,sp_type.asc');

  // Resolve r2_path → public URL via apa-photos proxy
  const proxy = env.APA_PHOTOS_PROXY || 'https://apa-photos.spmapa.workers.dev';
  const certs = rows.map(r => ({
    tier:          r.tier,
    sp_type:       r.sp_type,
    sp_label:      r.sp_label,
    cert_count:    r.cert_count,
    division_name: r.division_name,
    r2_url:        proxy + '/' + r.r2_path,
    generated_at:  r.generated_at,
    is_landscape:  r.tier !== 'outstanding',
  }));

  return jsonResponse({ ok: true, certs });
}

// ══════════════════════════════════════════════════════════════════════
// Endpoint: GET /certs/sessions?apa=YYYYYYY
//   Returns the list of past sessions for which this player has generated
//   certs. Used by PatchCheck's "Certificates" picker.
// ══════════════════════════════════════════════════════════════════════
async function handleSessions(url, env) {
  const apa = url.searchParams.get('apa');
  if (!apa) return jsonResponse({ ok: false, error: 'apa required' }, 400);
  const memberShort = String(apa).slice(-5);

  // Distinct session_ids with cert rows for this member.
  // Then join sessions for names + start_date.
  const certRows = await sbGet(env, 'slate',
    'certs?member_number=eq.' + encodeURIComponent(memberShort)
    + '&select=session_id'
    + '&order=session_id.desc');

  const seen = new Set();
  const sessionIds = [];
  for (const r of certRows) {
    if (!seen.has(r.session_id)) { seen.add(r.session_id); sessionIds.push(r.session_id); }
  }
  if (sessionIds.length === 0) return jsonResponse({ ok: true, sessions: [] });

  const sessionsRows = await sbGet(env, 'slate',
    'sessions?id=in.(' + sessionIds.join(',') + ')'
    + '&select=id,name,start_date,is_current'
    + '&order=start_date.desc');

  return jsonResponse({ ok: true, sessions: sessionsRows });
}

// ══════════════════════════════════════════════════════════════════════
// Endpoint: GET /certs/count?session_id=X    (for admin preview)
// ══════════════════════════════════════════════════════════════════════
async function handleCount(url, env) {
  const session_id = url.searchParams.get('session_id');
  if (!session_id) return jsonResponse({ ok: false, error: 'session_id required' }, 400);
  const n = await sbRpc(env, 'slate', 'count_session_cert_eligibility',
    { p_session_id: session_id }, false);
  return jsonResponse({ ok: true, count: n });
}

// ── Helpers ──
function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ══════════════════════════════════════════════════════════════════════
// Router
// ══════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');

    try {
      if (path === '/certs/generate' && request.method === 'POST') {
        return await handleGenerate(request, env);
      }
      if (path === '/certs/list' && request.method === 'GET') {
        return await handleList(url, env);
      }
      if (path === '/certs/sessions' && request.method === 'GET') {
        return await handleSessions(url, env);
      }
      if (path === '/certs/count' && request.method === 'GET') {
        return await handleCount(url, env);
      }
      return jsonResponse({ ok: false, error: 'not found: ' + path }, 404);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message || String(e) }, 500);
    }
  },
};
