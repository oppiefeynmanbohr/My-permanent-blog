const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

// ── Turso cloud DB (permanent storage) or local SQLite fallback ───────────────
const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
let tursoClient = null;
if (TURSO_URL) {
  try {
    const { createClient } = require('@libsql/client');
    tursoClient = createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN });
    console.log('Using Turso cloud database for permanent storage.');
  } catch (e) { console.error('Turso init failed, falling back to SQLite:', e.message); }
}

const app = express();
app.set('trust proxy', true);
const PORT = Number(process.env.PORT || process.env.PORT_NUMBER || 10000);
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';
const COOKIE_SAME_SITE = process.env.COOKIE_SAME_SITE || '';
const dataDir = path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'blog.db');
const settingsFile = path.join(dataDir, 'settings.json');
const thesaurusFile = path.join(dataDir, 'thesaurus.json');
const dictionaryFile = path.join(dataDir, 'dictionary.json');
const supportQrFile = path.join(dataDir, 'support-qr.json');
const adminAuthFile = path.join(dataDir, 'admin-auth.json');
const emailAuthFile = path.join(dataDir, 'email-auth.json');
const ADMIN_OVERRIDE_CODE = process.env.ADMIN_OVERRIDE_CODE || 'restore-admin';
const ADMIN_PHONE_NUMBER = process.env.ADMIN_PHONE_NUMBER || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const REMEMBER_ME_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const MFA_TTL_MS = 5 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

const pendingPasswordResets = new Map(); // token -> { userId, expiresAt }

function getMailTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

const adminSessions = new Map();
const pendingChallenges = new Map();
const pendingMfa = new Map();

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
}
function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}
function isLegacyCodeOnlyUser(user) {
  return !user || !user.password_hash || !user.password_salt;
}
function generateEmailCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length];
  return code;
}
function isSecureRequest(req) {
  if (!req) return process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (forwardedProto) {
    const first = String(forwardedProto).split(',')[0].trim().toLowerCase();
    if (first === 'https') return true;
    if (first === 'http') return false;
  }
  return Boolean(req.secure || process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true');
}

function getCookieAttributes(req) {
  const secure = isSecureRequest(req);
  const parts = ['Path=/', 'HttpOnly'];
  if (COOKIE_DOMAIN) parts.push(`Domain=${COOKIE_DOMAIN}`);
  if (secure) parts.push('Secure');
  const sameSite = COOKIE_SAME_SITE === 'Strict' ? 'Strict' : 'Lax';
  parts.push(`SameSite=${sameSite}`);
  return parts;
}

function buildCookieValue(name, value, req, maxAgeMs) {
  const parts = [`${name}=${encodeURIComponent(value)}`, ...getCookieAttributes(req)];
  if (typeof maxAgeMs === 'number') parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return parts.join('; ');
}

async function createUserSession(req, res, userId, username, rememberMe = false, browserId = '') {
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = rememberMe ? REMEMBER_ME_TTL_MS : SESSION_TTL_MS;
  const expiresAt = Date.now() + ttl;
  await dbRun('INSERT OR REPLACE INTO user_sessions (token, user_id, username, expires_at, browser_id) VALUES (?,?,?,?,?)',
    [token, userId, username, expiresAt, browserId || '']);
  appendSetCookie(res, buildCookieValue('user_sid', token, req, rememberMe ? ttl : undefined));
  return token;
}

async function refreshUserSession(req, res, row) {
  if (!row) return null;
  const ttl = REMEMBER_ME_TTL_MS;
  const expiresAt = Date.now() + ttl;
  try {
    await dbRun('UPDATE user_sessions SET expires_at = ? WHERE token = ?', [expiresAt, req.cookies?.user_sid || '']);
  } catch {}
  return expiresAt;
}
function getUserFromRequest(req) {
  return req._userSession || null;
}

async function getAuthenticatedUser(req, res) {
  return getUserFromRequest(req);
}

function getBrowserIdFromRequest(req) {
  const cookies = parseCookies(req);
  return cookies.client_id || '';
}

function sameUserId(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function canManageEntry(row, user, browserId) {
  if (!row) return false;
  if (row.user_id !== null) {
    return !!user && sameUserId(row.user_id, user.userId);
  }
  return !!browserId && !!row.browser_id && row.browser_id === browserId;
}

async function migrateAnonymousEntriesToUser(userId, browserId) {
  if (!userId || !browserId) return;
  try {
    await dbRun('UPDATE entries SET user_id = ? WHERE user_id IS NULL AND browser_id = ? AND deleted = 0', [userId, browserId]);
  } catch (err) {
    console.warn('Failed to migrate anonymous entries:', err.message);
  }
}

// Middleware: load user session from DB before each request
function loadUserSession(req, res, next) {
  const cookies = parseCookies(req);
  req.cookies = cookies;
  const token = cookies['user_sid'] || req.headers['x-user-sid'] || '';
  req._userSession = null;

  if (!token) {
    return next();
  }

  dbGet('SELECT * FROM user_sessions WHERE token = ?', [token])
    .then((row) => {
      if (!row || row.expires_at < Date.now()) {
        if (row) {
          return dbRun('DELETE FROM user_sessions WHERE token = ?', [token]).then(() => next());
        }
        return next();
      }

      req._userSession = { userId: row.user_id, username: row.username, browserId: row.browser_id || '' };
      return refreshUserSession(req, res, row)
        .then(() => next())
        .catch(() => next());
    })
    .catch(() => next());
}

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error('Database open error:', err);
    process.exit(1);
  }
});

// Enable WAL mode for durability and crash safety
db.serialize(() => {
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA synchronous=NORMAL');
  db.run('PRAGMA cache_size=-64000'); // 64 MB cache
});

const createTableSql = `
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'main',
  deleted INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  browser_id TEXT NOT NULL DEFAULT ''
);
`;

const createUsersSql = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  signature_image TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function dbRun(sql, params = []) {
  if (tursoClient) return tursoClient.execute({ sql, args: params }).then(() => ({}));
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
  });
}
function dbAll(sql, params = []) {
  if (tursoClient) return tursoClient.execute({ sql, args: params }).then(r => r.rows);
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
  });
}
function dbGet(sql, params = []) {
  if (tursoClient) return tursoClient.execute({ sql, args: params }).then(r => r.rows[0] || null);
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
  });
}

