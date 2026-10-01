// server.js — serves your pages, verifies the customer's SLT login, and
// sources the consent list + Accept/Decline from ConsentHub (CMS).
// Also sends/verifies an email OTP before a consent can be ACCEPTED.
// Run this and open http://localhost:5500 — the page MUST be loaded from here,
// otherwise /api/v1/customer/consents/:id (PUT) goes to SLT and returns 404.
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto');

// ---------------------------------------------------------------- .env loader (no dependency)
(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      const val = m[2].replace(/^["']|["']$/g, '');
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch (_) { /* no .env file — rely on real environment variables */ }
})();

// ---------------------------------------------------------------- config
const TARGET = 'dpdlab1.slt.lk', TARGET_PORT = 9000, PORT = process.env.PORT || 5500;
const CMS_API_BASE = process.env.CMS_API_BASE || 'https://dpdlab1.slt.lk:9000';
const CMS_API_KEY = process.env.CMS_API_KEY;   // NEVER hardcode this. Put it in .env

if (!CMS_API_KEY) {
  console.error('Missing CMS_API_KEY. Create a .env file next to server.js containing:\nCMS_API_KEY=your-new-key');
  process.exit(1);
}

const types = {
  '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.ico': 'image/x-icon'
};

// ---------------------------------------------------------------- small helpers
const pick = (o, keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return ''; };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function findArray(json) {
  if (Array.isArray(json)) return json;
  const d = json && (json.data ?? json);
  if (Array.isArray(d)) return d;
  for (const k of ['consents', 'items', 'results', 'records', 'catalog']) {
    if (d && Array.isArray(d[k])) return d[k];
  }
  return null;
}

function customerFromToken(auth) {
  const t = (auth || '').replace(/^Bearer\s+/i, '');
  const parts = t.split('.');
  if (parts.length < 2) return { id: null, claims: [] };
  try {
    const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const keys = ['customerId', 'customer_id', 'custId', 'cid', 'sub', 'nameid', 'id', 'userId', 'user_id',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier',
      'unique_name', 'preferred_username', 'username'];
    for (const k of keys) if (p[k]) return { id: String(p[k]), claims: Object.keys(p) };
    return { id: null, claims: Object.keys(p) };
  } catch (_) { return { id: null, claims: [] }; }
}

function upstreamGet(p, auth) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: TARGET, port: TARGET_PORT, path: p, method: 'GET',
      headers: { Accept: 'application/json', Authorization: auth, 'Accept-Encoding': 'identity' }
    }, resp => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function authenticate(auth) {
  const up = await upstreamGet('/api/v1/customer/consents', auth);
  if (up.status !== 200) return { ok: false, status: up.status };
  let json; try { json = JSON.parse(up.body.toString('utf8')); } catch (_) { return { ok: false, status: 502 }; }
  const list = findArray(json) || [];
  const fromRecord = list.map(r => pick(r, ['customerId', 'partyId'])).find(Boolean);
  const id = fromRecord || customerFromToken(auth).id;
  if (!id) return { ok: false, status: 400 };
  return { ok: true, customerId: String(id) };
}

// ---------------------------------------------------------------- CMS integration
function cmsRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const base = new URL(CMS_API_BASE);
    const isHttps = base.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json', 'x-api-key': CMS_API_KEY };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }

    const r = lib.request({
      host: base.hostname, port: base.port || (isHttps ? 443 : 80), path: urlPath, method, headers
    }, resp => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* leave null */ }
        resolve({ status: resp.statusCode, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ---------------------------------------------------------------- MongoDB: OTP request log
// Every OTP request is saved for audit. The code itself (and its hash) is NEVER saved.
// Env (.env): MONGODB_URI (required to log), MONGODB_DB (default consent_portal), MONGODB_OTP_COLLECTION (default otp_requests)
// If MongoDB is missing/down the OTP flow still works; the problem is printed in this terminal.
let mongoColl = null, mongoFailedAt = 0, mongoWarned = false;

async function otpCollection() {
  if (mongoColl) return mongoColl;
  if (!process.env.MONGODB_URI) {
    if (!mongoWarned) { console.warn('MONGODB_URI not set: OTP requests will NOT be saved to the database.'); mongoWarned = true; }
    return null;
  }
  if (Date.now() - mongoFailedAt < 30000) return null;   // don't retry on every request while it is down
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const coll = client.db(process.env.MONGODB_DB || 'consent_portal')
      .collection(process.env.MONGODB_OTP_COLLECTION || 'otp_requests');
    await coll.createIndex({ reference: 1 }, { unique: true });
    await coll.createIndex({ customerId: 1, consentCode: 1, requestedAt: -1 });
    mongoColl = coll;
    console.log('MongoDB connected: OTP requests are saved to ' + coll.dbName + '.' + coll.collectionName);
    return coll;
  } catch (e) {
    mongoFailedAt = Date.now();
    console.error('MongoDB error:', e.code === 'MODULE_NOT_FOUND' ? 'mongodb package missing (run: npm install mongodb)' : e.message);
    return null;
  }
}

async function dbInsert(doc) {
  try { const c = await otpCollection(); if (c) await c.insertOne(doc); }
  catch (e) { console.error('MongoDB insert failed:', e.message); }
}
async function dbUpdate(filter, update) {
  try { const c = await otpCollection(); if (c) await c.updateOne(filter, update); }
  catch (e) { console.error('MongoDB update failed:', e.message); }
}
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64);

