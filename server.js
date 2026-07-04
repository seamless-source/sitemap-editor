const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sitemap.json');
const MINDMAPS_DIR = path.join(DATA_DIR, 'mindmaps');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MINDMAPS_DIR)) fs.mkdirSync(MINDMAPS_DIR, { recursive: true });

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

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
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

  // ─── Mind Maps API ─────────────────────────────────────────
  // LIST all mind maps
  if (pathname === '/api/mindmaps' && req.method === 'GET') {
    if (!isAuthenticated(req)) return send(res, 401, JSON.stringify({ error: 'Unauthorized' }), 'application/json');
    try {
      const files = fs.readdirSync(MINDMAPS_DIR).filter(f => f.endsWith('.json'));
      const maps = files.map(f => {
        const data = readJsonFile(path.join(MINDMAPS_DIR, f), null);
        if (!data) return null;
        return { id: data.id, name: data.name, type: data.type, createdAt: data.createdAt, updatedAt: data.updatedAt, nodeCount: (data.nodes || []).length };
      }).filter(Boolean).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return send(res, 200, JSON.stringify(maps), 'application/json');
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: 'Failed to list mind maps' }), 'application/json');
    }
  }

  // CREATE a new mind map
  if (pathname === '/api/mindmaps' && req.method === 'POST') {
    if (!isAuthenticated(req)) return send(res, 401, JSON.stringify({ error: 'Unauthorized' }), 'application/json');
    readBody(req).then(body => {
      const data = safeJsonParse(body);
      if (!data || !data.name) return send(res, 400, JSON.stringify({ error: 'Name is required' }), 'application/json');
      const id = generateId();
      const now = new Date().toISOString();
      const mindmap = {
        id, name: data.name, type: data.type || 'freeform',
        createdAt: now, updatedAt: now,
        nodes: data.nodes || [], connections: data.connections || [],
        nextNodeId: data.nextNodeId || 1, nextConnId: data.nextConnId || 1,
        viewState: { x: 0, y: 0, zoom: 1 },
        settings: data.settings || {}
      };
      fs.writeFile(path.join(MINDMAPS_DIR, `${id}.json`), JSON.stringify(mindmap, null, 2), err => {
        if (err) return send(res, 500, JSON.stringify({ error: 'Failed to create' }), 'application/json');
        return send(res, 201, JSON.stringify({ id, name: mindmap.name, type: mindmap.type, createdAt: now }), 'application/json');
      });
    }).catch(() => send(res, 400, JSON.stringify({ error: 'Invalid request' }), 'application/json'));
    return;
  }

  // GET / POST / DELETE a specific mind map
  const mmMatch = pathname.match(/^\/api\/mindmaps\/([a-z0-9]+)$/);
  if (mmMatch) {
    if (!isAuthenticated(req)) return send(res, 401, JSON.stringify({ error: 'Unauthorized' }), 'application/json');
    const mmId = mmMatch[1];
    const mmFile = path.join(MINDMAPS_DIR, `${mmId}.json`);

    if (req.method === 'GET') {
      const data = readJsonFile(mmFile, null);
      if (!data) return send(res, 404, JSON.stringify({ error: 'Mind map not found' }), 'application/json');
      return send(res, 200, JSON.stringify(data), 'application/json');
    }

    if (req.method === 'POST') {
      readBody(req).then(body => {
        const data = safeJsonParse(body);
        if (!data) return send(res, 400, JSON.stringify({ error: 'Invalid JSON' }), 'application/json');
        data.updatedAt = new Date().toISOString();
        data.id = mmId;
        fs.writeFile(mmFile, JSON.stringify(data, null, 2), err => {
          if (err) return send(res, 500, JSON.stringify({ error: 'Failed to save' }), 'application/json');
          return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
        });
      }).catch(() => send(res, 400, JSON.stringify({ error: 'Invalid request' }), 'application/json'));
      return;
    }

    if (req.method === 'DELETE') {
      fs.unlink(mmFile, err => {
        if (err && err.code === 'ENOENT') return send(res, 404, JSON.stringify({ error: 'Not found' }), 'application/json');
        if (err) return send(res, 500, JSON.stringify({ error: 'Failed to delete' }), 'application/json');
        return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
      });
      return;
    }

    return send(res, 405, 'Method Not Allowed');
  }

  // ─── Settings API ──────────────────────────────────────────
  if (pathname === '/api/settings') {
    if (!isAuthenticated(req)) return send(res, 401, JSON.stringify({ error: 'Unauthorized' }), 'application/json');

    if (req.method === 'GET') {
      const data = readJsonFile(SETTINGS_FILE, {});
      return send(res, 200, JSON.stringify(data), 'application/json');
    }

    if (req.method === 'POST') {
      readBody(req).then(body => {
        const data = safeJsonParse(body);
        if (!data) return send(res, 400, JSON.stringify({ error: 'Invalid JSON' }), 'application/json');
        fs.writeFile(SETTINGS_FILE, JSON.stringify(data, null, 2), err => {
          if (err) return send(res, 500, JSON.stringify({ error: 'Failed to save settings' }), 'application/json');
          return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
        });
      }).catch(() => send(res, 400, JSON.stringify({ error: 'Invalid request' }), 'application/json'));
      return;
    }

    return send(res, 405, 'Method Not Allowed');
  }

  // Authentication check for static files (only index.html needs protection)
  const isProtectedPath = pathname === '/' || pathname === '/index.html' || pathname === '/mindmaps.html';
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