async function initDatabase() {
  await dbRun(createTableSql);
  await dbRun(createUsersSql);
  const columns = await dbAll('PRAGMA table_info(entries)');
  const names = columns.map(c => c.name);
  if (!names.includes('published')) await dbRun('ALTER TABLE entries ADD COLUMN published INTEGER NOT NULL DEFAULT 0');
  if (!names.includes('user_id')) await dbRun('ALTER TABLE entries ADD COLUMN user_id INTEGER REFERENCES users(id)');
  if (!names.includes('source')) await dbRun("ALTER TABLE entries ADD COLUMN source TEXT NOT NULL DEFAULT 'main'");
  if (!names.includes('deleted')) await dbRun('ALTER TABLE entries ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
  if (!names.includes('archived')) await dbRun('ALTER TABLE entries ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  if (!names.includes('browser_id')) await dbRun('ALTER TABLE entries ADD COLUMN browser_id TEXT NOT NULL DEFAULT ""');
  const userColumns = await dbAll('PRAGMA table_info(users)');
  if (!userColumns.some(c => c.name === 'full_name')) await dbRun("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");
  if (!userColumns.some(c => c.name === 'signature')) await dbRun("ALTER TABLE users ADD COLUMN signature TEXT NOT NULL DEFAULT ''");
  if (!userColumns.some(c => c.name === 'signature_image')) await dbRun("ALTER TABLE users ADD COLUMN signature_image TEXT NOT NULL DEFAULT ''");
  await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_signature ON users(signature) WHERE signature <> ''");
  await dbRun(`CREATE TABLE IF NOT EXISTS user_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    browser_id TEXT NOT NULL DEFAULT ''
  )`);
  const sessionColumns = await dbAll('PRAGMA table_info(user_sessions)');
  if (!sessionColumns.some(c => c.name === 'browser_id')) {
    await dbRun('ALTER TABLE user_sessions ADD COLUMN browser_id TEXT NOT NULL DEFAULT ""');
  }
  await dbRun(`CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    browser_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'main',
    content TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`);
  const draftColumns = await dbAll('PRAGMA table_info(drafts)');
  if (!draftColumns.some(c => c.name === 'browser_id')) {
    await dbRun('ALTER TABLE drafts ADD COLUMN browser_id TEXT NOT NULL DEFAULT ""');
  }
  if (!draftColumns.some(c => c.name === 'user_id')) {
    await dbRun('ALTER TABLE drafts ADD COLUMN user_id INTEGER');
  }
  await dbRun(`CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    photo TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '',
    education TEXT NOT NULL DEFAULT '',
    work_status TEXT NOT NULL DEFAULT '',
    status_note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS work_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    employer TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL DEFAULT '',
    end_date TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
  )`);
  // Clean up expired sessions
  await dbRun('DELETE FROM user_sessions WHERE expires_at < ?', [Date.now()]);
  const tables = (await dbAll("SELECT name FROM sqlite_master WHERE type='table'")).map(t => t.name);
  console.log('Database initialized. Storage:', tursoClient ? 'Turso cloud (permanent)' : `SQLite at ${dbFile}`);
  console.log('Tables:', tables.join(', '));
  if (!tursoClient) {
    const onDisk = dbFile.startsWith('/opt/render/project/src/data') || !process.env.RENDER;
    if (process.env.RENDER && !onDisk) {
      console.warn('WARNING: Database is NOT on a persistent disk. Data will be lost on restart. Set TURSO_URL + TURSO_AUTH_TOKEN for permanent storage.');
    }
  }
}

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(loadUserSession);

app.get('/app.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'app.js'));
});


app.use(express.static(path.join(__dirname, 'public')));

function ensureJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
  }
}

ensureJsonFile(settingsFile, {
  fontFamily: '',
  fontSize: '',
  supportUrl: '/support',
  supportCashAppQrPath: '',
  supportVenmoQrPath: '',
  newSiteUrl: ''
});
ensureJsonFile(thesaurusFile, {});
ensureJsonFile(dictionaryFile, {});
ensureJsonFile(supportQrFile, {
  imageDataUrl: ''
});
ensureJsonFile(adminAuthFile, {
  passkeys: []
});
ensureJsonFile(emailAuthFile, {});

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function loadSettings() {
  const settings = {
    fontFamily: '',
    fontSize: '',
    supportUrl: '/support',
    supportCashAppUrl: 'https://cash.app/$LeeRoby5252',
    supportVenmoUrl: '',
    supportCashAppQrPath: '',
    supportVenmoQrPath: '',
    supportQrPath: '',
    newSiteUrl: '',
    ...readJson(settingsFile, {})
  };

  if (!settings.supportCashAppQrPath && settings.supportQrPath) {
    settings.supportCashAppQrPath = settings.supportQrPath;
  }

  // Fix legacy placeholder value stored on disk
  if (!settings.supportCashAppUrl || settings.supportCashAppUrl === '/support') {
    settings.supportCashAppUrl = 'https://cash.app/$LeeRoby5252';
  }

  return settings;
}

function parseCookies(req) {
  const source = req.headers.cookie || '';
  const cookies = {};
  source.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function appendSetCookie(res, cookieValue) {
  const current = res.getHeader('Set-Cookie');
  if (!current) {
    res.setHeader('Set-Cookie', [cookieValue]);
    return;
  }
  const arr = Array.isArray(current) ? current : [String(current)];
  arr.push(cookieValue);
  res.setHeader('Set-Cookie', arr);
}

function setCookie(res, name, value, maxAgeMs, req) {
  appendSetCookie(res, buildCookieValue(name, value, req, maxAgeMs));
}

function clearCookie(res, name, req) {
  appendSetCookie(res, buildCookieValue(name, '', req, 0));
}

function randomToken(size = 24) {
  return crypto.randomBytes(size).toString('hex');
}

function getOrCreateClientId(req, res) {
  const cookies = parseCookies(req);
  let cid = cookies.client_id;
  if (!cid) {
    cid = randomToken(16);
    setCookie(res, 'client_id', cid, 365 * 24 * 60 * 60 * 1000, req);
  }
  return cid;
}

function createAdminSession(req, res) {
  const sid = randomToken(24);
  adminSessions.set(sid, { expiresAt: Date.now() + SESSION_TTL_MS });
  setCookie(res, 'admin_sid', sid, SESSION_TTL_MS, req);
  return sid;
}

function getAdminSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies.admin_sid;
  if (!sid) return null;
  const session = adminSessions.get(sid);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    adminSessions.delete(sid);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { sid, session };
}

