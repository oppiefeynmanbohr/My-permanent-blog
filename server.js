const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const app = express();
const PORT = process.env.PORT || 3000;
const dataDir = path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'blog.db');
const settingsFile = path.join(dataDir, 'settings.json');
const thesaurusFile = path.join(dataDir, 'thesaurus.json');
const dictionaryFile = path.join(dataDir, 'dictionary.json');
const supportQrFile = path.join(dataDir, 'support-qr.json');
const adminAuthFile = path.join(dataDir, 'admin-auth.json');
const ADMIN_OVERRIDE_CODE = process.env.ADMIN_OVERRIDE_CODE || 'restore-admin';
const ADMIN_PHONE_NUMBER = process.env.ADMIN_PHONE_NUMBER || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MFA_TTL_MS = 5 * 60 * 1000;

const adminSessions = new Map();
const pendingChallenges = new Map();
const pendingMfa = new Map();
const userSessions = new Map(); // token -> { userId, username, expiresAt }

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
}
function createUserSession(res, userId, username) {
  const token = crypto.randomBytes(32).toString('hex');
  userSessions.set(token, { userId, username, expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', `user_sid=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`);
  return token;
}
function getUserFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies['user_sid'];
  if (!token) return null;
  const session = userSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    userSessions.delete(token);
    return null;
  }
  return session;
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

const createTableSql = `
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0
);
`;

const createUsersSql = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
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
  console.log('Database initialized. Tables:', (await dbAll("SELECT name FROM sqlite_master WHERE type='table'")).map(t => t.name).join(', '));
}

db.serialize(() => {});

app.use(express.json());
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

function setCookie(res, name, value, maxAgeMs) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (typeof maxAgeMs === 'number') {
    parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  }
  appendSetCookie(res, parts.join('; '));
}

function clearCookie(res, name) {
  appendSetCookie(res, `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function randomToken(size = 24) {
  return crypto.randomBytes(size).toString('hex');
}

function getOrCreateClientId(req, res) {
  const cookies = parseCookies(req);
  let cid = cookies.client_id;
  if (!cid) {
    cid = randomToken(16);
    setCookie(res, 'client_id', cid, 365 * 24 * 60 * 60 * 1000);
  }
  return cid;
}

function createAdminSession(res) {
  const sid = randomToken(24);
  adminSessions.set(sid, { expiresAt: Date.now() + SESSION_TTL_MS });
  setCookie(res, 'admin_sid', sid, SESSION_TTL_MS);
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

// ── User Auth Routes ──────────────────────────────────────────────────────────

app.post('/api/auth/signup', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ error: 'Username, email, and password are required.' });
  if (username.length < 2 || username.length > 40) return res.status(400).json({ error: 'Username must be 2–40 characters.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });

  const salt = crypto.randomBytes(32).toString('hex');
  const hash = hashPassword(password, salt);
  const createdAt = new Date().toISOString();

  db.run('INSERT INTO users (username, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)',
    [username.trim(), email.trim().toLowerCase(), hash, salt, createdAt],
    function (err) {
      if (err) {
        console.error('Signup DB error:', err.message);
        if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email already taken.' });
        return res.status(500).json({ error: `Signup failed: ${err.message}` });
      }
      createUserSession(res, this.lastID, username.trim());
      res.status(201).json({ success: true, username: username.trim() });
    }
  );
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  db.get('SELECT * FROM users WHERE username = ?', [username.trim()], (err, user) => {
    if (err) return res.status(500).json({ error: 'Login failed.' });
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

    const hash = hashPassword(password, user.password_salt);
    if (hash !== user.password_hash) return res.status(401).json({ error: 'Invalid username or password.' });

    createUserSession(res, user.id, user.username);
    // Claim any previously unowned entries
    db.run('UPDATE entries SET user_id = ? WHERE user_id IS NULL', [user.id]);
    res.json({ success: true, username: user.username });
  });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies['user_sid'];
  if (token) userSessions.delete(token);
  res.setHeader('Set-Cookie', 'user_sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ success: true });
});

app.get('/api/auth/session', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, username: user.username, userId: user.userId });
});

app.get('/api/auth/debug', (req, res) => {
  db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
    if (err) return res.json({ error: err.message, tables: [] });
    db.all('SELECT count(*) as count FROM users', [], (err2, rows) => {
      res.json({
        tables: tables.map(t => t.name),
        usersTableExists: tables.some(t => t.name === 'users'),
        userCount: err2 ? `error: ${err2.message}` : rows[0].count
      });
    });
  });
});

// ── Entries Routes ────────────────────────────────────────────────────────────

app.get('/api/entries', (req, res) => {
  cleanupAuthState();
  const user = getUserFromRequest(req);
  const search = req.query.search || '';
  const date = req.query.date || '';
  const published = req.query.published;
  const source = req.query.source || '';

  let sql = 'SELECT id, title, content, timestamp, created_at, published, source FROM entries';
  const params = [];
  const clauses = [];

  // No user scoping — all entries are visible to everyone (single-owner blog)

  if (source) {
    clauses.push('source = ?');
    params.push(source);
  }

  if (typeof published !== 'undefined') {
    if (published === 'true') clauses.push('published = 1');
    else if (published === 'false') clauses.push('published = 0');
  }

  if (search) {
    clauses.push('(title LIKE ? OR content LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  if (date) {
    clauses.push('date(created_at) = date(?)');
    params.push(date);
  }

  if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
  sql += ' ORDER BY datetime(created_at) DESC';

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load entries.' });
    res.json(rows);
  });
});

app.post('/api/entries', (req, res) => {
  cleanupAuthState();
  const user = getUserFromRequest(req);
  const { title, content, source } = req.body;
  if (!content) return res.status(400).json({ error: 'Content is required.' });

  const autoTitle = title || `Entry ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const entrySource = source || 'main';
  const now = new Date();
  const timestamp = formatTimestamp(now);
  const createdAt = now.toISOString();
  const userId = user ? user.userId : null;
  const sql = 'INSERT INTO entries (title, content, timestamp, created_at, published, user_id, source) VALUES (?, ?, ?, ?, 0, ?, ?)';

  db.run(sql, [autoTitle, content, timestamp, createdAt, userId, entrySource], function (err) {
    if (err) return res.status(500).json({ error: 'Failed to save entry.' });
    res.status(201).json({ id: this.lastID, title: autoTitle, content, timestamp, created_at: createdAt, published: 0, source: entrySource });
  });
});

