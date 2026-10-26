// patch.js - run in your project folder:  node patch.js
// Edits my-consent.html and server.js in place (backups: *.bak). Safe to re-run: already-patched files are skipped.
const fs = require('fs');

function patch(file, edits, doneMarker) {
  if (!fs.existsSync(file)) { console.log('SKIP  ' + file + ' (not found in this folder)'); return; }
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes(doneMarker)) { console.log('SKIP  ' + file + ' (already patched)'); return; }
  const crlf = raw.includes('\r\n');
  let txt = raw.replace(/\r\n/g, '\n');
  let ok = 0, bad = 0;
  for (const [from, to, want = 1] of edits) {
    const n = txt.split(from).length - 1;
    if (n !== want) { bad++; console.log('  FAIL (found ' + n + ', expected ' + want + '): ' + from.slice(0, 70).replace(/\n/g, '\\n')); continue; }
    txt = txt.split(from).join(to); ok++;
  }
  fs.writeFileSync(file + '.bak', raw);
  fs.writeFileSync(file, crlf ? txt.replace(/\n/g, '\r\n') : txt);
  console.log((bad ? 'PART  ' : 'OK    ') + file + ': ' + ok + ' edits applied, ' + bad + ' failed (backup: ' + file + '.bak)');
}

// ------------------------------------------------------------------ translations + helpers (HTML)
const I18N = String.raw`let currentConsentCode = null;

  // ---- UI translations (EN / SI / TA) ----
  const UI_TEXT = {
    EN: { back:'← Back', logout:'Logout', title:'My Consents', mandatory:'Mandatory consents',
      mandatoryNote:'Needed to provide your service, so these cannot be switched off here.', optional:'Optional consents',
      loading:'Loading your consents…', required:'🔒 Required', locked:'🔒 Cannot be withdrawn', view:'View details',
      verifyTitle:'Verify Your Email', emailLabel:'Email Address', sendOtp:'Send OTP', confirm:'Confirm',
      successTitle:'Consent Confirmed', done:'Done' },
    SI: { back:'← ආපසු', logout:'ඉවත් වන්න', title:'මගේ කැමැත්ත', mandatory:'අනිවාර්ය කැමැත්ත',
      mandatoryNote:'ඔබේ සේවාව සැපයීමට අවශ්‍ය බැවින් මේවා මෙහිදී ක්‍රියාවිරහිත කළ නොහැක.', optional:'විකල්ප කැමැත්ත',
      loading:'ඔබේ කැමැත්ත පූරණය වෙමින්…', required:'🔒 අවශ්‍යයි', locked:'🔒 ඉවත් කළ නොහැක', view:'විස්තර බලන්න',
      verifyTitle:'ඔබේ ඊමේල් තහවුරු කරන්න', emailLabel:'ඊමේල් ලිපිනය', sendOtp:'OTP යවන්න', confirm:'තහවුරු කරන්න',
      successTitle:'කැමැත්ත තහවුරු විය', done:'අවසන්' },
    TA: { back:'← பின்செல்', logout:'வெளியேறு', title:'என் ஒப்புதல்கள்', mandatory:'கட்டாய ஒப்புதல்கள்',
      mandatoryNote:'உங்கள் சேவையை வழங்க இவை அவசியம், எனவே இங்கே அவற்றை அணைக்க முடியாது.', optional:'விருப்ப ஒப்புதல்கள்',
      loading:'உங்கள் ஒப்புதல்கள் ஏற்றப்படுகின்றன…', required:'🔒 கட்டாயம்', locked:'🔒 திரும்பப் பெற முடியாது', view:'விவரங்களைக் காண்க',
      verifyTitle:'உங்கள் மின்னஞ்சலை சரிபார்க்கவும்', emailLabel:'மின்னஞ்சல் முகவரி', sendOtp:'OTP அனுப்பு', confirm:'உறுதிப்படுத்து',
      successTitle:'ஒப்புதல் உறுதிப்படுத்தப்பட்டது', done:'முடிந்தது' }
  };
  const t = k => (UI_TEXT[currentLang] && UI_TEXT[currentLang][k]) || UI_TEXT.EN[k] || k;
  function applyStaticText() {
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.documentElement.lang = currentLang.toLowerCase();
  }`;

