// server.js — serves your pages, proxies SLT APIs, and saves Accept/Decline + timeline to MongoDB.
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

// ---------------------------------------------------------------- config
const TARGET = 'dpdlab1.slt.lk', TARGET_PORT = 9000, PORT = 5500;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'consenthub';

// Same fallback the page uses when the API has no "mandatory" field.
const MANDATORY_CONSENT_CODES = ['TNC_001', 'PRIV_001', 'TNC_FAIR_USE', 'PRIV_DATA_RETENTION'];

const types = {
  '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.ico': 'image/x-icon'
};

let col = null; // MongoDB collection: consentChoices

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

// Same shapes the page understands.
function findArray(json) {
  if (Array.isArray(json)) return json;
  const d = json && (json.data ?? json);
  if (Array.isArray(d)) return d;
  for (const k of ['consents', 'items', 'results', 'records', 'catalog']) {
    if (d && Array.isArray(d[k])) return d[k];
  }
  return null;
}

// Same id logic as the page (customerConsentId, else scopeId).
function recordView(r) {
  const scope = (r.scope && typeof r.scope === 'object') ? r.scope
              : (r.consentScope && typeof r.consentScope === 'object') ? r.consentScope
              : (r.catalog && typeof r.catalog === 'object') ? r.catalog : {};
  const m = { ...scope, ...r };
  const scopeId = pick(m, ['scopeId', 'scope_id', 'consentScopeId']);
  const code = pick(m, ['scopeCode', 'code', 'consentCode']);
  let mandatory = pick(m, ['mandatory', 'isMandatory']);
  if (mandatory === '') mandatory = MANDATORY_CONSENT_CODES.includes(code);
  return {
    id: String(pick(m, ['customerConsentId', 'consentId', 'id']) || scopeId),
    customerId: String(pick(m, ['customerId', 'partyId']) || ''),
    code,
    name: pick(m, ['consentName', 'scopeName', 'name', 'title']) || code,
    status: String(pick(m, ['status', 'consentStatus', 'customerStatus'])).toUpperCase(),
    mandatory: mandatory === true || mandatory === 1 ||
               ['true', 'y', 'yes', '1'].includes(String(mandatory).toLowerCase())
  };
}

// Reads the customer id from the login token (JWT payload). The token itself is verified by asking SLT.
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

// Customer key: prefer the id SLT puts on the customer's own records; fall back to the token claim.
function customerKey(list, auth) {
  for (const r of list || []) { const c = recordView(r).customerId; if (c) return c; }
  return customerFromToken(auth).id;
}

function maskContact(v) {
  if (!v) return null;
  v = String(v).trim().slice(0, 150);
  const at = v.indexOf('@');
  if (at > 0) return v[0] + '***' + v.slice(at);
  return v.length > 6 ? v.slice(0, 2) + '*'.repeat(v.length - 6) + v.slice(-4) : '****';
}

// GET on the SLT API with the customer's own token. Returns { status, headers, body }.
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

// Validates the token by calling SLT, and returns that customer's consent records.
async function authenticate(auth) {
  const up = await upstreamGet('/api/v1/customer/consents', auth);
  if (up.status !== 200) return { ok: false, status: up.status };
  let json; try { json = JSON.parse(up.body.toString('utf8')); } catch (_) { return { ok: false, status: 502 }; }
  return { ok: true, list: findArray(json) || [], json };
}

// ---------------------------------------------------------------- local consent API
const RE_LIST = /^\/api\/v1\/customer\/consents(\?.*)?$/;
const RE_ONE = /^\/api\/v1\/customer\/consents\/([^/?]+)(\/history)?(\?.*)?$/;

async function handleConsentApi(req, res) {
  const url = req.url;
  const mOne = RE_ONE.exec(url);

  // PUT /api/v1/customer/consents/:id   -> save Accept / Decline
  if (mOne && !mOne[2] && req.method === 'PUT') { await handleSave(req, res, decodeURIComponent(mOne[1])); return true; }
  // GET /api/v1/customer/consents/:id/history -> timeline
  if (mOne && mOne[2] && req.method === 'GET') { await handleHistory(req, res, decodeURIComponent(mOne[1])); return true; }
  // GET /api/v1/customer/consents -> SLT list with our saved choices laid over it
  if (RE_LIST.test(url) && req.method === 'GET') { await handleList(req, res); return true; }
  return false; // everything else is forwarded to SLT
}

