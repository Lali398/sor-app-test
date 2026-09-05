// api/sheet.js — PostgreSQL (Supabase) verzió
//
// Ugyanaz a végpont, ugyanazok az action-nevek, ugyanazok a válaszformátumok,
// mint a Google Sheets-es változatban — ezért a frontend (js.js, beerpong.js)
// EGYETLEN sora sem változik.
//
// Szükséges env-változók a Vercelben:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   <- ÚJ
//   JWT_SECRET, ADMIN_PIN, GOOGLE_CLIENT_ID, TWOFA_ENC_KEY   <- változatlan
// A GOOGLE_* / SPREADSHEET_ID változókra ennek a fájlnak már nincs szüksége.

import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';

// === ADATBÁZIS KAPCSOLAT ===
// A service_role kulcs megkerüli az RLS-t. Ez a fájl kizárólag szerveroldalon fut.
let _db = null;
const db = () => {
    if (!_db) {
        _db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
    }
    return _db;
};

// Supabase hibából dobunk kivételt, hogy a handler catch-e egységesen kezelje.
const must = (res) => {
    if (res.error) throw new Error(res.error.message || 'Adatbázis hiba');
    return res.data;
};

// Teszthorog: a tools/api.test.mjs ezen keresztül cserél memóriabeli adatbázist.
// Éles futásban soha nem hívódik meg.
export const __setDbForTests = (client) => { _db = client; };

// === SEGÉDFÜGGVÉNYEK ===

const verifyUser = (req) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new Error('Hiányzó vagy érvénytelen authentikációs token');
    }
    const token = authHeader.split(' ')[1];
    return jwt.verify(token, process.env.JWT_SECRET);
};

// A Sheets-verzió a dátumot "2026-09-05 12:34:56" alakban tárolta és így is
// adta vissza a frontendnek. Ezt megtartjuk, hogy a megjelenítés ne változzon.
const nowText = () => new Date().toISOString().replace('T', ' ').substring(0, 19);

// A pontátlagot a Sheets magyar tizedesvesszővel tárolta ("5,00").
// Az adatbázisban numeric, de a beírt formátum ugyanaz marad számként.
const avgOf = (total) => Number((total / 3).toFixed(2));

const numOr0 = (v) => {
    const n = parseFloat(String(v ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
};

// === 2FA TITKOS KULCS TITKOSÍTÁSA (AES-256-GCM) ===
// Változatlan a Sheets-verzióhoz képest, hogy a meglévő kulcsok működjenek.
const TWOFA_ENC_PREFIX = 'enc:v1:';
const get2FAKey = () => crypto.createHash('sha256')
    .update(String(process.env.TWOFA_ENC_KEY || process.env.JWT_SECRET || ''))
    .digest();

const encrypt2FASecret = (plain) => {
    if (!plain) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', get2FAKey(), iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return TWOFA_ENC_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
};

const decrypt2FASecret = (stored) => {
    if (!stored) return '';
    if (!String(stored).startsWith(TWOFA_ENC_PREFIX)) return stored; // régi, titkosítatlan
    try {
        const data = Buffer.from(String(stored).slice(TWOFA_ENC_PREFIX.length), 'base64');
        const iv = data.subarray(0, 12);
        const tag = data.subarray(12, 28);
        const enc = data.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', get2FAKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    } catch (e) {
        console.error('2FA decrypt error:', e);
        return '';
    }
};

// === PUBLIKUS PROFIL SEGÉDFÜGGVÉNYEK (változatlan logika) ===

const getPublicId = (email, secret) => crypto.createHmac('sha256', secret)
    .update(String(email).trim().toLowerCase())
    .digest('hex')
    .substring(0, 12);

// A settings már jsonb, de a régi kompatibilitás kedvéért stringet is elfogad.
const parseUserSettings = (raw) => {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (e) { return {}; }
};

const isProfilePublic = (s) => s.publicProfileOptIn === true || s.publicProfileOptIn === 'true';

const asArray = (v) => Array.isArray(v) ? v : (typeof v === 'string' ? (() => {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; }
})() : []);

const asObject = (v, fallback) => {
    if (v && typeof v === 'object') return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return fallback; } }
    return fallback;
};

// === STREAK ===

