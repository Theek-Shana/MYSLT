// server.js — serves your pages, verifies the customer's SLT login, and
// sources the consent list + Accept/Decline from ConsentHub (CMS) instead
// of a local database. CMS is now the single source of truth for what
// consents exist and what the customer has decided.
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');

// ---------------------------------------------------------------- config
const TARGET = 'dpdlab1.slt.lk', TARGET_PORT = 9000, PORT = 5500;

// ConsentHub (CMS) — the shared consent API at /api/v2/integration/consents.
// CMS_API_KEY is MySLT's own key, issued in CMS under Recipients (MySLT) ->
// "Issue API key". Each organisation that integrates gets its own key from
// that same screen; this app only ever uses its one.
const CMS_API_BASE = process.env.CMS_API_BASE || 'https://dpdlab1.slt.lk:9000';
const CMS_API_KEY = process.env.CMS_API_KEY || 'e6b5fbaafbe2e0bdebae867e37e86c033928f38dca949fa8';

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

// Validates the token by calling SLT, and returns that customer's id.
// We only trust SLT for "is this a real, logged-in customer, and who are
// they" — the consent CONTENT itself now comes from CMS, not from here.
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

// ---------------------------------------------------------------- local consent API
const RE_LIST = /^\/api\/v1\/customer\/consents(\?.*)?$/;
const RE_ONE = /^\/api\/v1\/customer\/consents\/([^/?]+)(\/history)?(\?.*)?$/;

async function handleConsentApi(req, res) {
  const url = req.url;
  const mOne = RE_ONE.exec(url);

  // PUT /api/v1/customer/consents/:consentCode -> save Accept / Decline
  if (mOne && !mOne[2] && req.method === 'PUT') { await handleSave(req, res, decodeURIComponent(mOne[1])); return true; }
  // GET /api/v1/customer/consents -> catalog + this customer's status, from CMS
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
  if (cms.status !== 200 || !cms.json?.success) return sendJson(res, 502, { message: 'ConsentHub returned an error.' });

  // Shape each record so my-consent.html's own field-picking (code/id/status/mandatory) just works.
  const data = cms.json.data.map(c => ({
    id: c.consentCode,
    consentCode: c.consentCode,
    consentName: c.consentName,
    status: c.consentStatus,
    isMandatory: c.isMandatory,
    description: c.statement,
    version: c.consentVersion,
    effectiveFrom: c.effectiveFrom,
    effectiveTo: c.effectiveTo,
  }));
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

  let cms;
  try { cms = await cmsRequest('POST', '/api/v2/integration/consents/events', { customerId: a.customerId, consentCode, action, channel }); }
  catch (e) { return sendJson(res, 502, { message: 'Could not reach ConsentHub: ' + e.message }); }

  if (cms.status !== 200) return sendJson(res, cms.status, { message: cms.json?.message || 'ConsentHub rejected the request.' });
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
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('Open http://localhost:' + PORT + ' — consents backed by ConsentHub at ' + CMS_API_BASE));