async function handleSave(req, res, consentId) {
  const auth = req.headers.authorization;
  if (!auth) return sendJson(res, 401, { message: 'Missing token.' });
  if (!col) return sendJson(res, 503, { message: 'MongoDB is not connected.' });

  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
  catch (_) { return sendJson(res, 400, { message: 'Invalid JSON.' }); }

  const action = body.action;
  if (action !== 'accept' && action !== 'decline') return sendJson(res, 400, { message: "action must be 'accept' or 'decline'." });
  const channel = String(body.channel || 'web').slice(0, 30);
  const source = String(body.source || 'UNKNOWN').slice(0, 60);
  const verificationMethod = ['phone', 'email'].includes(body.verificationMethod) ? body.verificationMethod : null;

  let a;
  try { a = await authenticate(auth); } catch (e) { return sendJson(res, 502, { message: 'Could not reach SLT API: ' + e.message }); }
  if (!a.ok) return sendJson(res, a.status === 401 ? 401 : 502, { message: 'Token check failed (' + a.status + ').' });

  const cust = { id: customerKey(a.list, auth) };
  if (!cust.id) {
    console.error('No customer id on SLT records or in token. Token claims:', customerFromToken(auth).claims);
    return sendJson(res, 400, { message: 'Customer id not found.' });
  }

  const views = a.list.map(recordView);
  const rec = views.find(v => v.id === String(consentId));
  if (!rec) {
    console.error('Consent', consentId, 'not found. Ids from SLT:', views.map(v => v.id));
    return sendJson(res, 404, { message: 'Consent not found.' });
  }

  if (action === 'decline' && rec.mandatory) return sendJson(res, 400, { message: 'This consent is mandatory and cannot be declined.' });

  const newStatus = action === 'accept' ? 'GRANTED' : 'REVOKED';
  const existing = await col.findOne({ customerId: cust.id, consentId: String(consentId) });
  const previousStatus = (existing && existing.status) || rec.status || 'PENDING';

  if (existing && existing.status === newStatus) {
    return sendJson(res, 200, { customerConsentId: consentId, status: newStatus, changed: false });
  }

  const now = new Date();
  const entry = {
    id: new ObjectId().toString(),
    action, previousStatus, newStatus, channel, source, verificationMethod,
    verifiedContactMasked: maskContact(body.verifiedContact),
    ipAddress: req.socket.remoteAddress || null,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    createdAt: now
  };

  const set = { status: newStatus, updatedAt: now, scopeCode: rec.code, consentName: rec.name };
  if (action === 'accept') { set.effectiveFrom = now; set.effectiveTo = null; }
  else { set.effectiveTo = now; }

  try {
    // Filter includes the old status, so two quick clicks cannot both win.
    const filter = existing
      ? { customerId: cust.id, consentId: String(consentId), status: existing.status }
      : { customerId: cust.id, consentId: String(consentId), status: { $exists: false } };
    const r = await col.updateOne(filter, { $set: set, $push: { history: entry } }, { upsert: !existing });
    if (!existing && r.upsertedCount === 0 && r.modifiedCount === 0) throw Object.assign(new Error('conflict'), { code: 11000 });
    if (existing && r.modifiedCount === 0) throw Object.assign(new Error('conflict'), { code: 11000 });
  } catch (e) {
    if (e.code === 11000) return sendJson(res, 409, { message: 'Consent was changed by another request. Refresh and try again.' });
    console.error('Mongo save failed:', e);
    return sendJson(res, 500, { message: 'Could not save.' });
  }

  return sendJson(res, 200, { customerConsentId: consentId, status: newStatus, changed: true, historyId: entry.id });
}

async function handleHistory(req, res, consentId) {
  const auth = req.headers.authorization;
  if (!auth) return sendJson(res, 401, { message: 'Missing token.' });
  if (!col) return sendJson(res, 503, { message: 'MongoDB is not connected.' });

  let a;
  try { a = await authenticate(auth); } catch (e) { return sendJson(res, 502, { message: 'Could not reach SLT API.' }); }
  if (!a.ok) return sendJson(res, a.status === 401 ? 401 : 502, { message: 'Token check failed.' });

  const cust = { id: customerKey(a.list, auth) };
  if (!cust.id) return sendJson(res, 400, { message: 'Customer id not found.' });

  const doc = await col.findOne({ customerId: cust.id, consentId: String(consentId) });
  const items = ((doc && doc.history) || [])
    .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt))
    .map(h => ({
      id: h.id, action: h.action, previousStatus: h.previousStatus, newStatus: h.newStatus,
      channel: h.channel, source: h.source, verificationMethod: h.verificationMethod,
      verifiedContact: h.verifiedContactMasked, createdAt: new Date(h.createdAt).toISOString()
    }));
  return sendJson(res, 200, { data: items });
}

async function handleList(req, res) {
  const auth = req.headers.authorization;
  let up;
  try { up = await upstreamGet(req.url, auth || ''); }
  catch (e) { return sendJson(res, 502, { message: 'Proxy error: ' + e.message }); }

  // Not OK, or Mongo/token unavailable -> return SLT's answer untouched.
  const passthrough = () => {
    const h = { ...up.headers }; delete h['transfer-encoding'];
    h['content-length'] = up.body.length;
    res.writeHead(up.status, h); res.end(up.body);
  };
  if (up.status !== 200 || !col) return passthrough();

  let json; try { json = JSON.parse(up.body.toString('utf8')); } catch (_) { return passthrough(); }
  const list = findArray(json);
  const cust = { id: list ? customerKey(list, auth) : null };
  if (!list || !cust.id) return passthrough();

  try {
    const docs = await col.find({ customerId: cust.id }).toArray();
    const byId = new Map(docs.map(d => [d.consentId, d]));
    for (const r of list) {
      const d = byId.get(recordView(r).id);
      if (!d) continue;
      r.status = d.status;                                   // top-level fields win over nested "scope"
      r.effectiveFrom = d.effectiveFrom ? d.effectiveFrom.toISOString() : null;
      r.effectiveTo = d.effectiveTo ? d.effectiveTo.toISOString() : null;
    }
  } catch (e) { console.error('Overlay failed:', e.message); return passthrough(); }

  return sendJson(res, 200, json);
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
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

async function start() {
  try {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    col = client.db(DB_NAME).collection('consentChoices');
    await col.createIndex({ customerId: 1, consentId: 1 }, { unique: true, name: 'ux_customer_consent' });
    console.log('MongoDB connected:', DB_NAME);
  } catch (e) {
    console.error('MongoDB NOT connected (' + e.message + '). Pages and SLT proxy still work; saving will not.');
  }
  server.listen(PORT, () => console.log('Open http://localhost:' + PORT));
}
start();