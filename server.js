const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sitemap.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeJsonParse(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function isAuthenticated(req) {
  const cookies = req.headers.cookie;
  if (!cookies) return false;
  return cookies.includes('auth_token=true');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const data = safeJsonParse(body);
      const masterPassword = process.env.PASSWORD || 'seamless123';
      if (data && data.password === masterPassword) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'auth_token=true; Path=/; HttpOnly; Max-Age=2592000'
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        send(res, 401, JSON.stringify({ error: 'Invalid password' }), 'application/json');
      }
    });
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'auth_token=; Path=/; HttpOnly; Max-Age=0'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/sitemap') {
    if (!isAuthenticated(req)) return send(res, 401, JSON.stringify({ error: 'Unauthorized' }), 'application/json');
    if (req.method === 'GET') {
      const data = readJsonFile(DATA_FILE, { nodes: [], links: [] });
      return send(res, 200, JSON.stringify(data), 'application/json; charset=utf-8');
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 10 * 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        const data = safeJsonParse(body);
        if (data === null) return send(res, 400, JSON.stringify({ error: 'Invalid JSON' }), 'application/json; charset=utf-8');
        fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), err => {
          if (err) return send(res, 500, JSON.stringify({ error: 'Failed to save sitemap' }), 'application/json; charset=utf-8');
          return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
        });
      });
      return;
    }

    return send(res, 405, 'Method Not Allowed');
  }

  // Authentication check for static files (only index.html needs protection)
  const isProtectedPath = pathname === '/' || pathname === '/index.html';
  if (isProtectedPath && !isAuthenticated(req)) {
    res.writeHead(302, { 'Location': '/login.html' });
    return res.end();
  }
  
  if (pathname === '/login.html' && isAuthenticated(req)) {
    res.writeHead(302, { 'Location': '/' });
    return res.end();
  }

  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (err, stat) => {
    if (err) {
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      return fs.readFile(fallback, (e2, data) => {
        if (e2) return send(res, 404, 'Not found');
        send(res, 200, data, 'text/html; charset=utf-8');
      });
    }
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (e, data) => {
      if (e) return send(res, 404, 'Not found');
      send(res, 200, data, contentType(filePath));
    });
  });
});

server.listen(PORT, () => console.log(`Sitemap editor running on http://127.0.0.1:${PORT}`));
