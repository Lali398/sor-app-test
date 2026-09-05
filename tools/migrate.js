#!/usr/bin/env node
/**
 * tools/migrate.js — Google Sheets -> Supabase (PostgreSQL) adatmigráció
 *
 * Használat:
 *   node tools/migrate.js --dry-run              # csak elemzés, NEM ír semmit
 *   node tools/migrate.js                        # éles futtatás
 *   node tools/migrate.js --only=users,ideas     # csak bizonyos táblák
 *   node tools/migrate.js --truncate             # célt üríti beírás előtt
 *
 * Szükséges környezeti változók (.env.migrate vagy shell export):
 *   SPREADSHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * A script ÍRÁSVÉDETT a Sheets felé: kizárólag olvas.
 * Tetszőleges sokszor újrafuttatható (--truncate mellett).
 */

import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

// ===================== KONFIG =====================

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TRUNCATE = args.includes('--truncate');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').replace('--only=', '')
  .split(',').filter(Boolean);

const {
  SPREADSHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY,
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const CHUNK = 500;

// ===================== SEGÉDFÜGGVÉNYEK =====================

// Ugyanaz a kulcs-normalizálás, mint az api/sheet.js-ben.
const normalizePrivateKey = (raw) => {
  if (!raw) return '';
  let key = String(raw).trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n').trim();
};

/** "3,67" -> 3.67 | "" -> 0 | "abc" -> 0   (magyar tizedesvessző!) */
const num = (v, fallback = 0) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
};

/** "12" -> 12 | "" -> 0 */
const int = (v, fallback = 0) => {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
};

/** 'TRUE' -> true (a Sheetsben szövegként vannak a logikai értékek) */
const bool = (v) => String(v ?? '').trim().toUpperCase() === 'TRUE';

const str = (v, fallback = '') => (v === null || v === undefined ? fallback : String(v));

/** JSON-szöveg cellából jsonb; hibás tartalomnál a megadott alapérték. */
const json = (v, fallback) => {
  if (!v) return fallback;
  try { return JSON.parse(String(v)); } catch { return fallback; }
};

/**
 * "2026-09-05 12:34:56" -> Date (UTC).
 * A sorokat eredetileg new Date().toISOString() írta, tehát UTC-k.
 * Ha nem értelmezhető, null -> a DB default now()-ot használ.
 */
const ts = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

const HEADER_HINTS = new Set([
  'dátum','datum','date','név','nev','name','email','e-mail','beküldő','bekuldo',
  'sör neve','ital neve','típus','tipus','státusz','statusz','tárgy','targy',
  'üzenet','uzenet','ötlet','otlet','kategória','kategoria','jelszó','jelszo'
]);

/** Fejlécnek látszik-e a sor (az első 3 cella ismert fejlécszó)? */
const looksLikeHeader = (row) =>
  (row || []).slice(0, 3).some(c => HEADER_HINTS.has(String(c ?? '').trim().toLowerCase()));

const isEmail = (v) => String(v ?? '').includes('@');

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// ===================== KAPCSOLATOK =====================

function requireEnv() {
  const missing = ['SPREADSHEET_ID','GOOGLE_CLIENT_EMAIL','GOOGLE_PRIVATE_KEY',
                   'SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error('❌ Hiányzó környezeti változó:', missing.join(', '));
    process.exit(1);
  }
  const key = normalizePrivateKey(GOOGLE_PRIVATE_KEY);
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) {
    console.error('❌ A GOOGLE_PRIVATE_KEY nem néz ki érvényes PEM kulcsnak.');
    process.exit(1);
  }
}

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: GOOGLE_CLIENT_EMAIL,
      private_key: normalizePrivateKey(GOOGLE_PRIVATE_KEY)
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] // csak olvasás!
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

const supabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function readSheet(sheets, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  return res.data.values || [];
}

// ===================== TÁBLA-DEFINÍCIÓK =====================
// Minden bejegyzés: honnan olvassunk, mely sor számít adatnak, és
// hogyan képződik le egy Sheets-sor egy Postgres-sorra.

