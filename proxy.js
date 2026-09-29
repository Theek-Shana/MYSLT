const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const TARGET = 'dpdlab1.slt.lk', TARGET_PORT = 9000, PORT = 5500;
const types = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.js': 'text/javascript' };

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {                       // forward API calls
    const headers = { ...req.headers, host: TARGET + ':' + TARGET_PORT };
    delete headers.origin; delete headers.referer;
    const proxy = https.request(
      { host: TARGET, port: TARGET_PORT, path: req.url, method: req.method, headers },
      r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    proxy.on('error', e => { res.writeHead(502); res.end('Proxy error: ' + e.message); });
    req.pipe(proxy);
    return;
  }
  const rel = req.url === '/' ? 'login.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(__dirname, rel);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {                       // serve your pages
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('Open http://localhost:' + PORT));