app.patch('/api/entries/:id/publish', (req, res) => {
  cleanupAuthState();
  const isAdmin = isAdminAuthenticated(req);
  const user = getUserFromRequest(req);
  if (!isAdmin && !user) return res.status(403).json({ error: 'Not authorized.' });

  const { publish } = req.body;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid entry ID.' });

  const publishedValue = publish ? 1 : 0;

  // Admins can publish any entry; users can only publish their own
  const sql = isAdmin
    ? 'UPDATE entries SET published = ? WHERE id = ?'
    : 'UPDATE entries SET published = ? WHERE id = ? AND (user_id = ? OR user_id IS NULL)';
  const params = isAdmin ? [publishedValue, id] : [publishedValue, id, user.userId];

  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ error: 'Failed to update publish status.' });
    if (this.changes === 0) return res.status(404).json({ error: 'Entry not found.' });
    res.json({ success: true, published: publishedValue });
  });
});

app.delete('/api/entries/:id', (req, res) => {
  cleanupAuthState();

  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Invalid entry ID.' });
  }

  const sql = 'DELETE FROM entries WHERE id = ?';
  db.run(sql, [id], function (err) {
    if (err) {
      return res.status(500).json({ error: 'Failed to delete entry.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Entry not found.' });
    }
    res.json({ success: true });
  });
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
  clearCookie(res, 'admin_sid');
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

  createAdminSession(res);
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
  createAdminSession(res);
  res.json({ success: true, authenticated: true });
});

app.get(['/', '/page1'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'page1.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/page2', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'page2.html'));
});

app.get('/page3', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'page3.html'));
});

app.get('/page4', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'page4.html'));
});

app.get('/dreamstate', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dreamstate.html'));
});

app.get('/library', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'library.html'));
});

app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'support.html'));
});

app.get('/published', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'public.html'));
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`My Permanent Blog running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