// ---------------------------------------------------------------- email OTP
// Codes are generated and checked ONLY here on the server; the code is never sent to the browser.
// Env (.env):  EMAIL_USER + EMAIL_PASS (or SMTP_USER + SMTP_PASS); optional SMTP_HOST (default smtp.gmail.com), SMTP_PORT (587), SMTP_SECURE, SMTP_FROM
//              OTP_DEV_LOG=true  -> prints the code in this terminal instead of emailing (testing only)
const OTP_TTL_MS = 5 * 60 * 1000;          // a code is valid for 5 minutes
const VERIFIED_TTL_MS = 10 * 60 * 1000;    // after verifying, the customer has 10 minutes to press Accept
const RESEND_MS = 30 * 1000;               // minimum gap between codes
const MAX_ATTEMPTS = 5;                    // wrong guesses allowed per code
const MAX_SENDS_PER_HOUR = 5;              // codes per customer per consent per hour

const otpStore = new Map();       // reference -> { customerId, consentCode, email, salt, hash, expires, attempts }
const verifiedStore = new Map();  // "customerId|consentCode" -> { exp, reference }
const sendLog = new Map();        // "customerId|consentCode" -> [timestamps]

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpStore) if (v.expires < now) otpStore.delete(k);
  for (const [k, v] of verifiedStore) if (v.exp < now) verifiedStore.delete(k);
  for (const [k, v] of sendLog) { const keep = v.filter(t => now - t < 3600000); keep.length ? sendLog.set(k, keep) : sendLog.delete(k); }
}, 60 * 1000).unref();

const hashOtp = (otp, salt) => crypto.createHash('sha256').update(salt + otp).digest('hex');

async function sendOtpEmail(to, otp) {
  // Accepts SMTP_USER/SMTP_PASS or EMAIL_USER/EMAIL_PASS. Host defaults to Gmail when only a user/pass is given.
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
  const host = process.env.SMTP_HOST || (user ? 'smtp.gmail.com' : '');

  if (!host || !user || !pass) {
    if (process.env.OTP_DEV_LOG === 'true') { console.log(`[DEV] OTP for ${to}: ${otp}`); return; }
    const e = new Error('Email credentials not set'); e.userMessage = 'The email service is not configured on the server.'; throw e;
  }
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (_) { const e = new Error('nodemailer not installed (run: npm install nodemailer)'); e.userMessage = 'The email service is not set up on the server.'; throw e; }

  const transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass: pass.replace(/\s+/g, '') }   // Gmail app passwords are shown with spaces; they must be removed
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM || user,
    to,
    subject: 'Your SLT Mobitel verification code',
    text: `Your verification code is ${otp}.\n\nIt expires in 5 minutes. If you did not request this, you can ignore this email.`
  });
}