function isAdminAuthenticated(req) {
  return !!getAdminSession(req);
}

function requireAdmin(req, res) {
  if (!isAdminAuthenticated(req)) {
    res.status(401).json({ error: 'Admin authentication required.' });
    return false;
  }
  return true;
}

function cleanupAuthState() {
  const now = Date.now();
  for (const [sid, value] of adminSessions.entries()) {
    if (value.expiresAt < now) adminSessions.delete(sid);
  }
  for (const [cid, value] of pendingChallenges.entries()) {
    if (value.expiresAt < now) pendingChallenges.delete(cid);
  }
  for (const [token, value] of pendingMfa.entries()) {
    if (value.expiresAt < now) pendingMfa.delete(token);
  }
}

function getRpIdFromRequest(req) {
  return 'localhost';
}

function getExpectedOrigins(req) {
  return [
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ];
}

function loadAdminAuth() {
  const auth = readJson(adminAuthFile, { passkeys: [] });
  if (!Array.isArray(auth.passkeys)) auth.passkeys = [];
  return auth;
}

function saveAdminAuth(auth) {
  writeJson(adminAuthFile, auth);
}

function normalizePhoneNumber(value) {
  return String(value || '').replace(/[^+\d]/g, '');
}

function generateSmsCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getSmsConfigStatus() {
  const missing = [];
  if (!TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
  if (!TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN');
  if (!TWILIO_FROM_NUMBER) missing.push('TWILIO_FROM_NUMBER');
  const configured = missing.length === 0;
  const devFallback = !configured && process.env.NODE_ENV !== 'production';
  return { configured, devFallback, missing };
}

async function sendTextMessage(to, code) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[SMS DEV FALLBACK] ${to} -> ${code}`);
      return {
        ok: true,
        fallback: true,
        code,
        warning: 'Twilio is not configured. Using development fallback code.'
      };
    }
    return { ok: false, error: 'SMS service is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.' };
  }
  const body = new URLSearchParams({
    To: to,
    From: TWILIO_FROM_NUMBER,
    Body: `My Permanent Blog admin verification code: ${code}`
  });
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  if (!resp.ok) {
    const err = await resp.text();
    return { ok: false, error: `SMS send failed: ${err}` };
  }
  return { ok: true };
}

function formatTimestamp(date) {
  const datePart = new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric'
  }).format(date);

  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const minutePart = String(minutes).padStart(2, '0');

  return `${datePart} ${hours}:${minutePart} ${ampm}`;
}

// ── User Auth Routes ────────────────────────────────────────────────────────[...] 

app.post('/api/auth/signup', async (req, res) => {
  const { username, email, fullName, signature, signatureImage, password } = req.body || {};
  if (!username || !email || !fullName || !signature || !signatureImage || !password) return res.status(400).json({ error: 'Name, signature, drawn signature, username, email, and password are required.' });
  if (username.length < 2 || username.length > 40) return res.status(400).json({ error: 'Username must be 2–40 characters.' });
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(signature)) return res.status(400).json({ error: 'Signature must be 3–40 letters, numbers, periods, underscores, or hyphens.' });
  if (!String(signatureImage).startsWith('data:image/png;base64,') || String(signatureImage).length > 300000) return res.status(400).json({ error: 'Draw a valid signature before creating the account.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });

  try {
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = hashPassword(password, salt);
    const createdAt = new Date().toISOString();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedSignature = signature.trim().toLowerCase();
    await dbRun(
      'INSERT INTO users (username, email, full_name, signature, signature_image, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [username.trim(), normalizedEmail, fullName.trim(), normalizedSignature, signatureImage, hash, salt, createdAt]
    );
    const user = await dbGet('SELECT id, username, email, full_name, signature, signature_image FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) return res.status(500).json({ error: 'Could not create the account.' });
    const previousToken = parseCookies(req).user_sid;
    if (previousToken) await dbRun('DELETE FROM user_sessions WHERE token = ?', [previousToken]);
    const browserId = getOrCreateClientId(req, res);
    await createUserSession(req, res, user.id, user.username, true, browserId);
    await migrateAnonymousEntriesToUser(user.id, browserId);
    res.status(201).json({ success: true, username: user.username, email: user.email, fullName: user.full_name, signature: user.signature, signatureImage: user.signature_image, userId: user.id });
  } catch (err) {
    console.error('Signup DB error:', err.message);
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email already taken.' });
    return res.status(500).json({ error: 'Could not create the account.' });
  }
});

app.post('/api/auth/signup/verify', async (req, res) => {
  res.status(410).json({ error: 'Email verification is not required. Create an account directly from the sign-up form.' });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password, rememberMe } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  try {
    const identifier = normalizeIdentifier(username);
    const user = await dbGet(
      'SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(email) = ? OR LOWER(signature) = ?',
      [identifier, identifier, identifier]
    );
    if (!user) return res.status(401).json({ error: 'No account found with that username or email.' });
    if (isLegacyCodeOnlyUser(user)) {
      return res.status(409).json({
        error: 'This account needs a password. Use the password setup/reset flow first.'
      });
    }

    const hash = hashPassword(password, user.password_salt);
    if (hash !== user.password_hash) return res.status(401).json({ error: 'Invalid username or password.' });

    const browserId = getOrCreateClientId(req, res);
    await createUserSession(req, res, user.id, user.username, !!rememberMe, browserId);
    await migrateAnonymousEntriesToUser(user.id, browserId);
    res.json({ success: true, username: user.username, email: user.email, fullName: user.full_name || '', signature: user.signature || '', signatureImage: user.signature_image || '', userId: user.id });
  } catch (err) {
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies['user_sid'];
  try {
    if (token) await dbRun('DELETE FROM user_sessions WHERE token = ?', [token]);
  } catch (err) {
    console.error('Logout session deletion failed:', err.message);
  }
  res.setHeader('Set-Cookie', buildCookieValue('user_sid', '', req, 0));
  res.json({ success: true });
});

app.get('/logout', async (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies['user_sid'];
  try {
    if (token) await dbRun('DELETE FROM user_sessions WHERE token = ?', [token]);
  } catch (err) {
    console.error('Logout session deletion failed:', err.message);
  }
  res.setHeader('Set-Cookie', buildCookieValue('user_sid', '', req, 0));
  res.redirect(req.query.new === '1' ? '/login?new=1' : '/login');
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  try {
    const user = await dbGet('SELECT id, username FROM users WHERE email = ?', [email]);
    // Always respond OK to avoid leaking whether the email exists
    if (!user) return res.json({ success: true });

    const token = crypto.randomBytes(32).toString('hex');
    pendingPasswordResets.set(token, { userId: user.id, expiresAt: Date.now() + RESET_TTL_MS });

    const transport = getMailTransport();
    if (!transport) {
      // Dev fallback: log the reset link
      const link = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
      console.log(`[DEV PASSWORD RESET] ${email} -> ${link}`);
      return res.json({ success: true, devLink: link });
    }

    const resetLink = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
    await transport.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: 'Reset your My Permanent Blog password',
      text: `Hi ${user.username},\n\nClick the link below to reset your password (expires in 1 hour):\n\n${resetLink}\n\nIf you didn't request this, you can ignore this email.`,
      html: `<p>Hi <strong>${user.username}</strong>,</p><p>Click the link below to reset your password (expires in 1 hour):</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can ignore this email.</p>`
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send reset email.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const password = String(req.body.password || '');
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const record = pendingPasswordResets.get(token);
  if (!record || record.expiresAt < Date.now()) {
    pendingPasswordResets.delete(token);
    return res.status(400).json({ error: 'This reset link has expired or is invalid. Please request a new one.' });
  }
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    await dbRun('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', [hash, salt, record.userId]);
    pendingPasswordResets.delete(token);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

app.get('/api/auth/session', async (req, res) => {
  const user = getUserFromRequest(req);
  if (user) {
    return res.json({ authenticated: true, username: user.username, userId: user.userId });
  }
  return res.json({ authenticated: false });
});

// ── Email-code auth ────────────────────────────────────────────────────────�[...]

app.post('/api/auth/email-setup', async (req, res) => {
  res.status(410).json({ error: 'Email-code signup is no longer available. Create an account through email verification.' });
});

app.post('/api/auth/email-login', async (req, res) => {
  res.status(410).json({ error: 'Email-code login is no longer available. Use your verified email and password.' });
});

app.get('/api/auth/debug', async (req, res) => {
  try {
    const tables = await dbAll("SELECT name FROM sqlite_master WHERE type='table'");
    const count = await dbGet('SELECT count(*) as count FROM users');
    res.json({
      storage: tursoClient ? 'Turso cloud' : 'local SQLite',
      tables: tables.map(t => t.name),
      usersTableExists: tables.some(t => t.name === 'users'),
      userCount: count ? count.count : 0,
      protocol: req.protocol,
      secure: req.secure,
      forwardedProto: req.headers['x-forwarded-proto'],
      host: req.get('host'),
      isSecureRequest: isSecureRequest(req)
    });
  } catch (err) {
    res.status(500).json({ error: err.message, storage: tursoClient ? 'Turso cloud' : 'local SQLite', tables: [] });
  }
});

// ── Profile / Resume Routes ───────────────────────────────────────────────────

app.get('/api/profile', async (req, res) => {
  const user = getUserFromRequest(req);
  try {
    if (user) {
      const row = await dbGet('SELECT * FROM profiles WHERE user_id = ?', [user.userId]);
      return res.json(row || { user_id: user.userId, full_name: '', title: '', bio: '', email: '', phone: '', location: '', website: '', photo: '', skills: '', education: '' });
    }

    const row = await dbGet('SELECT * FROM profiles WHERE user_id = 0 LIMIT 1');
    if (row) return res.json(row);

    const fallback = await dbGet('SELECT * FROM profiles ORDER BY updated_at DESC, user_id DESC LIMIT 1');
    res.json(fallback || { user_id: 0, full_name: '', title: '', bio: '', email: '', phone: '', location: '', website: '', photo: '', skills: '', education: '' });
  } catch (err) { res.status(500).json({ error: 'Failed to load profile.' }); }
});

app.post('/api/profile', async (req, res) => {
  const user = getUserFromRequest(req);
  const { full_name = '', title = '', bio = '', email = '', phone = '', location = '', website = '', photo = '', skills = '', education = '', work_status = '', status_note = '' } = req.body || {};
  if (photo && photo.length > 7 * 1024 * 1024) return res.status(400).json({ error: 'Photo is too large (max 7 MB).' });
  const updatedAt = new Date().toISOString();
  const ownerId = user ? user.userId : 0;
  try {
    await dbRun(
      `INSERT INTO profiles (user_id, full_name, title, bio, email, phone, location, website, photo, skills, education, work_status, status_note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         full_name=excluded.full_name, title=excluded.title, bio=excluded.bio,
         email=excluded.email, phone=excluded.phone, location=excluded.location,
         website=excluded.website, photo=excluded.photo, skills=excluded.skills,
         education=excluded.education, work_status=excluded.work_status,
         status_note=excluded.status_note, updated_at=excluded.updated_at`,
      [ownerId, full_name, title, bio, email, phone, location, website, photo, skills, education, work_status, status_note, updatedAt]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to save profile.' }); }
});

app.get('/api/profile/work', async (req, res) => {
  const user = getUserFromRequest(req);
  try {
    if (user) {
      const rows = await dbAll('SELECT * FROM work_history WHERE user_id = ? ORDER BY start_date DESC, id DESC', [user.userId]);
      return res.json(rows);
    }

    const rows = await dbAll('SELECT * FROM work_history WHERE user_id = 0 ORDER BY start_date DESC, id DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load work history.' }); }
});

app.post('/api/profile/work', async (req, res) => {
  const user = getUserFromRequest(req);
  const { employer = '', role = '', start_date = '', end_date = '', description = '' } = req.body || {};
  if (!employer && !role) return res.status(400).json({ error: 'Employer or role is required.' });
  const createdAt = new Date().toISOString();
  const ownerId = user ? user.userId : 0;
  try {
    const result = await dbRun(
      'INSERT INTO work_history (user_id, employer, role, start_date, end_date, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ownerId, employer, role, start_date, end_date, description, createdAt]
    );
    const newRow = await dbGet('SELECT * FROM work_history WHERE user_id = ? ORDER BY id DESC LIMIT 1', [ownerId]);
    res.status(201).json(newRow);
  } catch (err) { res.status(500).json({ error: 'Failed to save work entry.' }); }
});

app.put('/api/profile/work/:id', async (req, res) => {
  const user = getUserFromRequest(req);
  const id = Number(req.params.id);
  const { employer = '', role = '', start_date = '', end_date = '', description = '' } = req.body || {};
  const ownerId = user ? user.userId : 0;
  try {
    const row = await dbGet('SELECT id FROM work_history WHERE id = ? AND user_id = ?', [id, ownerId]);
    if (!row) return res.status(404).json({ error: 'Record not found.' });
    await dbRun('UPDATE work_history SET employer=?, role=?, start_date=?, end_date=?, description=? WHERE id=?',
      [employer, role, start_date, end_date, description, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to update work entry.' }); }
});

app.delete('/api/profile/work/:id', async (req, res) => {
  const user = getUserFromRequest(req);
  const id = Number(req.params.id);
  const ownerId = user ? user.userId : 0;
  try {
    const row = await dbGet('SELECT id FROM work_history WHERE id = ? AND user_id = ?', [id, ownerId]);
    if (!row) return res.status(404).json({ error: 'Record not found.' });
    await dbRun('DELETE FROM work_history WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete work entry.' }); }
});

// ── Draft Routes ───────────────────────────────────────────────────────────

app.get('/api/drafts', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) return res.status(401).json({ error: 'Sign in to access your drafts.' });
  const browserId = getOrCreateClientId(req, res);
  const source = String(req.query.source || 'main');
  try {
    const rows = await dbAll(
      'SELECT content, updated_at, user_id FROM drafts WHERE source = ? AND (user_id = ? OR (user_id IS NULL AND browser_id = ?)) ORDER BY updated_at DESC, id DESC',
      [source, user.userId, browserId]
    );
    const row = rows.find((entry) => sameUserId(entry.user_id, user.userId)) || rows[0] || null;
    res.json({ content: row ? row.content : '', updatedAt: row ? row.updated_at : '' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load draft.' });
  }
});

app.put('/api/drafts', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) return res.status(401).json({ error: 'Sign in to save drafts.' });
  const browserId = getOrCreateClientId(req, res);
  const source = String(req.body?.source || 'main');
  const content = String(req.body?.content || '');
  const updatedAt = new Date().toISOString();

  try {
    if (!content.trim()) {
      await dbRun('DELETE FROM drafts WHERE source = ? AND (user_id = ? OR (user_id IS NULL AND browser_id = ?))', [source, user.userId, browserId]);
      return res.json({ content: '', updatedAt: '' });
    }

    await dbRun('DELETE FROM drafts WHERE source = ? AND (user_id = ? OR (user_id IS NULL AND browser_id = ?))', [source, user.userId, browserId]);
    await dbRun(
      'INSERT INTO drafts (user_id, browser_id, source, content, updated_at) VALUES (?, ?, ?, ?, ?)',
      [user.userId, browserId, source, content, updatedAt]
    );
    res.json({ content, updatedAt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save draft.' });
  }
});

// ── Entries Routes ────────────────────────────────────────────────────────────

app.get('/api/entries', async (req, res) => {
  cleanupAuthState();
  const search = req.query.search || '';
  const date = req.query.date || '';
  const published = req.query.published;
  const isPublicFeed = published === 'true';
  const user = isPublicFeed ? null : await getAuthenticatedUser(req, res);
  if (!isPublicFeed && !user) {
    return res.status(401).json({ error: 'Sign in to access your personal blog.' });
  }
  const source = req.query.source || '';
  const calmonth = req.query.calmonth || ''; // e.g. '2026-07'
  const order = (req.query.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  let sql = 'SELECT id, title, content, timestamp, created_at, published, source, archived FROM entries';
  const params = [];
  const clauses = ['deleted = 0'];

  // Show every undeleted entry in the archive by default. Login is no longer required to browse them.
  if (req.query.include_archived !== 'true') clauses.push('archived = 0');

  // The published feed is intentionally public; every other query belongs only
  // to the authenticated blogger.
  if (!isPublicFeed) { clauses.push('user_id = ?'); params.push(user.userId); }

  if (source) { clauses.push('source = ?'); params.push(source); }
  if (calmonth) { clauses.push("strftime('%Y-%m', created_at) = ?"); params.push(calmonth); }
  if (typeof published !== 'undefined') {
    if (published === 'true') clauses.push('published = 1');
    else if (published === 'false') clauses.push('published = 0');
  }
  if (search) { clauses.push('(title LIKE ? OR content LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (date) { clauses.push('date(created_at) = date(?)'); params.push(date); }

  if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
  sql += ` ORDER BY datetime(created_at) ${order}`;

  try {
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load entries.' });
  }
});

app.post('/api/entries', async (req, res) => {
  cleanupAuthState();
  const user = await getAuthenticatedUser(req, res);
  if (!user) return res.status(401).json({ error: 'Sign in to save entries to your personal blog.' });
  const browserId = getOrCreateClientId(req, res);

  const { title, content, source, caldate } = req.body;
  if (!content) return res.status(400).json({ error: 'Content is required.' });

  const autoTitle = title || `Entry ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const entrySource = source || 'main';

  // For calendar entries, use the selected date; otherwise use now
  let now = new Date();
  if (caldate && /^\d{4}-\d{2}-\d{2}$/.test(caldate)) {
    now = new Date(`${caldate}T12:00:00`);
  }
  const timestamp = formatTimestamp(now);
  const createdAt = now.toISOString();
  const sql = 'INSERT INTO entries (title, content, timestamp, created_at, published, user_id, source, browser_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?)';
  const userId = user.userId;

  try {
    if (userId) {
      await migrateAnonymousEntriesToUser(userId, browserId);
    }
    await dbRun(sql, [autoTitle, content, timestamp, createdAt, userId, entrySource, browserId]);
    const row = await dbGet('SELECT id FROM entries WHERE created_at = ? AND user_id = ? ORDER BY id DESC LIMIT 1', [createdAt, userId]);
    const newId = row ? row.id : Date.now();
    res.status(201).json({ id: newId, title: autoTitle, content, timestamp, created_at: createdAt, published: 0, source: entrySource });
  } catch (err) {
    console.error('Entry save failed:', err.message);
    res.status(500).json({ error: 'Failed to save entry.' });
  }
});

app.patch('/api/entries/:id/content', async (req, res) => {
  cleanupAuthState();
  const user = await getAuthenticatedUser(req, res);
  const browserId = getOrCreateClientId(req, res);
  const id = Number(req.params.id);
  const content = String(req.body.content || '').trim();
  if (!id) return res.status(400).json({ error: 'Invalid entry ID.' });
  if (!content) return res.status(400).json({ error: 'Content is required.' });
  try {
    const row = await dbGet('SELECT id, user_id, browser_id FROM entries WHERE id = ? AND deleted = 0', [id]);
    if (!row) return res.status(404).json({ error: 'Entry not found.' });
    if (!canManageEntry(row, user, browserId)) {
      return res.status(403).json({ error: 'You can only edit your own entries.' });
    }
    await dbRun('UPDATE entries SET content = ? WHERE id = ?', [content, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update entry.' });
  }
});

app.patch('/api/entries/:id/publish', async (req, res) => {
  cleanupAuthState();
  const isAdmin = isAdminAuthenticated(req);
  const user = await getAuthenticatedUser(req, res);
  const browserId = getOrCreateClientId(req, res);

  const { publish } = req.body;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid entry ID.' });

  const publishedValue = publish ? 1 : 0;

  try {
    const row = await dbGet('SELECT id, user_id, browser_id FROM entries WHERE id = ? AND deleted = 0', [id]);
    if (!row) return res.status(404).json({ error: 'Entry not found.' });
    if (!isAdmin && !canManageEntry(row, user, browserId)) {
      return res.status(403).json({ error: 'You can only publish your own entries.' });
    }
    await dbRun('UPDATE entries SET published = ? WHERE id = ?', [publishedValue, id]);
    res.json({ success: true, published: publishedValue });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update publish status.' });
  }
});

app.patch('/api/entries/:id/archive', async (req, res) => {
  cleanupAuthState();
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid entry ID.' });
  const isAdmin = isAdminAuthenticated(req);
  const user = await getAuthenticatedUser(req, res);
  const browserId = getOrCreateClientId(req, res);
  try {
    const row = await dbGet('SELECT id, user_id, browser_id FROM entries WHERE id = ? AND deleted = 0', [id]);
    if (!row) return res.status(404).json({ error: 'Entry not found.' });
    if (!isAdmin && !canManageEntry(row, user, browserId)) {
      return res.status(403).json({ error: 'You can only archive your own entries.' });
    }
    await dbRun('UPDATE entries SET archived = 1 WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to archive entry.' });
  }
});

app.delete('/api/entries/:id', async (req, res) => {
  cleanupAuthState();
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid entry ID.' });

  const isAdmin = isAdminAuthenticated(req);
  const user = await getAuthenticatedUser(req, res);
  const browserId = getOrCreateClientId(req, res);

  try {
    // Only allow users to delete their own entries; admins can delete any
    let row;
    if (!isAdmin) {
      row = await dbGet('SELECT id, user_id, browser_id FROM entries WHERE id = ? AND deleted = 0', [id]);
      if (!row) return res.status(404).json({ error: 'Entry not found.' });
      if (!canManageEntry(row, user, browserId)) {
        return res.status(403).json({ error: 'You can only delete your own entries.' });
      }
    }
    await dbRun('UPDATE entries SET deleted = 1 WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete entry.' });
  }
});

app.get('/api/settings', (req, res) => {
  const settings = loadSettings();
  res.json(settings);
});

app.patch('/api/settings', (req, res) => {
  cleanupAuthState();
  if (!requireAdmin(req, res)) return;
  const current = loadSettings();
  const updates = {
    fontFamily: typeof req.body.fontFamily === 'string' ? req.body.fontFamily : current.fontFamily,
    fontSize: typeof req.body.fontSize === 'string' ? req.body.fontSize : current.fontSize,
    supportUrl: typeof req.body.supportUrl === 'string' ? req.body.supportUrl : current.supportUrl,
    supportCashAppUrl: typeof req.body.supportCashAppUrl === 'string' ? req.body.supportCashAppUrl : current.supportCashAppUrl,
    supportVenmoUrl: typeof req.body.supportVenmoUrl === 'string' ? req.body.supportVenmoUrl : current.supportVenmoUrl,
    supportCashAppQrPath: typeof req.body.supportCashAppQrPath === 'string' ? req.body.supportCashAppQrPath : current.supportCashAppQrPath,
    supportVenmoQrPath: typeof req.body.supportVenmoQrPath === 'string' ? req.body.supportVenmoQrPath : current.supportVenmoQrPath,
    newSiteUrl: typeof req.body.newSiteUrl === 'string' ? req.body.newSiteUrl : current.newSiteUrl
  };
  updates.supportQrPath = updates.supportCashAppQrPath;
  writeJson(settingsFile, updates);
  res.json({ success: true, settings: updates });
});

app.post('/api/support/upload', (req, res) => {
  cleanupAuthState();
  if (!requireAdmin(req, res)) return;

  const imageData = String(req.body.imageData || '');
  const qrType = String(req.body.qrType || 'cashapp').toLowerCase();
  if (!imageData.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Upload must be an image data URL.' });
  }

  if (imageData.length > 4 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image is too large.' });
  }

  const current = loadSettings();
  if (qrType === 'venmo') {
    current.supportVenmoQrPath = imageData;
  } else {
    current.supportCashAppQrPath = imageData;
    current.supportQrPath = imageData;
  }
  writeJson(settingsFile, current);
  writeJson(supportQrFile, {
    cashAppImageDataUrl: current.supportCashAppQrPath || '',
    venmoImageDataUrl: current.supportVenmoQrPath || ''
  });

  res.json({ success: true, url: imageData, qrType });
});

app.get('/api/library/thesaurus', (req, res) => {
  const data = readJson(thesaurusFile, {});
  res.json({ data });
});

app.post('/api/library/upload', (req, res) => {
  cleanupAuthState();
  if (!requireAdmin(req, res)) return;
  const { thesaurus } = req.body;
  if (!thesaurus || typeof thesaurus !== 'object' || Array.isArray(thesaurus)) {
    return res.status(400).json({ error: 'Invalid thesaurus payload.' });
  }
  writeJson(thesaurusFile, thesaurus);
  res.json({ success: true });
});

app.get('/api/library/dictionary', (req, res) => {
  const data = readJson(dictionaryFile, {});
  res.json({ data });
});

app.post('/api/library/dictionary-upload', (req, res) => {
  cleanupAuthState();
  if (!requireAdmin(req, res)) return;
  const { dictionary } = req.body;
  if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) {
    return res.status(400).json({ error: 'Invalid dictionary payload.' });
  }
  writeJson(dictionaryFile, dictionary);
  res.json({ success: true });
});

app.get('/api/admin/session', (req, res) => {
  cleanupAuthState();
  res.json({ authenticated: isAdminAuthenticated(req) });
});

app.post('/api/admin/logout', (req, res) => {
  cleanupAuthState();
  const cookies = parseCookies(req);
  const sid = cookies.admin_sid;
  if (sid) adminSessions.delete(sid);
  clearCookie(res, 'admin_sid', req);
  res.json({ success: true });
});

app.post('/api/admin/login', (req, res) => {
  res.status(400).json({ error: 'Password login is disabled. Use fingerprint login and phone verification code.' });
});

app.post('/api/admin/login/venmo-qr', (req, res) => {
  cleanupAuthState();
  const settings = loadSettings();
  const hasVenmoSetup = Boolean((settings.supportVenmoUrl || '').trim() || (settings.supportVenmoQrPath || '').trim());
  if (!hasVenmoSetup) {
    return res.status(400).json({ error: 'Set your Venmo link or Venmo QR on the support/admin settings first.' });
  }

  createAdminSession(req, res);
  res.json({ success: true, authenticated: true });
});

app.post('/api/admin/password', (req, res) => {
  res.status(400).json({ error: 'Password reset is disabled. Use fingerprint + SMS code.' });
});

app.post('/api/admin/passkey/register/options', async (req, res) => {
  cleanupAuthState();
  const auth = loadAdminAuth();
  const hasAdmin = isAdminAuthenticated(req);
  const overrideCode = String(req.body.overrideCode || '');
  const allowOverride = overrideCode && overrideCode === ADMIN_OVERRIDE_CODE;
  if (auth.passkeys.length > 0 && !hasAdmin && !allowOverride) {
    return res.status(401).json({ error: 'Admin authentication or valid override code required to enroll/reset fingerprint.' });
  }

  const rpID = getRpIdFromRequest(req);
  const options = await generateRegistrationOptions({
    rpName: 'My Permanent Blog Admin',
    rpID,
    userName: 'admin',
    userID: Buffer.from('admin-local', 'utf8'),
    timeout: 60000,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
      authenticatorAttachment: 'platform'
    },
    excludeCredentials: auth.passkeys.map((pk) => ({ id: pk.id, type: 'public-key', transports: pk.transports || ['internal'] }))
  });

  const cid = getOrCreateClientId(req, res);
  pendingChallenges.set(cid, {
    type: 'register',
    challenge: options.challenge,
    rpID,
    expectedOrigins: getExpectedOrigins(req),
    expiresAt: Date.now() + CHALLENGE_TTL_MS
  });

  res.json(options);
});

app.post('/api/admin/passkey/register/verify', async (req, res) => {
  cleanupAuthState();
  const cid = getOrCreateClientId(req, res);
  const pending = pendingChallenges.get(cid);
  if (!pending || pending.type !== 'register') {
    return res.status(400).json({ error: 'No active fingerprint registration challenge.' });
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: req.body.credential,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.expectedOrigins,
      expectedRPID: pending.rpID
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Fingerprint registration failed.' });
    }

    const auth = loadAdminAuth();
    const info = verification.registrationInfo;
    const credentialId = Buffer.from(info.credential.id).toString('base64url');
    const publicKey = Buffer.from(info.credential.publicKey).toString('base64');
    const newPasskey = {
      id: credentialId,
      publicKey,
      counter: info.credential.counter || 0,
      transports: req.body.credential?.response?.transports || ['internal']
    };

    const existingIndex = auth.passkeys.findIndex((pk) => pk.id === credentialId);
    if (existingIndex >= 0) {
      auth.passkeys[existingIndex] = newPasskey;
    } else {
      auth.passkeys.push(newPasskey);
    }
    saveAdminAuth(auth);
    pendingChallenges.delete(cid);

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Fingerprint registration verification failed.' });
  }
});

app.post('/api/admin/passkey/login/options', async (req, res) => {
  cleanupAuthState();
  const auth = loadAdminAuth();
  if (!auth.passkeys.length) {
    return res.status(400).json({ error: 'No fingerprint registered yet. Run enrollment first.' });
  }

  const rpID = getRpIdFromRequest(req);
  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 60000,
    userVerification: 'required',
    allowCredentials: auth.passkeys.map((pk) => ({
      id: pk.id,
      type: 'public-key',
      transports: pk.transports || ['internal']
    }))
  });

  const cid = getOrCreateClientId(req, res);
  pendingChallenges.set(cid, {
    type: 'login',
    challenge: options.challenge,
    rpID,
    expectedOrigins: getExpectedOrigins(req),
    expiresAt: Date.now() + CHALLENGE_TTL_MS
  });

  res.json(options);
});

app.post('/api/admin/passkey/login/verify', async (req, res) => {
  cleanupAuthState();
  const cid = getOrCreateClientId(req, res);
  const pending = pendingChallenges.get(cid);
  if (!pending || pending.type !== 'login') {
    return res.status(400).json({ error: 'No active fingerprint login challenge.' });
  }

  const auth = loadAdminAuth();
  const credentialId = req.body.credential?.id;
  const stored = auth.passkeys.find((pk) => pk.id === credentialId);
  if (!stored) {
    return res.status(400).json({ error: 'Unknown fingerprint credential.' });
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response: req.body.credential,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.expectedOrigins,
      expectedRPID: pending.rpID,
      credential: {
        id: stored.id,
        publicKey: Buffer.from(stored.publicKey, 'base64'),
        counter: stored.counter,
        transports: stored.transports || ['internal']
      }
    });

    if (!verification.verified) {
      return res.status(401).json({ error: 'Fingerprint verification failed.' });
    }

    stored.counter = verification.authenticationInfo.newCounter;
    saveAdminAuth(auth);
    pendingChallenges.delete(cid);

    const mfaToken = randomToken(20);
    pendingMfa.set(mfaToken, {
      expiresAt: Date.now() + MFA_TTL_MS,
      code: '',
      phoneNumber: ''
    });
    res.json({ mfaRequired: true, mfaToken });
  } catch (err) {
    res.status(401).json({ error: 'Fingerprint login verification failed.' });
  }
});

app.get('/api/admin/sms/status', (req, res) => {
  const status = getSmsConfigStatus();
  res.json({
    configured: status.configured,
    devFallback: status.devFallback,
    missing: status.missing,
    message: status.configured
      ? 'SMS provider is configured.'
      : status.devFallback
        ? 'SMS provider is not configured. Development fallback codes are active.'
        : 'SMS provider is not configured.'
  });
});

app.post('/api/admin/sms/send', async (req, res) => {
  cleanupAuthState();
  const mfaToken = String(req.body.mfaToken || '');
  const pending = pendingMfa.get(mfaToken);
  if (!pending || pending.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'SMS verification session expired. Start fingerprint login again.' });
  }

  const preferred = normalizePhoneNumber(req.body.phoneNumber);
  const destination = preferred || normalizePhoneNumber(ADMIN_PHONE_NUMBER);
  if (!destination) {
    return res.status(400).json({ error: 'Phone number is required. Enter it in the admin panel or set ADMIN_PHONE_NUMBER.' });
  }

  const code = generateSmsCode();
  pending.code = code;
  pending.phoneNumber = destination;
  const sent = await sendTextMessage(destination, code);
  if (!sent.ok) {
    return res.status(500).json({ error: sent.error });
  }
  res.json({
    success: true,
    destination,
    fallback: !!sent.fallback,
    fallbackCode: sent.fallback ? sent.code : undefined,
    warning: sent.warning
  });
});

app.post('/api/admin/sms/test', async (req, res) => {
  cleanupAuthState();
  const overrideCode = String(req.body.overrideCode || '');
  const hasAdmin = isAdminAuthenticated(req);
  if (!hasAdmin && overrideCode !== ADMIN_OVERRIDE_CODE) {
    return res.status(401).json({ error: 'Admin authentication or valid override code required for SMS test.' });
  }

  const preferred = normalizePhoneNumber(req.body.phoneNumber);
  const destination = preferred || normalizePhoneNumber(ADMIN_PHONE_NUMBER);
  if (!destination) {
    return res.status(400).json({ error: 'Phone number is required. Enter it in the admin panel or set ADMIN_PHONE_NUMBER.' });
  }

  const code = generateSmsCode();
  const sent = await sendTextMessage(destination, code);
  if (!sent.ok) {
    return res.status(500).json({ error: sent.error });
  }

  res.json({
    success: true,
    destination,
    fallback: !!sent.fallback,
    fallbackCode: sent.fallback ? sent.code : undefined,
    warning: sent.warning
  });
});

app.post('/api/admin/sms/verify', (req, res) => {
  cleanupAuthState();
  const mfaToken = String(req.body.mfaToken || '');
  const pending = pendingMfa.get(mfaToken);
  if (!pending || pending.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'SMS verification session expired. Start fingerprint login again.' });
  }

  const inputCode = String(req.body.code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(inputCode)) {
    return res.status(400).json({ error: 'Enter a valid 6-digit SMS code.' });
  }
  if (!pending.code || pending.code !== inputCode) {
    return res.status(400).json({ error: 'Invalid SMS verification code.' });
  }

  pendingMfa.delete(mfaToken);
  createAdminSession(req, res);
  res.json({ success: true, authenticated: true });
});

function sendPageNoCache(res, fileName) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', fileName));
}

app.get(['/', '/page1'], (req, res) => {
  sendPageNoCache(res, 'page1.html');
});

app.get('/admin', (req, res) => {
  sendPageNoCache(res, 'admin.html');
});

app.get('/login', (req, res) => {
  sendPageNoCache(res, 'login.html');
});

app.get('/reset-password', (req, res) => {
  sendPageNoCache(res, 'reset-password.html');
});

app.get('/resume', (req, res) => {
  sendPageNoCache(res, 'resume.html');
});

app.get('/page2', (req, res) => {
  sendPageNoCache(res, 'page2.html');
});

app.get('/page3', (req, res) => {
  sendPageNoCache(res, 'page3.html');
});

app.get('/page4', (req, res) => {
  sendPageNoCache(res, 'page4.html');
});

app.get('/page5', (req, res) => {
  sendPageNoCache(res, 'page5.html');
});

app.get('/page6', (req, res) => {
  sendPageNoCache(res, 'page6.html');
});

app.get('/page7', (req, res) => {
  sendPageNoCache(res, 'page7.html');
});

app.get('/dreamstate', (req, res) => {
  sendPageNoCache(res, 'dreamstate.html');
});

app.get('/calendar-journal', (req, res) => {
  sendPageNoCache(res, 'calendar-journal.html');
});

app.get('/library', (req, res) => {
  sendPageNoCache(res, 'library.html');
});

app.get('/encyclopedia', (req, res) => {
  sendPageNoCache(res, 'encyclopedia.html');
});

app.get('/word-parts', (req, res) => {
  sendPageNoCache(res, 'word-parts.html');
});

app.get('/support', (req, res) => {
  sendPageNoCache(res, 'support.html');
});

app.get('/alarm', (req, res) => {
  sendPageNoCache(res, 'alarm.html');
});

app.get('/published', (req, res) => {
  sendPageNoCache(res, 'public.html');
});

initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`My Permanent Blog running at http://0.0.0.0:${PORT}`);
      console.log(`Open http://127.0.0.1:${PORT} in your browser.`);
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
