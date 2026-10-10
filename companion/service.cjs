'use strict';
const crypto = require('node:crypto');
const http = require('node:http');

// One queue for BOTH the native JAR UI and extension jobs. JAR owns one browser.
function createService({ express, jarApp, token, host = '127.0.0.1', port = 4577, publicOrigin = '' }) {
  if (!token || token.length < 32) throw new Error('JAR_TOKEN must contain at least 32 characters');
  if (publicOrigin) {
    const u = new URL(publicOrigin);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
      throw new Error('JAR_PUBLIC_ORIGIN must be an HTTPS origin without credentials or a path');
    publicOrigin = u.origin;
  }
  const app = express();
  app.disable('x-powered-by');
  const sessions = new Map(), jobs = new Map();
  let tail = Promise.resolve(), active = 0, queued = 0;
  const equal = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  function enqueue(fn) {
    queued++;
    const next = tail.then(async () => { queued--; active++; try { return await fn(); } finally { active--; } });
    tail = next.catch(() => {});
    return next;
  }
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Never accept cross-origin browser writes, even with a valid cookie.
    if (req.headers.origin && req.headers.origin !== (publicOrigin || `${req.protocol}://${req.headers.host}`))
      return res.status(403).json({ error: 'Cross-origin requests are disabled' });
    next();
  });
  app.get('/pair', (_req, res) => res.type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><title>Connect JAR</title><main style="max-width:32em;margin:10vh auto;font:18px system-ui"><h1>JAR Companion</h1><p>Enter the companion token printed by the launcher.</p><form method="post" action="/pair"><label>Companion token <input name="token" type="password" required autocomplete="off" style="width:100%"></label><button>Connect</button></form></main>'));
  app.post('/pair', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    if (!equal(req.body.token || '', token)) return res.status(401).send('Invalid token');
    const id = crypto.randomBytes(32).toString('hex');
    for (const [key, expiry] of sessions) if (expiry < Date.now()) sessions.delete(key);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    sessions.set(id, Date.now() + 12 * 3600000);
    res.setHeader('Set-Cookie', `jar_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${publicOrigin || req.secure ? '; Secure' : ''}`);
    res.redirect('/');
  });
  app.use((req, res, next) => {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const cookie = /(?:^|;\s*)jar_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    if (equal(bearer, token) || (cookie && (sessions.get(cookie) || 0) > Date.now())) return next();
    if (req.path === '/') return res.redirect('/pair');
    res.status(401).json({ error: 'Companion authentication required' });
  });
  app.use(express.json({ limit: '12mb' }));
  app.get('/bridge/v1/health', (_req, res) => res.json({ version: 1, service: 'jar-companion', active, queued }));
  const routes = {
    login: '/api/login', logout: '/api/logout', inspect: '/api/inspect', capture: '/api/capture',
    separate: '/api/separate', preview: '/api/extract-preview', build: '/api/extract',
    buildScript: '/api/public-script-build', chatExport: '/api/chat-export', chatLink: '/api/chat-import',
    conversations: '/api/character-conversations', saucepan: '/api/saucepan/extract',
  };
  let localOrigin;
  async function callJar(path, body, jobId) {
    const response = await fetch(`${localOrigin}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Jar-Job': jobId }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || `JAR returned ${response.status}`);
    return result;
  }
  app.post('/bridge/v1/jobs', (req, res) => {
    const { operation, input = {} } = req.body || {};
    if (!Object.hasOwn(routes, operation)) return res.status(400).json({ error: 'Unknown operation' });
    if (!input || typeof input !== 'object' || Array.isArray(input)) return res.status(400).json({ error: 'input must be an object' });
    if ([...jobs.values()].filter(j => j.state === 'queued' || j.state === 'running').length >= 8)
      return res.status(429).json({ error: 'Queue is full; wait for an existing job' });
    for (const [id, job] of jobs) if (job.finishedAt && Date.now() - job.finishedAt > 3600000) jobs.delete(id);
    while (jobs.size >= 100) {
      const done = [...jobs].find(([, j]) => j.finishedAt);
      if (!done) break;
      jobs.delete(done[0]);
    }
    const job = { id: crypto.randomUUID(), operation, state: 'queued', createdAt: Date.now() };
    jobs.set(job.id, job);
    res.status(202).json(job);
    // Native route middleware below owns serialization. Do not nest queue locks.
    callJar(routes[operation], input, job.id).then(result => { job.result = result; job.state = 'succeeded'; })
      .catch(error => { job.error = error.message; job.state = 'failed'; })
      .finally(() => { job.finishedAt = Date.now(); });
  });
  app.get('/bridge/v1/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job expired or service restarted; refresh captures before retrying' });
    res.json(job);
  });
  // Validate capture IDs before upstream's file-backed store receives them.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/captures/') && !/^\/api\/captures\/[\w-]+(?:\/avatar|\/refresh)?$/.test(req.path))
      return res.status(400).json({ error: 'Invalid capture path' });
    if (req.body?.id && !/^[\w-]+$/.test(String(req.body.id))) return res.status(400).json({ error: 'Invalid capture ID' });
    next();
  });
  app.use((req, res, next) => {
    const needsQueue = req.path.startsWith('/api/') && (req.method !== 'GET' || req.path === '/api/status');
    if (!needsQueue) return next();
    if (queued >= 16) return res.status(429).json({ error: 'JAR is busy' });
    void enqueue(() => new Promise(resolve => {
      const job = jobs.get(req.headers['x-jar-job']);
      if (job) job.state = 'running';
      // A client disconnect must not let another operation use the browser.
      res.once('finish', resolve);
      next();
    }));
  });
  app.use(jarApp);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = http.createServer(app);
  return { app, server, jobs, start: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const target = address.address === '0.0.0.0' ? '127.0.0.1' : address.address === '::' ? '[::1]' : address.address.includes(':') ? `[${address.address}]` : address.address;
      localOrigin = `http://${target}:${address.port}`;
      resolve(address);
    });
  }) };
}
module.exports = { createService };