async function handleOtp(req, res, kind) {
  const auth = req.headers.authorization;
  if (!auth) return sendJson(res, 401, { message: 'Missing token.' });

  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
  catch (_) { return sendJson(res, 400, { message: 'Invalid JSON.' }); }

  let a;
  try { a = await authenticate(auth); } catch (e) { return sendJson(res, 502, { message: 'Could not reach SLT API: ' + e.message }); }
  if (!a.ok) return sendJson(res, a.status === 401 ? 401 : 502, { message: 'Token check failed (' + a.status + ').' });

  const consentCode = String(body.consentId || '').slice(0, 100);
  const email = String(body.email || '').trim().toLowerCase();
  if (!consentCode) return sendJson(res, 400, { message: 'consentId is required.' });
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return sendJson(res, 400, { message: 'Enter a valid email address.' });

  const key = a.customerId + '|' + consentCode;
  const now = Date.now();

  // ---------- send ----------
  if (kind === 'send') {
    const log = (sendLog.get(key) || []).filter(t => now - t < 3600000);
    if (log.length && now - log[log.length - 1] < RESEND_MS) return sendJson(res, 429, { message: 'Please wait a few seconds before requesting another code.' });
    if (log.length >= MAX_SENDS_PER_HOUR) return sendJson(res, 429, { message: 'Too many codes requested. Please try again later.' });

    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const salt = crypto.randomBytes(8).toString('hex');
    const reference = crypto.randomBytes(12).toString('hex');

    const meta = { ip: clientIp(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 200) };
    try { await sendOtpEmail(email, otp); }
    catch (e) {
      console.error('OTP email error:', e.message);
      await dbInsert({ reference, customerId: a.customerId, consentCode, email, channel: 'EMAIL', status: 'FAILED',
        failureReason: String(e.message).slice(0, 200), attempts: 0, requestedAt: new Date(now), ...meta });
      return sendJson(res, 503, { message: e.userMessage || 'Could not send the email. Please try again.' });
    }

    for (const [ref, rec] of otpStore) if (rec.customerId === a.customerId && rec.consentCode === consentCode) otpStore.delete(ref);
    otpStore.set(reference, { customerId: a.customerId, consentCode, email, salt, hash: hashOtp(otp, salt), expires: now + OTP_TTL_MS, attempts: 0 });
    log.push(now); sendLog.set(key, log);
    await dbInsert({ reference, customerId: a.customerId, consentCode, email, channel: 'EMAIL', status: 'SENT',
      attempts: 0, requestedAt: new Date(now), expiresAt: new Date(now + OTP_TTL_MS), ...meta });
    return sendJson(res, 200, { success: true, reference, expiresInSeconds: OTP_TTL_MS / 1000 });
  }

  // ---------- verify ----------
  const reference = String(body.reference || '');
  const otp = String(body.otp || '').replace(/\D/g, '');
  const rec = otpStore.get(reference);
  if (!rec || rec.customerId !== a.customerId || rec.consentCode !== consentCode || rec.email !== email) {
    return sendJson(res, 400, { message: 'Invalid or expired code. Please request a new one.' });
  }
  if (now > rec.expires) { otpStore.delete(reference); await dbUpdate({ reference }, { $set: { status: 'EXPIRED' } }); return sendJson(res, 400, { message: 'This code has expired. Please request a new one.' }); }
  if (otp.length !== 6) return sendJson(res, 400, { message: 'Enter the full 6-digit code.' });

  rec.attempts++;
  if (rec.attempts > MAX_ATTEMPTS) { otpStore.delete(reference); await dbUpdate({ reference }, { $set: { status: 'LOCKED', lockedAt: new Date() } }); return sendJson(res, 429, { message: 'Too many wrong attempts. Please request a new code.' }); }

  const given = Buffer.from(hashOtp(otp, rec.salt)), real = Buffer.from(rec.hash);
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
    await dbUpdate({ reference }, { $inc: { attempts: 1 }, $set: { lastAttemptAt: new Date() } });
    return sendJson(res, 400, { message: 'Incorrect code. ' + (MAX_ATTEMPTS - rec.attempts) + ' attempt(s) left.' });
  }

  otpStore.delete(reference);
  verifiedStore.set(key, { exp: now + VERIFIED_TTL_MS, reference });
  await dbUpdate({ reference }, { $set: { status: 'VERIFIED', verifiedAt: new Date() }, $inc: { attempts: 1 } });
  return sendJson(res, 200, { success: true });
}

// ---------------------------------------------------------------- local consent API
const RE_LIST = /^\/api\/v1\/customer\/consents(\?.*)?$/;
const RE_ONE = /^\/api\/v1\/customer\/consents\/([^/?]+)(\/history)?(\?.*)?$/;
const RE_OTP = /^\/api\/v1\/customer\/otp\/(send|verify)(\?.*)?$/;

async function handleConsentApi(req, res) {
  const url = req.url;
  const mOne = RE_ONE.exec(url);
  const mOtp = RE_OTP.exec(url);

  if (mOtp && req.method === 'POST') { await handleOtp(req, res, mOtp[1]); return true; }
  if (mOne && !mOne[2] && req.method === 'PUT') { await handleSave(req, res, decodeURIComponent(mOne[1])); return true; }
  if (RE_LIST.test(url) && req.method === 'GET') { await handleList(req, res); return true; }
  return false; // everything else is forwarded to SLT (login, etc.)
}