const TABLES = [
  {
    table: 'users',
    range: 'Felhasználók',
    isData: r => isEmail(r[1]),
    map: r => ({
      name: str(r[0]), email: str(r[1]).trim(), password_hash: str(r[2]) || null,
      twofa_secret: str(r[3]) || null, twofa_enabled: bool(r[4]),
      achievements: json(r[5], { unlocked: [] }), badge: str(r[6]),
      recovery_hash: str(r[7]) || null, last_activity_week: str(r[8]) || null,
      current_streak: int(r[9]), longest_streak: int(r[10]),
      google_id: str(r[11]) || null, warnings: json(r[12], []),
      is_banned: bool(r[13]), settings: json(r[14], {})
    })
  },
  {
    table: 'admin_beers',
    range: "'Sör táblázat'!A4:V",
    isData: () => true,
    // Egy Sheets-sorból KETTŐ Postgres-sor lehet (két értékelő egymás mellett).
    expand: (r, i) => {
      const cols = { admin1: 0, admin2: 12 };
      const out = [];
      for (const [ratedBy, o] of Object.entries(cols)) {
        const beerName = str(r[o]).trim();
        if (!beerName) continue;
        out.push({
          rated_by: ratedBy, beer_name: beerName,
          location: str(r[o + 1]), type: str(r[o + 2]) || 'N/A',
          look: num(r[o + 3]), smell: num(r[o + 4]), taste: num(r[o + 5]),
          total_score: num(r[o + 6]), avg: num(r[o + 7]),
          beer_percentage: num(r[o + 8]), date_text: str(r[o + 9]) || null,
          sheet_row: i + 4
        });
      }
      return out;
    }
  },
  {
    table: 'user_beers',
    range: 'Vendég Sör Teszt',
    isData: r => !!str(r[2]).trim(),
    map: r => ({
      beer_uid: str(r[14]) || null, date_text: str(r[0]) || null,
      created_at: ts(r[0]) || new Date().toISOString(),
      submitter_name: str(r[1]), beer_name: str(r[2]), location: str(r[3]), type: str(r[4]),
      look: num(r[5]), smell: num(r[6]), taste: num(r[7]),
      beer_percentage: num(r[8]), total_score: num(r[9]), avg: num(r[10]),
      notes: str(r[11]), approved: str(r[12]) || 'Nem', user_email: str(r[13]).trim()
    })
  },
  {
    table: 'user_drinks',
    range: 'Vendég ital teszt',
    isData: r => !!str(r[2]).trim(),
    map: r => ({
      date_text: str(r[0]) || null, created_at: ts(r[0]) || new Date().toISOString(),
      submitter_name: str(r[1]), drink_name: str(r[2]), category: str(r[3]),
      type: str(r[4]), location: str(r[5]), drink_percentage: num(r[6]),
      look: num(r[7]), smell: num(r[8]), taste: num(r[9]),
      total_score: num(r[10]), avg: num(r[11]), notes: str(r[12]),
      user_email: str(r[13]).trim()
    })
  },
  {
    table: 'ideas',
    range: 'Vendég ötletek!A:H',
    isData: r => !!str(r[1]).trim(),
    map: r => ({
      submitter_name: str(r[0]), idea_text: str(r[1]), time_text: str(r[2]) || null,
      status: str(r[3]) || 'Megcsinálásra vár', date_text: str(r[4]) || null,
      created_at: ts(r[4]) || ts(r[2]) || new Date().toISOString(),
      user_email: str(r[5]).trim(), vote_count: int(r[6]), voters: json(r[7], [])
    })
  },
  {
    table: 'recommendations',
    range: 'Vendég sör ajánló!A:K',
    isData: r => !!str(r[3]).trim(),
    map: r => ({
      date_text: str(r[0]) || null, created_at: ts(r[0]) || new Date().toISOString(),
      name: str(r[1]), user_email: str(r[2]).trim(), item_name: str(r[3]),
      item_type: str(r[4]), description: str(r[5]), is_anonymous: bool(r[6]),
      category: str(r[7]) || 'Egyéb', is_edited: bool(r[8]),
      vote_count: int(r[9]), voters: json(r[10], [])
    })
  },
  {
    table: 'support_tickets',
    range: 'Hibajelentések!A:F',
    isData: r => !!str(r[3]).trim() || !!str(r[4]).trim(),
    map: r => ({
      date_text: str(r[0]) || null, created_at: ts(r[0]) || new Date().toISOString(),
      name: str(r[1]), user_email: str(r[2]).trim(), subject: str(r[3]),
      message: str(r[4]), status: str(r[5]) || 'Új'
    })
  },
  {
    table: 'reports',
    range: 'Jelentések!A:G',
    isData: r => isEmail(r[1]),
    map: r => ({
      date_text: str(r[0]) || null, created_at: ts(r[0]) || new Date().toISOString(),
      reporter_email: str(r[1]).trim(), content_type: str(r[2]), content_id: str(r[3]),
      reported_email: str(r[4]).trim(), reason: str(r[5]), status: str(r[6]) || 'Nyitott'
    })
  },
  {
    table: 'beerpong_records',
    range: 'Sörpong!A:E',
    isData: r => isEmail(r[0]) && !!str(r[2]).trim(),
    map: r => ({
      user_email: str(r[0]).trim(), type: str(r[1]), record_id: str(r[2]),
      date_text: str(r[3]) || null, created_at: ts(r[3]) || new Date().toISOString(),
      payload: json(r[4], {})
    })
  },
  {
    table: 'consumptions',
    range: 'Fogyasztás napló!A:H',
    isData: r => isEmail(r[1]),
    map: r => ({
      date_text: str(r[0]) || null, created_at: ts(r[0]) || new Date().toISOString(),
      user_email: str(r[1]).trim(), beer_name: str(r[2]), beer_uid: str(r[3]) || null,
      qty: num(r[4]), dl_per_glass: num(r[5]), total_dl: num(r[6]), abv: num(r[7])
    })
  },
  {
    table: 'winners',
    range: 'Nyertesek',
    isData: r => (r || []).some(c => str(c).trim() !== ''),
    // Ezt a lapot a kód sehol nem olvassa, ezért nyersen, veszteségmentesen visszük.
    map: r => ({ user_email: str(r[2]).trim() || null, row_data: (r || []).map(c => str(c)) })
  }
];