const getYearWeek = (date) => {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

// A Sheets-verzióban ez 2 teljes laplekérés + 1 írás volt. Most 1 olvasás + 1 írás.
async function updateUserStreak(userEmail) {
    try {
        const rows = must(await db().from('users')
            .select('last_activity_week,current_streak,longest_streak')
            .eq('email', userEmail).limit(1));
        if (!rows || rows.length === 0) return null;

        const u = rows[0];
        const currentYearWeek = getYearWeek(new Date());
        let currentStreak = u.current_streak || 0;
        let longestStreak = u.longest_streak || 0;

        if (u.last_activity_week === currentYearWeek) {
            return { currentStreak, longestStreak, isNew: false };
        }

        const d = new Date();
        d.setDate(d.getDate() - 7);
        const previousWeek = getYearWeek(d);

        currentStreak = (u.last_activity_week === previousWeek) ? currentStreak + 1 : 1;
        if (currentStreak > longestStreak) longestStreak = currentStreak;

        must(await db().from('users').update({
            last_activity_week: currentYearWeek,
            current_streak: currentStreak,
            longest_streak: longestStreak
        }).eq('email', userEmail));

        return { currentStreak, longestStreak, isNew: true };
    } catch (e) {
        console.error('Streak update error:', e);
        return null;
    }
}

// === FELHASZNÁLÓ -> FRONTEND OBJEKTUM ===
// Pontosan ugyanazok a mezők, mint a Sheets-verzióban.
const toUserObject = (u, has2FA) => ({
    name: u.name,
    email: u.email,
    has2FA: has2FA,
    achievements: asObject(u.achievements, { unlocked: [] }),
    badge: u.badge || '',
    streak: { current: u.current_streak || 0, longest: u.longest_streak || 0 },
    isGoogleLinked: !!u.google_id,
    settings: asObject(u.settings, {})
});

// === ÉRTÉKELÉSI STATISZTIKA (toplista + publikus profil) ===
// Ugyanaz a számítás, mint korábban, csak már szűrt adaton dolgozik.
const buildRatingStats = (beerRows, drinkRows) => {
    const stats = {};
    const ensure = (email) => {
        if (!stats[email]) {
            stats[email] = { beerCount: 0, drinkCount: 0, sumAvg: 0, beers: [], drinks: [], types: {}, locations: {}, firstDate: null };
        }
        return stats[email];
    };

    (beerRows || []).forEach(r => {
        const email = r.user_email;
        if (!email || !email.includes('@') || !r.beer_name) return;
        const s = ensure(email);
        const avg = numOr0(r.avg);
        s.beerCount++;
        s.sumAvg += avg;
        s.beers.push({ name: r.beer_name, type: r.type || 'N/A', avg });
        if (r.type) s.types[r.type] = (s.types[r.type] || 0) + 1;
        if (r.location) s.locations[r.location] = (s.locations[r.location] || 0) + 1;
        if (r.date_text && (!s.firstDate || r.date_text < s.firstDate)) s.firstDate = r.date_text;
    });

    (drinkRows || []).forEach(r => {
        const email = r.user_email;
        if (!email || !email.includes('@') || !r.drink_name) return;
        const s = ensure(email);
        const avg = numOr0(r.avg);
        s.drinkCount++;
        s.sumAvg += avg;
        s.drinks.push({ name: r.drink_name, type: r.type || r.category || 'N/A', avg });
        if (r.date_text && (!s.firstDate || r.date_text < s.firstDate)) s.firstDate = r.date_text;
    });

    return stats;
};

// === FŐ HANDLER ===
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: `Method ${req.method} Not Allowed` });

    const { action } = req.body;
    const JWT_SECRET = process.env.JWT_SECRET;

    const missingEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET']
        .filter(name => !process.env[name]);
    if (missingEnv.length > 0) {
        return res.status(500).json({
            error: `Szerveroldali konfigurációs hiba: hiányzó környezeti változó (${missingEnv.join(', ')}). Ellenőrizd a Vercel projekt Settings > Environment Variables részét, majd deployolj újra.`
        });
    }

    try {
        switch (action) {

            // === ADMIN BELÉPÉS + ADMIN SÖRÖK ===
            case 'GET_DATA': {
                const { pin } = req.body;
                const correctPin = process.env.ADMIN_PIN;
                if (!correctPin) return res.status(500).json({ error: 'Szerver hiba: Nincs beállítva PIN.' });

                if (String(pin).trim() !== String(correctPin).trim()) {
                    await new Promise(r => setTimeout(r, 2000)); // brute-force lassítás
                    return res.status(401).json({ error: 'Hibás PIN kód!' });
                }

                const adminToken = jwt.sign(
                    { email: 'admin@sortablazat.hu', name: 'Admin', isAdmin: true },
                    JWT_SECRET, { expiresIn: '1d' }
                );

                const rows = must(await db().from('admin_beers')
                    .select('rated_by,beer_name,type,location,beer_percentage,look,smell,taste,total_score,avg,date_text')
                    .order('id', { ascending: true }));

                const beers = (rows || []).map(r => ({
                    id: `${r.rated_by}-${String(r.beer_name).replace(/\s+/g, '-')}-${r.date_text || ''}`,
                    beerName: r.beer_name,
                    type: r.type || 'N/A',
                    location: r.location || '',
                    beerPercentage: numOr0(r.beer_percentage),
                    look: parseInt(r.look) || 0,
                    smell: parseInt(r.smell) || 0,
                    taste: parseInt(r.taste) || 0,
                    totalScore: parseInt(r.total_score) || 0,
                    avg: numOr0(r.avg),
                    date: r.date_text || null,
                    ratedBy: r.rated_by
                }));

                return res.status(200).json({ beers, users: [], adminToken });
            }

            // === REGISZTRÁCIÓ ===
            case 'REGISTER_USER': {
                const { name, email, password } = req.body;
                if (!name || !email || !password) return res.status(400).json({ error: "Minden mező kitöltése kötelező!" });

                const passwordRegex = /^(?=.*[0-9])(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;
                if (!passwordRegex.test(password)) {
                    return res.status(400).json({ error: "A jelszó gyenge! (Min. 8 karakter, 1 szám, 1 spec. karakter)" });
                }

                const hashedPassword = await bcrypt.hash(password, 10);
                const recoveryCode = Math.random().toString(36).slice(-8).toUpperCase();
                const hashedRecovery = await bcrypt.hash(recoveryCode, 10);

                // A UNIQUE megszorítás miatt itt már nincs versenyhelyzet:
                // két egyidejű regisztrációból a másodikat az adatbázis utasítja el.
                const ins = await db().from('users').insert([{
                    name, email,
                    password_hash: hashedPassword,
                    twofa_secret: '', twofa_enabled: false,
                    achievements: { unlocked: [] },
                    badge: '',
                    recovery_hash: hashedRecovery
                }]);

                if (ins.error) {
                    if (String(ins.error.code) === '23505' || /duplicate key/i.test(ins.error.message || '')) {
                        return res.status(409).json({ error: "Ez az e-mail cím már regisztrálva van." });
                    }
                    throw new Error(ins.error.message);
                }

                return res.status(201).json({ message: "Sikeres regisztráció!", recoveryCode });
            }

            // === JELSZÓ HELYREÁLLÍTÁS ===
            case 'RESET_PASSWORD': {
                const { email, recoveryCode, newPassword } = req.body;
                if (!email || !recoveryCode || !newPassword) return res.status(400).json({ error: "Hiányzó adatok!" });

                const rows = must(await db().from('users')
                    .select('id,recovery_hash').eq('email', email).limit(1));
                if (!rows || rows.length === 0) return res.status(404).json({ error: "Nincs ilyen felhasználó." });

                const storedRecoveryHash = rows[0].recovery_hash;
                if (!storedRecoveryHash) return res.status(400).json({ error: "Ehhez a fiókhoz nincs beállítva helyreállító kód." });

                const isCodeValid = await bcrypt.compare(recoveryCode, storedRecoveryHash);
                if (!isCodeValid) return res.status(401).json({ error: "Hibás helyreállító kód!" });

                must(await db().from('users')
                    .update({ password_hash: await bcrypt.hash(newPassword, 10) })
                    .eq('id', rows[0].id));

                return res.status(200).json({ message: "Jelszó sikeresen megváltoztatva! Most már beléphetsz." });
            }

            // === BEJELENTKEZÉS ===
            // Korábban: a TELJES Felhasználók lap letöltése minden belépésnél.
            // Most: egyetlen indexelt lekérdezés.
            case 'LOGIN_USER': {
                const { email, password } = req.body;
                const rows = must(await db().from('users').select('*').eq('email', email).limit(1));
                if (!rows || rows.length === 0) return res.status(401).json({ error: "Hibás e-mail cím vagy jelszó." });

                const u = rows[0];
                const isPasswordValid = await bcrypt.compare(password, u.password_hash || '');
                if (!isPasswordValid) return res.status(401).json({ error: "Hibás e-mail cím vagy jelszó." });

                if (u.is_banned) {
                    return res.status(403).json({ error: "A fiókod fel lett függesztve a szabályzat megsértése miatt. 🚫" });
                }

                if (u.twofa_enabled) {
                    return res.status(200).json({ require2fa: true, tempEmail: email });
                }

                const user = toUserObject(u, false);
                const token = jwt.sign(user, JWT_SECRET, { expiresIn: '1d' });
                return res.status(200).json({ token, user });
            }

            case 'VERIFY_2FA_LOGIN': {
                const { email, token: inputToken } = req.body;
                const rows = must(await db().from('users').select('*').eq('email', email).limit(1));
                if (!rows || rows.length === 0) return res.status(401).json({ error: "Hiba az azonosításban." });

                const u = rows[0];
                if (u.is_banned) return res.status(403).json({ error: "A fiókod fel lett függesztve. 🚫" });

                const secret = decrypt2FASecret(u.twofa_secret);
                if (!authenticator.check(inputToken, secret)) {
                    return res.status(401).json({ error: "Érvénytelen 2FA kód!" });
                }

                const user = toUserObject(u, true);
                const jwtToken = jwt.sign(user, JWT_SECRET, { expiresIn: '1d' });
                return res.status(200).json({ token: jwtToken, user });
            }

            case 'MANAGE_2FA': {
                const userData = verifyUser(req);
                const { subAction, code, secret } = req.body;

                if (subAction === 'GENERATE') {
                    const newSecret = authenticator.generateSecret();
                    const otpauth = authenticator.keyuri(userData.email, 'SorTablazat', newSecret);
                    const qrImageUrl = await QRCode.toDataURL(otpauth);
                    return res.status(200).json({ secret: newSecret, qrCode: qrImageUrl });
                }

                if (subAction === 'ENABLE') {
                    if (!authenticator.check(code, secret)) {
                        return res.status(400).json({ error: "Hibás kód! Próbáld újra." });
                    }
                    const upd = must(await db().from('users')
                        .update({ twofa_secret: encrypt2FASecret(secret), twofa_enabled: true })
                        .eq('email', userData.email).select('id'));
                    if (!upd || upd.length === 0) return res.status(404).json({ error: "Felhasználó nem található." });
                    return res.status(200).json({ message: "2FA sikeresen bekapcsolva!" });
                }

                if (subAction === 'DISABLE') {
                    const upd = must(await db().from('users')
                        .update({ twofa_secret: '', twofa_enabled: false })
                        .eq('email', userData.email).select('id'));
                    if (!upd || upd.length === 0) return res.status(404).json({ error: "Felhasználó nem található." });
                    return res.status(200).json({ message: "2FA kikapcsolva." });
                }

                return res.status(400).json({ error: "Ismeretlen művelet." });
            }

            case 'CHANGE_PASSWORD': {
                const userData = verifyUser(req);
                const { oldPassword, newPassword } = req.body;
                if (!oldPassword || !newPassword) return res.status(400).json({ error: "Minden mező kitöltése kötelező!" });

                const rows = must(await db().from('users')
                    .select('id,password_hash').eq('email', userData.email).limit(1));
                if (!rows || rows.length === 0) return res.status(404).json({ error: "Felhasználó nem található." });

                const isPasswordValid = await bcrypt.compare(oldPassword, rows[0].password_hash || '');
                if (!isPasswordValid) return res.status(401).json({ error: "A jelenlegi jelszó hibás." });

                must(await db().from('users')
                    .update({ password_hash: await bcrypt.hash(newPassword, 10) })
                    .eq('id', rows[0].id));

                return res.status(200).json({ message: "Jelszó sikeresen módosítva!" });
            }

            case 'REFRESH_USER_DATA': {
                const userData = verifyUser(req);
                const rows = must(await db().from('users')
                    .select('current_streak,longest_streak,achievements,badge,settings')
                    .eq('email', userData.email).limit(1));
                if (!rows || rows.length === 0) return res.status(404).json({ error: "User not found" });

                const u = rows[0];
                return res.status(200).json({
                    streak: { current: u.current_streak || 0, longest: u.longest_streak || 0 },
                    achievements: asObject(u.achievements, { unlocked: [] }),
                    badge: u.badge || '',
                    settings: asObject(u.settings, {})
                });
            }

            case 'SAVE_SETTINGS': {
                const userData = verifyUser(req);
                const { settings } = req.body;
                if (!settings) return res.status(400).json({ error: "Nincs beállítás adat." });

                const upd = must(await db().from('users')
                    .update({ settings }).eq('email', userData.email).select('id'));
                if (!upd || upd.length === 0) return res.status(404).json({ error: "Felhasználó nem található." });

                return res.status(200).json({ message: "Beállítások mentve." });
            }

            case 'UPDATE_ACHIEVEMENTS': {
                const userData = verifyUser(req);
                const { achievements, badge } = req.body;
                if (!achievements || typeof achievements !== 'object') {
                    return res.status(400).json({ error: "Hibás achievements formátum!" });
                }

                const badgeValue = badge || '';
                const upd = must(await db().from('users')
                    .update({ achievements, badge: badgeValue })
                    .eq('email', userData.email).select('id'));
                if (!upd || upd.length === 0) return res.status(404).json({ error: "Felhasználó nem található." });

                return res.status(200).json({
                    message: "Achievements sikeresen mentve!",
                    achievements,
                    badge: badgeValue
                });
            }

            case 'GET_ACHIEVEMENTS': {
                const userData = verifyUser(req);
                const rows = must(await db().from('users')
                    .select('achievements,badge').eq('email', userData.email).limit(1));
                if (!rows || rows.length === 0) return res.status(404).json({ error: "Felhasználó nem található." });

                return res.status(200).json({
                    achievements: asObject(rows[0].achievements, { unlocked: [] }),
                    badge: rows[0].badge || ''
                });
            }

            // ==========================================================
            // === SÖRÖK ===
            // A frontend `index`-e a FELHASZNÁLÓ SAJÁT listájában elfoglalt
            // pozíció (a modálok tömbindexként használják), ezért itt
            // mindenhol ugyanaz a rendezés: id szerint növekvő = beküldési sorrend.
            // ==========================================================

            case 'GET_USER_BEERS': {
                const userData = verifyUser(req);
                const rows = must(await db().from('user_beers')
                    .select('*').eq('user_email', userData.email).order('id', { ascending: true }));

                // Régi soroknál pótoljuk a hiányzó stabil azonosítót (a Sheets-verzió is ezt tette),
                // és átvezetjük a fogyasztásnaplóra is, hogy a statisztika ne szakadjon el.
                const missing = (rows || []).filter(r => !r.beer_uid);
                if (missing.length > 0) {
                    const oldToNew = {};
                    for (const r of missing) {
                        const newId = `${Date.now()}${r.id}-${Math.random().toString(36).slice(2, 8)}`;
                        const oldFallbackId = `user-${String(r.beer_name || '').replace(/\s+/g, '-')}-${r.date_text || ''}`;
                        oldToNew[oldFallbackId] = newId;
                        r.beer_uid = newId;
                        must(await db().from('user_beers').update({ beer_uid: newId }).eq('id', r.id));
                    }
                    for (const [oldId, newId] of Object.entries(oldToNew)) {
                        await db().from('consumptions')
                            .update({ beer_uid: newId })
                            .eq('user_email', userData.email).eq('beer_uid', oldId);
                    }
                }

                const userBeers = (rows || []).map(r => ({
                    id: r.beer_uid,
                    date: r.date_text,
                    beerName: r.beer_name,
                    location: r.location,
                    type: r.type,
                    look: r.look || 0,
                    smell: r.smell || 0,
                    taste: r.taste || 0,
                    beerPercentage: r.beer_percentage || 0,
                    totalScore: r.total_score || 0,
                    avg: r.avg || 0,
                    notes: r.notes || ''
                }));

                return res.status(200).json(userBeers);
            }

            case 'ADD_USER_BEER': {
                const userData = verifyUser(req);
                const { beerName, type, location, beerPercentage, look, smell, taste, notes } = req.body;

                const numLook = parseFloat(look) || 0;
                const numSmell = parseFloat(smell) || 0;
                const numTaste = parseFloat(taste) || 0;
                const totalScore = numLook + numSmell + numTaste;

                must(await db().from('user_beers').insert([{
                    beer_uid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    date_text: nowText(),
                    submitter_name: userData.name,
                    beer_name: beerName,
                    location: location || '',
                    type: type || '',
                    look: numLook, smell: numSmell, taste: numTaste,
                    beer_percentage: parseFloat(beerPercentage) || 0,
                    total_score: totalScore,
                    avg: avgOf(totalScore),
                    notes: notes || '',
                    approved: 'Nem',
                    user_email: userData.email
                }]));

                await updateUserStreak(userData.email);
                return res.status(201).json({ message: "Sikeres hozzáadás! (Streak frissítve)" });
            }

            case 'EDIT_USER_BEER': {
                const userData = verifyUser(req);
                const { index, beerName, type, location, beerPercentage, look, smell, taste, notes } = req.body;

                const rows = must(await db().from('user_beers')
                    .select('id').eq('user_email', userData.email).order('id', { ascending: true }));
                if (index < 0 || index >= (rows || []).length) {
                    return res.status(400).json({ error: "Érvénytelen index" });
                }

                const numLook = parseFloat(look) || 0;
                const numSmell = parseFloat(smell) || 0;
                const numTaste = parseFloat(taste) || 0;
                const totalScore = numLook + numSmell + numTaste;

                must(await db().from('user_beers').update({
                    submitter_name: userData.name,
                    beer_name: beerName,
                    location: location || '',
                    type: type || '',
                    look: numLook, smell: numSmell, taste: numTaste,
                    beer_percentage: parseFloat(beerPercentage) || 0,
                    total_score: totalScore,
                    avg: avgOf(totalScore),
                    notes: notes || ''
                }).eq('id', rows[index].id));

                return res.status(200).json({ message: "Sör sikeresen módosítva!" });
            }

            // Korábban: a teljes lap törlése (values.clear) és visszaírása.
            // Most: egyetlen sor törlése, atomi művelet.
            case 'DELETE_USER_BEER': {
                const userData = verifyUser(req);
                const { index } = req.body;

                const rows = must(await db().from('user_beers')
                    .select('id').eq('user_email', userData.email).order('id', { ascending: true }));
                if (index < 0 || index >= (rows || []).length) {
                    return res.status(400).json({ error: "Érvénytelen index" });
                }

                must(await db().from('user_beers').delete().eq('id', rows[index].id));
                return res.status(200).json({ message: "Sör sikeresen törölve!" });
            }

            // ==========================================================
            // === ITALOK ===
            // ==========================================================

            case 'GET_USER_DRINKS': {
                const userData = verifyUser(req);
                const rows = must(await db().from('user_drinks')
                    .select('*').eq('user_email', userData.email).order('id', { ascending: true }));

                const userDrinks = (rows || []).map(r => ({
                    date: r.date_text,
                    drinkName: r.drink_name,
                    category: r.category,
                    type: r.type,
                    location: r.location,
                    drinkPercentage: r.drink_percentage || 0,
                    look: r.look || 0,
                    smell: r.smell || 0,
                    taste: r.taste || 0,
                    totalScore: r.total_score || 0,
                    avg: r.avg || 0,
                    notes: r.notes || ''
                }));

                return res.status(200).json(userDrinks);
            }

            case 'ADD_USER_DRINK': {
                const userData = verifyUser(req);
                const { drinkName, category, type, location, drinkPercentage, look, smell, taste, notes } = req.body;

                const numLook = parseFloat(look) || 0;
                const numSmell = parseFloat(smell) || 0;
                const numTaste = parseFloat(taste) || 0;
                const totalScore = numLook + numSmell + numTaste;

                must(await db().from('user_drinks').insert([{
                    date_text: nowText(),
                    submitter_name: userData.name,
                    drink_name: drinkName,
                    category: category || '',
                    type: type || '',
                    location: location || '',
                    drink_percentage: parseFloat(drinkPercentage) || 0,
                    look: numLook, smell: numSmell, taste: numTaste,
                    total_score: totalScore,
                    avg: avgOf(totalScore),
                    notes: notes || '',
                    user_email: userData.email
                }]));

                await updateUserStreak(userData.email);
                return res.status(201).json({ message: "Sikeres hozzáadás! (Streak frissítve)" });
            }

            case 'EDIT_USER_DRINK': {
                const userData = verifyUser(req);
                const { index, drinkName, category, type, location, drinkPercentage, look, smell, taste, notes } = req.body;

                const rows = must(await db().from('user_drinks')
                    .select('id').eq('user_email', userData.email).order('id', { ascending: true }));
                if (index < 0 || index >= (rows || []).length) {
                    return res.status(400).json({ error: "Érvénytelen index" });
                }

                const numLook = parseFloat(look) || 0;
                const numSmell = parseFloat(smell) || 0;
                const numTaste = parseFloat(taste) || 0;
                const totalScore = numLook + numSmell + numTaste;

                must(await db().from('user_drinks').update({
                    submitter_name: userData.name,
                    drink_name: drinkName,
                    category: category || '',
                    type: type || '',
                    location: location || '',
                    drink_percentage: parseFloat(drinkPercentage) || 0,
                    look: numLook, smell: numSmell, taste: numTaste,
                    total_score: totalScore,
                    avg: avgOf(totalScore),
                    notes: notes || ''
                }).eq('id', rows[index].id));

                return res.status(200).json({ message: "Ital sikeresen módosítva!" });
            }

            case 'DELETE_USER_DRINK': {
                const userData = verifyUser(req);
                const { index } = req.body;

                const rows = must(await db().from('user_drinks')
                    .select('id').eq('user_email', userData.email).order('id', { ascending: true }));
                if (index < 0 || index >= (rows || []).length) {
                    return res.status(400).json({ error: "Érvénytelen index" });
                }

                must(await db().from('user_drinks').delete().eq('id', rows[index].id));
                return res.status(200).json({ message: "Ital sikeresen törölve!" });
            }

            // ==========================================================
            // === FOGYASZTÁS NAPLÓ ===
            // ==========================================================

            case 'ADD_CONSUMPTION': {
                const userData = verifyUser(req);
                const { beerName, beerId, qty, dlPerGlass, totalDl, abv } = req.body;

                const owned = must(await db().from('user_beers')
                    .select('id').eq('user_email', userData.email).eq('beer_name', beerName).limit(1));
                if (!owned || owned.length === 0) {
                    return res.status(403).json({ error: "Ez a sör nem a te listádban szerepel." });
                }

                must(await db().from('consumptions').insert([{
                    date_text: nowText(),
                    user_email: userData.email,
                    beer_name: beerName,
                    beer_uid: beerId || null,
                    qty: numOr0(qty),
                    dl_per_glass: numOr0(dlPerGlass),
                    total_dl: numOr0(totalDl),
                    abv: numOr0(abv)
                }]));

                return res.status(201).json({ message: 'Fogyasztás rögzítve!' });
            }

            case 'GET_CONSUMPTIONS': {
                const userData = verifyUser(req);
                const rows = must(await db().from('consumptions')
                    .select('*').eq('user_email', userData.email).order('id', { ascending: true }));

                const map = {};
                (rows || []).forEach(r => {
                    const key = r.beer_uid;
                    if (!map[key]) map[key] = { count: 0, totalDl: 0 };
                    map[key].count += parseInt(r.qty) || 0;
                    map[key].totalDl += parseInt(r.total_dl) || 0;
                });

                const entries = (rows || []).map(r => ({
                    date: r.date_text,
                    beerName: r.beer_name,
                    beerId: r.beer_uid,
                    qty: parseInt(r.qty) || 0,
                    dlPerGlass: parseInt(r.dl_per_glass) || 0,
                    totalDl: parseInt(r.total_dl) || 0,
                    abv: numOr0(r.abv)
                }));

                return res.status(200).json({ map, entries });
            }

            // ==========================================================
            // === ADATIMPORT (duplikátum-szűréssel) ===
            // ==========================================================

            case 'IMPORT_USER_DATA': {
                const userData = verifyUser(req);
                const { beers, drinks } = req.body;

                if ((!beers || beers.length === 0) && (!drinks || drinks.length === 0)) {
                    return res.status(400).json({ error: "Nincs importálható adat!" });
                }

                const normalizeDateToString = (date) => {
                    if (!date) return '';
                    if (typeof date === 'string') {
                        if (date.includes('T')) return date.substring(0, 10);
                        if (date.includes('.')) {
                            const parts = date.split('.').map(p => p.trim()).filter(Boolean);
                            if (parts.length >= 3) {
                                return `${parts[0].padStart(4, '0')}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
                            }
                        }
                        return date.substring(0, 10);
                    }
                    if (date instanceof Date) return date.toISOString().substring(0, 10);
                    if (typeof date === 'number') {
                        const excelEpoch = new Date(1900, 0, 1);
                        return new Date(excelEpoch.getTime() + (date - 2) * 86400000).toISOString().substring(0, 10);
                    }
                    return '';
                };

                let addedBeersCount = 0, addedDrinksCount = 0, skippedCount = 0;

                if (beers && beers.length > 0) {
                    const existing = must(await db().from('user_beers')
                        .select('date_text,beer_name,location,total_score').eq('user_email', userData.email));

                    const fp = (date, name, loc, score) =>
                        `${normalizeDateToString(date)}|${String(name || '').trim().toLowerCase()}|${String(loc || '').trim().toLowerCase()}|${score}`;
                    const seen = new Set((existing || []).map(r => fp(r.date_text, r.beer_name, r.location, r.total_score)));

                    const newRows = [];
                    beers.forEach(beer => {
                        const look = parseFloat(beer.look) || 0;
                        const smell = parseFloat(beer.smell) || 0;
                        const taste = parseFloat(beer.taste) || 0;
                        const totalScore = look + smell + taste;
                        const dateStr = beer.date
                            ? normalizeDateToString(beer.date) + ' 12:00:00'
                            : nowText();

                        const key = fp(dateStr, beer.beerName, beer.location || '', totalScore);
                        if (seen.has(key)) { skippedCount++; return; }
                        seen.add(key);

                        newRows.push({
                            beer_uid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${newRows.length}`,
                            date_text: dateStr,
                            submitter_name: userData.name,
                            beer_name: beer.beerName,
                            location: beer.location || '',
                            type: beer.type || '',
                            look, smell, taste,
                            beer_percentage: parseFloat(beer.beerPercentage) || 0,
                            total_score: totalScore,
                            avg: avgOf(totalScore),
                            notes: beer.notes || '',
                            approved: 'Nem',
                            user_email: userData.email
                        });
                        addedBeersCount++;
                    });

                    if (newRows.length > 0) must(await db().from('user_beers').insert(newRows));
                }

                if (drinks && drinks.length > 0) {
                    const existing = must(await db().from('user_drinks')
                        .select('date_text,drink_name,category,total_score').eq('user_email', userData.email));

                    const fp = (date, name, cat, score) =>
                        `${normalizeDateToString(date)}|${String(name || '').trim().toLowerCase()}|${String(cat || '').trim().toLowerCase()}|${score}`;
                    const seen = new Set((existing || []).map(r => fp(r.date_text, r.drink_name, r.category, r.total_score)));

                    const newRows = [];
                    drinks.forEach(drink => {
                        const look = parseFloat(drink.look) || 0;
                        const smell = parseFloat(drink.smell) || 0;
                        const taste = parseFloat(drink.taste) || 0;
                        const totalScore = look + smell + taste;
                        const dateStr = drink.date
                            ? normalizeDateToString(drink.date) + ' 12:00:00'
                            : nowText();

                        const key = fp(dateStr, drink.drinkName, drink.category || 'Egyéb', totalScore);
                        if (seen.has(key)) { skippedCount++; return; }
                        seen.add(key);

                        newRows.push({
                            date_text: dateStr,
                            submitter_name: userData.name,
                            drink_name: drink.drinkName,
                            category: drink.category || 'Egyéb',
                            type: drink.type || 'Alkoholos',
                            location: drink.location || '',
                            drink_percentage: parseFloat(drink.drinkPercentage) || 0,
                            look, smell, taste,
                            total_score: totalScore,
                            avg: avgOf(totalScore),
                            notes: drink.notes || '',
                            user_email: userData.email
                        });
                        addedDrinksCount++;
                    });

                    if (newRows.length > 0) must(await db().from('user_drinks').insert(newRows));
                }

                return res.status(200).json({
                    message: `Sikeres importálás! (+${addedBeersCount} sör, +${addedDrinksCount} ital). ${skippedCount} duplikáció átugorva.`
                });
            }

            // ==========================================================
            // === ÖTLETEK ===
            // A frontend `index`-e itt átlátszatlan azonosító: a GET adja,
            // és változatlanul küldi vissza. Ezért a sor valódi adatbázis-
            // azonosítóját használjuk — így nem tud elcsúszni másik sorra.
            // ==========================================================

            case 'SUBMIT_IDEA': {
                const userData = verifyUser(req);
                const { ideaText, isAnonymous } = req.body;
                if (!ideaText || ideaText.trim() === '') {
                    return res.status(400).json({ error: "Az ötlet nem lehet üres!" });
                }

                must(await db().from('ideas').insert([{
                    submitter_name: isAnonymous ? 'Anonymous' : userData.name,
                    idea_text: ideaText,
                    time_text: nowText(),
                    status: 'Megcsinálásra vár',
                    date_text: new Date().toLocaleDateString('hu-HU'),
                    user_email: userData.email,
                    vote_count: 0,
                    voters: []
                }]));

                return res.status(201).json({ message: "Köszönjük az ötleted! 💡" });
            }

            case 'GET_ALL_IDEAS': {
                const userData = verifyUser(req);

                const [ideaRows, userRows] = await Promise.all([
                    db().from('ideas').select('*').order('id', { ascending: true }),
                    db().from('users').select('email,badge')
                ]).then(r => r.map(must));

                const userBadges = {};
                (userRows || []).forEach(u => { if (u.email && u.badge) userBadges[u.email] = u.badge; });

                const ideas = (ideaRows || []).map(r => {
                    const storedEmail = r.user_email || '';
                    const submitterName = r.submitter_name || 'Névtelen';
                    const voters = asArray(r.voters);

                    return {
                        index: r.id,
                        submitter: submitterName,
                        idea: r.idea_text || 'Nincs szöveg',
                        timestamp: r.time_text || '',
                        status: r.status || 'Megcsinálásra vár',
                        date: r.date_text || '',
                        email: userData.isAdmin ? storedEmail : undefined,
                        isMine: storedEmail === userData.email,
                        badge: (submitterName !== 'Anonymous' && userBadges[storedEmail]) ? userBadges[storedEmail] : '',
                        voteCount: r.vote_count || 0,
                        hasVoted: voters.includes(userData.email)
                    };
                });

                ideas.sort((a, b) => b.voteCount - a.voteCount);
                return res.status(200).json(ideas);
            }

            case 'UPDATE_IDEA_STATUS': {
                const userData = verifyUser(req);
                if (!userData.isAdmin) return res.status(403).json({ error: "Nincs jogosultságod ehhez a művelethez. 🚫" });
                const { index, newStatus } = req.body;
                if (index === undefined || index === null) return res.status(400).json({ error: "Hiányzó index!" });

                const upd = must(await db().from('ideas')
                    .update({ status: newStatus }).eq('id', parseInt(index)).select('id'));
                if (!upd || upd.length === 0) return res.status(404).json({ error: "Az ötlet nem található." });

                return res.status(200).json({ message: "Státusz sikeresen frissítve! ✅" });
            }

            // A frontend itt NEM az ötlet azonosítóját küldi, hanem a saját,
            // még függőben lévő ötletei közti sorszámot — ezt a szemantikát tartjuk.
            case 'DELETE_USER_IDEA': {
                const userData = verifyUser(req);
                const { index } = req.body;

                const rows = must(await db().from('ideas')
                    .select('id').eq('user_email', userData.email)
                    .neq('status', 'Megcsinálva').order('id', { ascending: true }));

                if (index < 0 || index >= (rows || []).length) {
                    return res.status(400).json({ error: "Érvénytelen index vagy már nem törölhető!" });
                }

                must(await db().from('ideas').delete().eq('id', rows[index].id));
                return res.status(200).json({ message: "Ötlet és a hozzá tartozó szavazatok sikeresen törölve!" });
            }

            // ==========================================================
            // === AJÁNLÁSOK ===
            // ==========================================================

            case 'ADD_RECOMMENDATION': {
                const userData = verifyUser(req);
                const { itemName, itemType, category, description, isAnonymous } = req.body;
                if (!itemName || !itemType) return res.status(400).json({ error: "Név és típus kötelező!" });

                must(await db().from('recommendations').insert([{
                    date_text: nowText(),
                    name: userData.name,
                    user_email: userData.email,
                    item_name: itemName,
                    item_type: itemType,
                    description: description || '',
                    is_anonymous: !!isAnonymous,
                    category: category || 'Egyéb',
                    is_edited: false,
                    vote_count: 0,
                    voters: []
                }]));

                return res.status(201).json({ message: "Ajánlás sikeresen beküldve! 📢" });
            }

            case 'GET_RECOMMENDATIONS': {
                const userData = verifyUser(req);

                const [recRows, userRows] = await Promise.all([
                    db().from('recommendations').select('*').order('id', { ascending: true }),
                    db().from('users').select('email,badge')
                ]).then(r => r.map(must));

                const userBadges = {};
                (userRows || []).forEach(u => { if (u.email && u.badge) userBadges[u.email] = u.badge; });

                const recommendations = (recRows || []).map(r => {
                    const isAnon = !!r.is_anonymous;
                    const email = r.user_email;
                    const voters = asArray(r.voters);

                    return {
                        originalIndex: r.id,
                        date: r.date_text ? String(r.date_text).substring(0, 10) : '',
                        submitter: isAnon ? 'Anonymus 🕵️' : (r.name || 'Ismeretlen'),
                        badge: isAnon ? '' : (userBadges[email] || ''),
                        itemName: r.item_name,
                        type: r.item_type,
                        description: r.description || '',
                        isAnon,
                        category: r.category || 'Egyéb',
                        isEdited: !!r.is_edited,
                        isMine: email === userData.email,
                        voteCount: r.vote_count || 0,
                        hasVoted: voters.includes(userData.email)
                    };
                });

                recommendations.sort((a, b) => b.voteCount - a.voteCount);
                return res.status(200).json(recommendations);
            }

            case 'EDIT_RECOMMENDATION': {
                const userData = verifyUser(req);
                const { originalIndex, itemName, itemType, category, description, isAnonymous } = req.body;

                const rows = must(await db().from('recommendations')
                    .select('id,user_email').eq('id', parseInt(originalIndex)).limit(1));
                if (!rows || rows.length === 0) return res.status(404).json({ error: "Az ajánlás nem található." });
                if (rows[0].user_email !== userData.email) {
                    return res.status(403).json({ error: "Csak a saját ajánlásodat módosíthatod!" });
                }

                must(await db().from('recommendations').update({
                    item_name: itemName,
                    item_type: itemType,
                    description: description,
                    is_anonymous: !!isAnonymous,
                    category: category,
                    is_edited: true
                }).eq('id', rows[0].id));

                return res.status(200).json({ message: "Ajánlás sikeresen módosítva!" });
            }

            case 'DELETE_USER_RECOMMENDATION': {
                const userData = verifyUser(req);
                const { originalIndex } = req.body;

                const rows = must(await db().from('recommendations')
                    .select('id,user_email').eq('id', parseInt(originalIndex)).limit(1));
                if (!rows || rows.length === 0) return res.status(404).json({ error: "Az ajánlás nem található." });
                if (rows[0].user_email !== userData.email) {
                    return res.status(403).json({ error: "Csak a saját ajánlásodat törölheted!" });
                }

                must(await db().from('recommendations').delete().eq('id', rows[0].id));
                return res.status(200).json({ message: "Ajánlás és a hozzá tartozó szavazatok sikeresen törölve!" });
            }

            // === SZAVAZÁS ===
            case 'VOTE_CONTENT': {
                const userData = verifyUser(req);
                const { type, index } = req.body;

                let table;
                if (type === 'idea') table = 'ideas';
                else if (type === 'recommendation') table = 'recommendations';
                else return res.status(400).json({ error: "Ismeretlen típus" });

                const rows = must(await db().from(table)
                    .select('id,vote_count,voters').eq('id', parseInt(index)).limit(1));
                if (!rows || rows.length === 0) return res.status(404).json({ error: "A tartalom nem található." });

                let voters = asArray(rows[0].voters);
                let currentCount = rows[0].vote_count || 0;
                const userEmail = userData.email;

                if (voters.includes(userEmail)) {
                    voters = voters.filter(e => e !== userEmail);
                    currentCount = Math.max(0, currentCount - 1);
                } else {
                    voters.push(userEmail);
                    currentCount++;
                }

                must(await db().from(table)
                    .update({ vote_count: currentCount, voters }).eq('id', rows[0].id));

                return res.status(200).json({
                    message: "Szavazat rögzítve",
                    newCount: currentCount,
                    voted: voters.includes(userEmail)
                });
            }

            // ==========================================================
            // === HIBAJELENTÉSEK (support) ===
            // ==========================================================

            case 'SUBMIT_SUPPORT_TICKET': {
                // Bejelentkezés nélkül is használható (vendégek is küldhetnek).
                try { verifyUser(req); } catch (e) { /* vendég — rendben */ }

                const { name, email, subject, message } = req.body;
                if (!name || !email || !subject || !message) {
                    return res.status(400).json({ error: "Minden mező kitöltése kötelező!" });
                }
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    return res.status(400).json({ error: "Érvénytelen email cím!" });
                }

                must(await db().from('support_tickets').insert([{
                    date_text: new Date().toLocaleDateString('hu-HU'),
                    name, user_email: email, subject, message, status: 'Új'
                }]));

                return res.status(201).json({
                    message: "Hibajelentésed sikeresen elküldve! Hamarosan válaszolunk az emaileden keresztül. 📧"
                });
            }

            case 'GET_SUPPORT_TICKETS': {
                const userData = verifyUser(req);
                if (!userData.isAdmin) return res.status(403).json({ error: "Nincs jogosultságod ehhez a művelethez. 🚫" });

                const rows = must(await db().from('support_tickets')
                    .select('*').order('id', { ascending: true }));

                const tickets = (rows || []).map(r => ({
                    originalIndex: r.id,
                    date: r.date_text,
                    name: r.name,
                    email: r.user_email,
                    subject: r.subject,
                    message: r.message,
                    status: r.status || 'Új'
                })).reverse(); // legújabb elöl

                return res.status(200).json(tickets);
            }

            case 'UPDATE_TICKET_STATUS': {
                const userData = verifyUser(req);
                if (!userData.isAdmin) return res.status(403).json({ error: "Nincs jogosultságod ehhez a művelethez. 🚫" });
                const { originalIndex, newStatus } = req.body;
                if (originalIndex === undefined || !newStatus) return res.status(400).json({ error: "Hiányzó adatok!" });

                const upd = must(await db().from('support_tickets')
                    .update({ status: newStatus }).eq('id', parseInt(originalIndex)).select('id'));
                if (!upd || upd.length === 0) return res.status(404).json({ error: "A hibajelentés nem található." });

                return res.status(200).json({ message: "Státusz sikeresen frissítve! ✅" });
            }

            // ==========================================================
            // === MODERÁCIÓ ===
            // ==========================================================

            case 'REPORT_CONTENT': {
                const userData = verifyUser(req);
                const { type, contentId, reason } = req.body;

                if (!reason) return res.status(400).json({ error: "Indoklás kötelező!" });
                if (contentId === undefined || contentId === null) {
                    return res.status(400).json({ error: "Hiányzó tartalom azonosító!" });
                }

                const targets = {
                    'Sör':     'user_beers',
                    'Ital':    'user_drinks',
                    'Ötlet':   'ideas',
                    'Ajánlás': 'recommendations'
                };
                const table = targets[type];
                if (!table) return res.status(400).json({ error: "Ismeretlen tartalom típus!" });

                const rows = must(await db().from(table)
                    .select('user_email').eq('id', parseInt(contentId)).limit(1));
                const foundEmail = rows && rows.length > 0 ? rows[0].user_email : null;
                if (!foundEmail) {
                    return res.status(404).json({ error: "A jelentett tartalom vagy felhasználó nem található." });
                }

                must(await db().from('reports').insert([{
                    date_text: new Date().toLocaleString('hu-HU'),
                    reporter_email: userData.email,
                    content_type: type,
                    content_id: String(contentId),
                    reported_email: foundEmail,
                    reason,
                    status: 'Nyitott'
                }]));

                return res.status(200).json({ message: "Jelentés elküldve a moderátoroknak. Köszönjük az éberséget! 🛡️" });
            }

            case 'GET_MODERATION_TASKS': {
                const userData = verifyUser(req);
                if (!userData.isAdmin) return res.status(403).json({ error: "Nincs jogosultságod ehhez a művelethez. 🚫" });

                const rows = must(await db().from('reports')
                    .select('*').neq('status', 'Lezárva').order('id', { ascending: true }));

                const reports = (rows || []).map(r => ({
                    index: r.id,
                    date: r.date_text,
                    reporter: r.reporter_email,
                    type: r.content_type,
                    content: r.content_id,
                    reportedUser: r.reported_email,
                    reason: r.reason,
                    status: r.status
                })).reverse();

                return res.status(200).json(reports);
            }

            case 'WARN_USER': {
                const userData = verifyUser(req);
                if (!userData.isAdmin) return res.status(403).json({ error: "Nincs jogosultságod ehhez a művelethez. 🚫" });
                const { targetEmail, reportIndex } = req.body;

                const rows = must(await db().from('users')
                    .select('id,warnings').eq('email', targetEmail).limit(1));
                if (!rows || rows.length === 0) return res.status(404).json({ error: "Felhasználó nem található." });

                let warnings = asArray(rows[0].warnings);

                // Fél évnél régebbi figyelmeztetések elévülnek
                const sixMonthsAgo = new Date();
                sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
                warnings = warnings.filter(w => new Date(w.date) > sixMonthsAgo);
                warnings.push({ date: new Date().toISOString(), reason: "Admin által jóváhagyott jelentés" });

                const isBanned = warnings.length >= 2;
                const message = isBanned
                    ? "Figyelmeztetés kiadva. A felhasználó automatikusan KITILTÁSRA került (2/2). 🚫"
                    : "Figyelmeztetés kiadva.";

                must(await db().from('users')
                    .update({ warnings, is_banned: isBanned }).eq('id', rows[0].id));

                if (reportIndex !== undefined && reportIndex !== null) {
                    await db().from('reports')
                        .update({ status: 'Lezárva (Büntetve)' }).eq('id', parseInt(reportIndex));
                }

                return res.status(200).json({ message, activeWarnings: warnings.length });
            }

            // ==========================================================
            // === FIÓK TÖRLÉSE (GDPR) ===
            // Korábban: 18 Sheets-művelet, hat lap kiürítése és visszaírása.
            // Most: néhány célzott törlés; az idegen kulcsok a kapcsolódó
            // sorokat maguktól viszik (sql/02_constraints.sql).
            // ==========================================================

            case 'DELETE_USER': {
                const userData = verifyUser(req);
                const userEmail = userData.email;

                // A leadott szavazatok visszavonása az ötletekről és ajánlásokról
                for (const table of ['ideas', 'recommendations']) {
                    const rows = must(await db().from(table).select('id,vote_count,voters'));
                    for (const r of (rows || [])) {
                        const voters = asArray(r.voters);
                        if (!voters.includes(userEmail)) continue;
                        must(await db().from(table).update({
                            voters: voters.filter(e => e !== userEmail),
                            vote_count: Math.max(0, (r.vote_count || 0) - 1)
                        }).eq('id', r.id));
                    }
                }

                // A felhasználóhoz kötött tartalmak
                for (const table of ['user_beers', 'user_drinks', 'consumptions',
                                     'beerpong_records', 'ideas', 'recommendations',
                                     'support_tickets', 'winners']) {
                    await db().from(table).delete().eq('user_email', userEmail);
                }

                // Jelentések: bejelentőként és bejelentettként is
                await db().from('reports').delete().eq('reporter_email', userEmail);
                await db().from('reports').delete().eq('reported_email', userEmail);

                // Végül maga a fiók
                must(await db().from('users').delete().eq('email', userEmail));

                return res.status(200).json({
                    message: "Fiók, adatok, ajánlások és leadott szavazatok sikeresen törölve."
                });
            }

            // ==========================================================
            // === GOOGLE BELÉPÉS / ÖSSZEKÖTÉS ===
            // ==========================================================

            case 'GOOGLE_LOGIN': {
                const { token: googleToken } = req.body;
                const clientId = process.env.GOOGLE_CLIENT_ID;
                const client = new OAuth2Client(clientId);

                const ticket = await client.verifyIdToken({ idToken: googleToken, audience: clientId });
                const payload = ticket.getPayload();
                const googleEmail = payload.email;
                const googleName = payload.name;
                const googleSub = payload.sub;

                let rows = must(await db().from('users').select('*').eq('email', googleEmail).limit(1));
                let u;
                let isNewUser = false;

                if (!rows || rows.length === 0) {
                    isNewUser = true;
                    const inserted = must(await db().from('users').insert([{
                        name: googleName,
                        email: googleEmail,
                        password_hash: await bcrypt.hash(Math.random().toString(36), 10),
                        twofa_secret: '', twofa_enabled: false,
                        achievements: { unlocked: [] },
                        badge: '',
                        recovery_hash: await bcrypt.hash(Math.random().toString(36).slice(-8).toUpperCase(), 10),
                        last_activity_week: '',
                        current_streak: 0, longest_streak: 0,
                        google_id: googleSub
                    }]).select('*'));
                    u = inserted[0];
                } else {
                    u = rows[0];
                    if (u.is_banned) {
                        return res.status(403).json({ error: "A fiókod fel lett függesztve a szabályzat megsértése miatt. 🚫" });
                    }
                    if (!u.google_id) {
                        must(await db().from('users').update({ google_id: googleSub }).eq('id', u.id));
                        u.google_id = googleSub;
                    }
                }

                const user = toUserObject(u, !!u.twofa_enabled);
                user.isGoogleLinked = true;
                const token = jwt.sign(user, JWT_SECRET, { expiresIn: '1d' });
                return res.status(200).json({ token, user, isNewUser });
            }

            case 'LINK_GOOGLE_ACCOUNT': {
                const userData = verifyUser(req);
                const { token: googleToken } = req.body;
                const clientId = process.env.GOOGLE_CLIENT_ID;
                const client = new OAuth2Client(clientId);

                const ticket = await client.verifyIdToken({ idToken: googleToken, audience: clientId });
                const { sub: googleSub } = ticket.getPayload();

                const taken = must(await db().from('users')
                    .select('id').eq('google_id', googleSub).neq('email', userData.email).limit(1));
                if (taken && taken.length > 0) {
                    return res.status(409).json({ error: "Ez a Google fiók már foglalt!" });
                }

                const upd = must(await db().from('users')
                    .update({ google_id: googleSub }).eq('email', userData.email).select('id'));
                if (!upd || upd.length === 0) return res.status(404).json({ error: "Felhasználó nem található" });

                return res.status(200).json({ message: "Sikeres összekötés! 🎉" });
            }

            case 'UNLINK_GOOGLE_ACCOUNT': {
                const userData = verifyUser(req);

                const rows = must(await db().from('users')
                    .select('id,google_id').eq('email', userData.email).limit(1));
                if (!rows || rows.length === 0) return res.status(404).json({ error: "Felhasználó nem található" });
                if (!rows[0].google_id) return res.status(400).json({ error: "Nincs Google fiók összekötve!" });

                must(await db().from('users').update({ google_id: '' }).eq('id', rows[0].id));
                return res.status(200).json({ message: "Google fiók kapcsolat sikeresen bontva! 🔌" });
            }

            // ==========================================================
            // === TOPLISTA ===
            // Korábban: három teljes munkalap letöltése minden kérésnél.
            // Most: három szűkített, indexelt lekérdezés párhuzamosan.
            // ==========================================================

            case 'GET_LEADERBOARD': {
                const userData = verifyUser(req);

                const [users, beerRows, drinkRows] = await Promise.all([
                    db().from('users')
                        .select('name,email,badge,achievements,current_streak,longest_streak,settings,is_banned')
                        .eq('is_banned', false),
                    db().from('user_beers').select('user_email,beer_name,type,location,avg,date_text'),
                    db().from('user_drinks').select('user_email,drink_name,type,category,avg,date_text')
                ]).then(r => r.map(must));

                const ratingStats = buildRatingStats(beerRows, drinkRows);

                const leaderboard = [];
                (users || []).forEach(u => {
                    if (!u.name || !u.email || !u.email.includes('@')) return;
                    if (!isProfilePublic(asObject(u.settings, {}))) return;

                    const s = ratingStats[u.email];
                    const totalCount = s ? s.beerCount + s.drinkCount : 0;
                    if (totalCount === 0) return;

                    const achievementCount = (asObject(u.achievements, {}).unlocked || []).length;

                    leaderboard.push({
                        publicId: getPublicId(u.email, JWT_SECRET),
                        name: u.name,
                        badge: u.badge || '',
                        beerCount: s.beerCount,
                        drinkCount: s.drinkCount,
                        totalCount,
                        avgScore: parseFloat((s.sumAvg / totalCount).toFixed(2)),
                        currentStreak: u.current_streak || 0,
                        longestStreak: u.longest_streak || 0,
                        achievementCount,
                        isMe: u.email === userData.email
                    });
                });

                leaderboard.sort((a, b) => b.totalCount - a.totalCount || b.avgScore - a.avgScore);
                return res.status(200).json({ leaderboard });
            }

            // === PUBLIKUS PROFIL (publicId alapján, e-mail cím nélkül) ===
            case 'GET_PUBLIC_PROFILE': {
                const userData = verifyUser(req);
                const { publicId } = req.body;
                if (!publicId) return res.status(400).json({ error: "Hiányzó profil azonosító." });

                // A publicId az e-mail HMAC-ja, ezért visszafelé nem kereshető:
                // végig kell néznünk a felhasználókat (kis tábla, indexelt olvasás).
                const users = must(await db().from('users')
                    .select('name,email,badge,achievements,current_streak,longest_streak,settings,is_banned'));

                const u = (users || []).find(x =>
                    x.email && x.email.includes('@') && getPublicId(x.email, JWT_SECRET) === publicId
                );

                if (!u || u.is_banned) return res.status(404).json({ error: "A profil nem található." });

                const email = u.email;
                const isMe = email === userData.email;
                const settings = asObject(u.settings, {});

                if (!isProfilePublic(settings) && !isMe) {
                    return res.status(403).json({ error: "Ez a profil privát. 🔒" });
                }

                const [beerRows, drinkRows] = await Promise.all([
                    db().from('user_beers').select('user_email,beer_name,type,location,avg,date_text').eq('user_email', email),
                    db().from('user_drinks').select('user_email,drink_name,type,category,avg,date_text').eq('user_email', email)
                ]).then(r => r.map(must));

                const allStats = buildRatingStats(beerRows, drinkRows);
                const stats = allStats[email] || { beerCount: 0, drinkCount: 0, sumAvg: 0, beers: [], drinks: [], types: {}, locations: {}, firstDate: null };

                const totalCount = stats.beerCount + stats.drinkCount;
                const topOf = (list) => [...list].sort((a, b) => b.avg - a.avg).slice(0, 3);
                const favOf = (counts) => {
                    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
                    return top ? top[0] : null;
                };

                const achievements = asObject(u.achievements, {}).unlocked || [];

                return res.status(200).json({
                    name: u.name,
                    badge: u.badge || '',
                    isMe,
                    isPublic: isProfilePublic(settings),
                    stats: {
                        beerCount: stats.beerCount,
                        drinkCount: stats.drinkCount,
                        totalCount,
                        avgScore: totalCount > 0 ? parseFloat((stats.sumAvg / totalCount).toFixed(2)) : 0,
                        favType: favOf(stats.types),
                        favLocation: favOf(stats.locations),
                        currentStreak: u.current_streak || 0,
                        longestStreak: u.longest_streak || 0,
                        achievementCount: achievements.length,
                        firstDate: stats.firstDate ? String(stats.firstDate).substring(0, 10) : null
                    },
                    topBeers: topOf(stats.beers),
                    topDrinks: topOf(stats.drinks)
                });
            }

            // ==========================================================
            // === SÖRPONG ===
            // Minden rekord csak a tulajdonosáé (user_email).
            // ==========================================================

            case 'BEERPONG_GET': {
                const userData = verifyUser(req);
                const rows = must(await db().from('beerpong_records')
                    .select('type,payload').eq('user_email', userData.email).order('id', { ascending: true }));

                const result = { roster: null, games: [], tournaments: [] };
                (rows || []).forEach(r => {
                    const data = asObject(r.payload, null);
                    if (!data) return;
                    if (r.type === 'roster') result.roster = data;
                    else if (r.type === 'game') result.games.push(data);
                    else if (r.type === 'tournament') result.tournaments.push(data);
                });

                return res.status(200).json(result);
            }

            case 'BEERPONG_SAVE': {
                const userData = verifyUser(req);
                const { type, id, data } = req.body;

                if (!['roster', 'game', 'tournament'].includes(type)) {
                    return res.status(400).json({ error: "Ismeretlen sörpong adattípus!" });
                }
                if (!data || typeof data !== 'object') {
                    return res.status(400).json({ error: "Hiányzó vagy hibás adat!" });
                }
                if (JSON.stringify(data).length > 45000) {
                    return res.status(400).json({ error: "Túl nagy adat, nem menthető!" });
                }

                const recordId = String(id || (type === 'roster' ? 'roster' : Date.now()));

                // Az (user_email, record_id) egyedi megszorítás miatt az upsert
                // az offline sor ismételt beküldésekor sem duplikál.
                must(await db().from('beerpong_records').upsert([{
                    user_email: userData.email,
                    type,
                    record_id: recordId,
                    date_text: nowText(),
                    payload: data
                }], { onConflict: 'user_email,record_id' }));

                return res.status(200).json({ message: "Sörpong adat mentve! 🏓", id: recordId });
            }

            case 'BEERPONG_DELETE': {
                const userData = verifyUser(req);
                const { type, id } = req.body;

                if (!['game', 'tournament'].includes(type) || !id) {
                    return res.status(400).json({ error: "Hiányzó vagy hibás törlési adatok!" });
                }

                const del = must(await db().from('beerpong_records').delete()
                    .eq('user_email', userData.email)
                    .eq('type', type)
                    .eq('record_id', String(id))
                    .select('id'));

                if (!del || del.length === 0) {
                    return res.status(404).json({ error: "A törlendő elem nem található." });
                }

                return res.status(200).json({ message: "Sikeresen törölve! 🗑️" });
            }

            default:
                return res.status(400).json({ error: "Ismeretlen művelet." });
        }

    } catch (error) {
        console.error("API Hiba:", error);
        // A lejárt/hibás tokent 401-gyel jelezzük, ahogy a frontend várja.
        if (error && (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError'
            || /authentikációs token/.test(error.message || ''))) {
            return res.status(401).json({ error: "A munkameneted lejárt, kérlek jelentkezz be újra." });
        }
        return res.status(500).json({ error: "Kritikus szerverhiba: " + error.message });
    }
}