const htmlEdits = [
  // 1. relative API paths (work locally AND under /myslt/ on the hosted server)
  ["'/api/v1/customer/consents'", "'api/v1/customer/consents'"],
  ["'/api/v1/customer/consents/{code}'", "'api/v1/customer/consents/{code}'"],
  ["'/api/v1/customer/otp/send'", "'api/v1/customer/otp/send'"],
  ["'/api/v1/customer/otp/verify'", "'api/v1/customer/otp/verify'"],
  // 2. translatable static text
  ['>← Back</button>', ' data-i18n="back">← Back</button>'],
  ['id="logoutBtn" style="display:none;">Logout</button>', 'id="logoutBtn" data-i18n="logout" style="display:none;">Logout</button>'],
  ['<h1>My Consents</h1>', '<h1 data-i18n="title">My Consents</h1>'],
  ['id="loadingMsg" class="empty-msg">', 'id="loadingMsg" class="empty-msg" data-i18n="loading">'],
  ['<h2>Mandatory consents</h2>', '<h2 data-i18n="mandatory">Mandatory consents</h2>'],
  ['<p class="section-note">', '<p class="section-note" data-i18n="mandatoryNote">'],
  ['<h2>Optional consents</h2>', '<h2 data-i18n="optional">Optional consents</h2>'],
  ['<h2>Verify Your Email</h2>', '<h2 data-i18n="verifyTitle">Verify Your Email</h2>'],
  ['<label for="emailInput">Email Address</label>', '<label for="emailInput" data-i18n="emailLabel">Email Address</label>'],
  ['id="sendOtpBtn">Send OTP</button>', 'id="sendOtpBtn" data-i18n="sendOtp">Send OTP</button>'],
  ['id="confirmOtpBtn">Confirm</button>', 'id="confirmOtpBtn" data-i18n="confirm">Confirm</button>'],
  ['<h2>Consent Confirmed</h2>', '<h2 data-i18n="successTitle">Consent Confirmed</h2>'],
  ['id="closeVerifyBtn">Done</button>', 'id="closeVerifyBtn" data-i18n="done">Done</button>'],
  // 3. translation table + helpers
  ['let currentConsentCode = null;', I18N],
  // 4. dynamic text
  ["const lockText = c.mandatory ? '🔒 Required' : '🔒 Cannot be withdrawn';", "const lockText = c.mandatory ? t('required') : t('locked');"],
  ['<button class="view-btn" data-view="1">View details</button>', "<button class=\"view-btn\" data-view=\"1\">${esc(t('view'))}</button>"],
  ["sendOtpBtn.textContent = 'Send OTP'", "sendOtpBtn.textContent = t('sendOtp')", 2],
  ["confirmOtpBtn.textContent = 'Confirm'", "confirmOtpBtn.textContent = t('confirm')", 2],
  // 5. re-translate when the dropdown changes, and on first load
  ["catch (_) {}\n    renderConsentList(lastLoadedList);", "catch (_) {}\n    applyStaticText();\n    renderConsentList(lastLoadedList);"],
  ['if (getToken()) { showConsents(); loadConsents(); }', 'applyStaticText();\n  if (getToken()) { showConsents(); loadConsents(); }'],
];

// ------------------------------------------------------------------ server.js
const DECLINE_CHECK = String.raw`if (action === 'decline') {   // mandatory consents can never be withdrawn (enforced here, not just in the UI)
    let lst;
    try { lst = await cmsRequest('GET', '/api/v2/integration/consents/customer/' + encodeURIComponent(a.customerId)); }
    catch (e) { return sendJson(res, 502, { message: 'Could not reach ConsentHub: ' + e.message }); }
    const found = Array.isArray(lst.json && lst.json.data) ? lst.json.data.find(c => c.consentCode === consentCode) : null;
    if (!found) return sendJson(res, 404, { message: 'Consent not found.' });
    if (found.isMandatory) return sendJson(res, 403, { message: 'This consent is required and cannot be withdrawn.' });
  }

  let cms;
  try { cms = await cmsRequest('POST'`;

const serverEdits = [
  // DNS override: moved after .env is read, and can be turned off with USE_PUBLIC_DNS=false
  ["dns.setServers(['8.8.8.8', '1.1.1.1']);\n", ''],
  ['// ---------------------------------------------------------------- config\n',
   "if (process.env.USE_PUBLIC_DNS !== 'false') dns.setServers(['8.8.8.8', '1.1.1.1']);   // set USE_PUBLIC_DNS=false in .env on internal hosts\n\n// ---------------------------------------------------------------- config\n"],
  // mandatory decline check
  ["let cms;\n  try { cms = await cmsRequest('POST'", DECLINE_CHECK],
  // BASE_PATH support (hosted under /myslt/)
  ['const server = http.createServer(async (req, res) => {\n',
   "const BASE_PATH = (process.env.BASE_PATH || '').replace(/\\/+$/, '');   // e.g. BASE_PATH=/myslt when a gateway forwards /myslt/* here\n" +
   'const server = http.createServer(async (req, res) => {\n' +
   "  if (BASE_PATH && (req.url === BASE_PATH || req.url.startsWith(BASE_PATH + '/') || req.url.startsWith(BASE_PATH + '?'))) req.url = req.url.slice(BASE_PATH.length) || '/';\n"],
  // safer static serving
  ["const rel = req.url === '/' ? 'login.html' : decodeURIComponent(req.url.split('?')[0]);",
   "let rel; try { rel = req.url === '/' ? 'login.html' : decodeURIComponent(req.url.split('?')[0]); } catch (_) { res.writeHead(400); return res.end(); }"],
  ['if (!file.startsWith(__dirname) ||',
   "if (!file.startsWith(__dirname + path.sep) || path.relative(__dirname, file).split(path.sep).some(p => p.startsWith('.') || p === 'node_modules') ||"],
];

patch('my-consent.html', htmlEdits, 'UI_TEXT');
patch('server.js', serverEdits, 'USE_PUBLIC_DNS');
console.log('\nDone. Restart the server: node server.js');