// ===================== FUTTATÁS =====================

async function main() {
  requireEnv();
  const sheets = await getSheets();
  const db = supabase();

  console.log(DRY_RUN
    ? '🔍 SZÁRAZ FUTÁS — semmit nem írok az adatbázisba.\n'
    : '🚀 ÉLES FUTÁS — írok a Supabase-be.\n');

  const summary = [];
  const emails = new Set();

  const targets = TABLES.filter(t => ONLY.length === 0 || ONLY.includes(t.table));
  if (ONLY.length) console.log('Csak ezek:', targets.map(t => t.table).join(', '), '\n');

  for (const def of targets) {
    process.stdout.write(`▶ ${def.table.padEnd(18)} `);

    let raw;
    try {
      raw = await readSheet(sheets, def.range);
    } catch (e) {
      console.log(`⚠️  nem olvasható (${def.range}): ${e.message}`);
      summary.push({ tabla: def.table, sheets: '-', beszurt: 0, megjegyzes: 'olvasási hiba' });
      continue;
    }

    // Fejléc + üres + nem-adat sorok kiszűrése
    const dataRows = raw.filter((r, i) => {
      if (i === 0 && looksLikeHeader(r)) return false;
      if (!r || r.every(c => str(c).trim() === '')) return false;
      return def.isData(r);
    });

    const rows = def.expand
      ? dataRows.flatMap((r, i) => def.expand(r, i))
      : dataRows.map(def.map);

    if (def.table === 'users') rows.forEach(u => emails.add(u.email));

    const skipped = raw.length - dataRows.length;

    if (DRY_RUN) {
      console.log(`${String(rows.length).padStart(5)} sor  (kihagyva: ${skipped})`);
      if (rows.length) {
        const sample = { ...rows[0] };
        if (sample.password_hash) sample.password_hash = '***';
        if (sample.twofa_secret) sample.twofa_secret = '***';
        if (sample.recovery_hash) sample.recovery_hash = '***';
        console.log('   minta:', JSON.stringify(sample).slice(0, 220));
      }
      summary.push({ tabla: def.table, sheets: raw.length, beszurt: rows.length, megjegyzes: `kihagyva ${skipped}` });
      continue;
    }

    if (TRUNCATE) {
      const { error } = await db.from(def.table).delete().neq('id', -1);
      if (error) { console.log(`❌ ürítés: ${error.message}`); continue; }
    }

    let inserted = 0, failed = 0;
    for (const part of chunk(rows, CHUNK)) {
      const { error } = await db.from(def.table).insert(part);
      if (error) {
        failed += part.length;
        console.log(`\n   ❌ ${error.message}`);
      } else {
        inserted += part.length;
      }
    }
    console.log(`${String(inserted).padStart(5)} beszúrva` + (failed ? `, ${failed} HIBÁS` : '') + `  (kihagyva: ${skipped})`);
    summary.push({ tabla: def.table, sheets: raw.length, beszurt: inserted, megjegyzes: failed ? `${failed} hibás` : 'ok' });
  }

  // ---- Árva sorok riportja (a sql/02_constraints.sql előfeltétele) ----
  if (emails.size) {
    console.log('\n── Árva sorok (nincs hozzájuk felhasználó) ──');
    for (const t of ['user_beers','user_drinks','consumptions','beerpong_records']) {
      const def = TABLES.find(x => x.table === t);
      if (!targets.includes(def)) continue;
      try {
        const rows = await readSheet(sheets, def.range);
        const orphans = new Set();
        rows.forEach((r, i) => {
          if (i === 0 && looksLikeHeader(r)) return;
          if (!def.isData(r)) return;
          const e = def.map(r).user_email;
          if (e && !emails.has(e)) orphans.add(e);
        });
        console.log(`   ${t.padEnd(18)} ${orphans.size ? [...orphans].join(', ') : '✅ nincs'}`);
      } catch { /* a tábla olvasási hibáját fent már jeleztük */ }
    }
  }

  console.log('\n── Összegzés ──');
  console.table(summary);
  console.log(DRY_RUN
    ? '\n✅ Száraz futás kész. Ha a számok stimmelnek, futtasd --dry-run nélkül.'
    : '\n✅ Kész. Ellenőrizd a Supabase Table Editorban, majd futtasd a sql/02_constraints.sql-t.');
}

// Csak közvetlen futtatáskor induljon el (teszteléshez importálható maradjon).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('\n💥 Végzetes hiba:', e); process.exit(1); });
}

export { TABLES, num, int, bool, str, json, ts, looksLikeHeader, normalizePrivateKey };