async function handleList(req, res) {
  const auth = req.headers.authorization;
  if (!auth) return sendJson(res, 401, { message: 'Missing token.' });

  let a;
  try { a = await authenticate(auth); } catch (e) { return sendJson(res, 502, { message: 'Could not reach SLT API: ' + e.message }); }
  if (!a.ok) return sendJson(res, a.status === 401 ? 401 : 502, { message: 'Token check failed (' + a.status + ').' });

  let cms;
  try { cms = await cmsRequest('GET', `/api/v2/integration/consents/customer/${encodeURIComponent(a.customerId)}`); }
  catch (e) { return sendJson(res, 502, { message: 'Could not reach ConsentHub: ' + e.message }); }

  if (cms.status !== 200 || !cms.json?.success || !Array.isArray(cms.json.data)) {
    console.error('ConsentHub list error:', cms.status, JSON.stringify(cms.json));
    return sendJson(res, 502, { message: 'ConsentHub returned an error (' + cms.status + ').' });
  }

  // CMS sends card text in EN/SI/TA under c.texts, plus Data/Action/Used By/Valid
  // For instead of a version number. This page has no language switcher yet, so
  // it shows English; texts/data/action/usedBy/validFor are passed through
  // untouched for whenever that's added.
  const data = cms.json.data.map(c => {
    const en = c.texts?.EN || {};
    return {
      id: c.consentCode,
      consentCode: c.consentCode,
      consentName: en.title,
      status: c.consentStatus,
      isMandatory: c.isMandatory,
      description: en.statement,
      texts: c.texts,
      data: c.data,
      action: c.action,
      usedBy: c.usedBy,
      validFor: c.validFor,
      effectiveFrom: c.effectiveFrom,
      effectiveTo: c.effectiveTo,
    };
  });
  return sendJson(res, 200, { success: true, data });
}

async function handleSave(req, res, consentCode) {
  const auth = req.headers.authorization;
  if (!auth) return sendJson(res, 401, { message: 'Missing token.' });

  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
  catch (_) { return sendJson(res, 400, { message: 'Invalid JSON.' }); }

  const action = body.action;
  if (action !== 'accept' && action !== 'decline') return sendJson(res, 400, { message: "action must be 'accept' or 'decline'." });
  const channel = String(body.channel || 'web').slice(0, 30);

  let a;
  try { a = await authenticate(auth); } catch (e) { return sendJson(res, 502, { message: 'Could not reach SLT API: ' + e.message }); }
  if (!a.ok) return sendJson(res, a.status === 401 ? 401 : 502, { message: 'Token check failed (' + a.status + ').' });

  // Accepting requires a verified email OTP (enforced here, so it can't be skipped from the browser).
  const verifyKey = a.customerId + '|' + consentCode;
  if (action === 'accept') {
    const v = verifiedStore.get(verifyKey);
    if (!v || v.exp < Date.now()) return sendJson(res, 403, { message: 'Please verify your email with a one-time code before accepting.' });
  }

  let cms;
  try { cms = await cmsRequest('POST', '/api/v2/integration/consents/events', { customerId: a.customerId, consentCode, action, channel }); }
  catch (e) { return sendJson(res, 502, { message: 'Could not reach ConsentHub: ' + e.message }); }

  if (cms.status !== 200) {
    console.error('ConsentHub save error:', cms.status, JSON.stringify(cms.json));
    return sendJson(res, cms.status, { message: cms.json?.message || 'ConsentHub rejected the request.' });
  }
  if (action === 'accept') {                                  // one verification = one accept
    const v = verifiedStore.get(verifyKey);
    verifiedStore.delete(verifyKey);
    if (v) await dbUpdate({ reference: v.reference }, { $set: { consentAcceptedAt: new Date(), consentAction: 'accept' } });
  }
  return sendJson(res, 200, { customerConsentId: cms.json.customerConsentId, status: cms.json.consentStatus, changed: true });
}

// ---------------------------------------------------------------- forward everything else to SLT
function forwardToSlt(req, res) {
  const headers = { ...req.headers, host: TARGET + ':' + TARGET_PORT };
  delete headers.origin; delete headers.referer;
  const proxy = https.request(
    { host: TARGET, port: TARGET_PORT, path: req.url, method: req.method, headers },
    r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  proxy.on('error', e => { res.writeHead(502); res.end('Proxy error: ' + e.message); });
  req.pipe(proxy);
}

// ---------------------------------------------------------------- web server
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    try {
      if (await handleConsentApi(req, res)) return;
    } catch (e) {
      console.error('Consent API error:', e);
      if (!res.headersSent) sendJson(res, 500, { message: 'Server error.' });
      return;
    }
    return forwardToSlt(req, res);
  }

  const rel = req.url === '/' ? 'login.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(__dirname, rel);
  // block path traversal and never serve secrets / source files
  const base = path.basename(file).toLowerCase();
  if (!file.startsWith(__dirname) || ['.env', 'server.js', 'proxy.js', 'package.json', 'package-lock.json', '.gitignore'].includes(base)) {
    res.writeHead(403); return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('Open http://localhost:' + PORT + ' — consents backed by ConsentHub at ' + CMS_API_BASE);
  otpCollection();   // connect to MongoDB now so the status line prints at startup
});
