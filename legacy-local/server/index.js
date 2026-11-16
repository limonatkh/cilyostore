// Cilyo: نقطة التشغيل.
// سيرفرين: الموقع (PORT، افتراضيًا 4000) وسيرفر الألعاب المعزول (GAMES_PORT، افتراضيًا 4001).
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const store = require('./db');
store.load();
const core = require('./core');
const mcp = require('./mcp');

const PORT = Number(process.env.PORT) || 4000;
const GAMES_PORT = Number(process.env.GAMES_PORT) || 4001;
const GAMES_ORIGIN = (process.env.GAMES_ORIGIN || `http://localhost:${GAMES_PORT}`).replace(/\/$/, '');
const MAX_UPLOAD = 100 * 1024 * 1024;

fs.mkdirSync(core.BUILDS_DIR, { recursive: true });

// ---------- الإشعارات اللحظية ----------
const clients = new Set();
function emit(event, audience) {
  const data = JSON.stringify(event);
  for (const c of clients) {
    if (c.ws.readyState !== 1) continue;
    if (audience && !(c.userId && audience.includes(c.userId))) continue;
    c.ws.send(data);
  }
}
core.configure({ gamesOrigin: GAMES_ORIGIN, emit });

// ---------- الموقع ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      `frame-src ${GAMES_ORIGIN}`,
      "connect-src 'self' ws: wss:",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  next();
});

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function sessionToken(req) {
  return parseCookies(req.headers.cookie).cilyo_session || null;
}

app.use((req, res, next) => {
  req.user = core.userBySession(sessionToken(req));
  next();
});

function needUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'لازم تسجّل دخول' });
  next();
}

// كل الطلبات اللي بتغيّر إشي لازم تيجي من نفس الموقع
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers['x-cilyo'] !== '1') {
    return res.status(403).json({ error: 'طلب غير مسموح' });
  }
  next();
});

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (err) {
    if (err instanceof core.HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 1 } });
const uploadZip = (req, res, next) =>
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'الملف أكبر من 100 ميغا' : 'فشل رفع الملف';
      return res.status(400).json({ error: msg });
    }
    next();
  });

function setSessionCookie(res, token) {
  res.set('Set-Cookie', `cilyo_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
}

// الحسابات
app.get('/api/config', wrap(() => ({ gamesOrigin: GAMES_ORIGIN })));
app.get(
  '/api/me',
  wrap((req) => ({
    user: core.publicUser(req.user),
    hasConnectorToken: req.user ? core.hasConnectorToken(req.user) : false
  }))
);
app.post(
  '/api/register',
  wrap((req, res) => {
    core.register(req.body.username, req.body.password);
    const { user, token } = core.login(req.body.username, req.body.password);
    setSessionCookie(res, token);
    return { user: core.publicUser(user) };
  })
);
app.post(
  '/api/login',
  wrap((req, res) => {
    const { user, token } = core.login(req.body.username, req.body.password);
    setSessionCookie(res, token);
    return { user: core.publicUser(user) };
  })
);
app.post(
  '/api/logout',
  wrap((req, res) => {
    core.logout(sessionToken(req));
    res.set('Set-Cookie', 'cilyo_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
    return { ok: true };
  })
);
app.post(
  '/api/connector-token',
  needUser,
  wrap((req) => ({ token: core.createConnectorToken(req.user) }))
);

// المتجر والألعاب
app.get('/api/games', wrap((req) => core.listGames(req.user)));
app.get('/api/games/:id', wrap((req) => core.getGame(req.user, req.params.id)));
app.post(
  '/api/games',
  needUser,
  uploadZip,
  wrap((req) => core.uploadSoloGame(req.user, req.file && req.file.buffer, req.body || {}))
);
app.post(
  '/api/games/:id/version',
  needUser,
  uploadZip,
  wrap((req) => core.updateSoloGame(req.user, req.params.id, req.file && req.file.buffer))
);

// الرسائل
app.get(
  '/api/servers/:id/messages',
  wrap((req) => core.listMessages(req.user, req.params.id, req.query.channel, req.query.limit))
);
app.post(
  '/api/servers/:id/messages',
  needUser,
  wrap((req) => core.postMessage(req.user, req.params.id, req.body.channel, req.body.text))
);

// الاستوديوهات
app.get('/api/studios', needUser, wrap((req) => core.listStudios(req.user)));
app.post(
  '/api/studios',
  needUser,
  wrap((req) => {
    const st = core.createStudio(req.user, req.body.name);
    return core.getStudio(req.user, st.id);
  })
);
app.get('/api/studios/:id', needUser, wrap((req) => core.getStudio(req.user, req.params.id)));
app.post('/api/studios/:id/invite', needUser, wrap((req) => core.inviteToStudio(req.user, req.params.id, req.body.username)));
app.post('/api/studios/:id/accept', needUser, wrap((req) => core.acceptInvite(req.user, req.params.id)));
app.post('/api/studios/:id/decline', needUser, wrap((req) => core.declineInvite(req.user, req.params.id)));
app.put('/api/studios/:id/contract', needUser, wrap((req) => core.updateContract(req.user, req.params.id, req.body)));
app.post('/api/studios/:id/sign', needUser, wrap((req) => core.signContract(req.user, req.params.id)));
app.post('/api/studios/:id/projects', needUser, wrap((req) => core.createProject(req.user, req.params.id, req.body)));

// المشاريع
app.put('/api/projects/:id', needUser, wrap((req) => core.updateProject(req.user, req.params.id, req.body)));
app.put(
  '/api/projects/:id/layers/:layerId',
  needUser,
  wrap((req) => core.setLayerOwner(req.user, req.params.id, req.params.layerId, req.body.ownerId))
);
app.post('/api/projects/:id/agreements', needUser, wrap((req) => core.proposeAgreement(req.user, req.params.id, req.body)));
app.post(
  '/api/projects/:id/trials',
  needUser,
  uploadZip,
  wrap((req) => core.addTrialUpload(req.user, req.params.id, req.file && req.file.buffer, req.body && req.body.note))
);
app.post(
  '/api/projects/:id/trial-links',
  needUser,
  wrap((req) => core.addTrialLink(req.user, req.params.id, req.body.url, req.body.note))
);
app.post('/api/projects/:id/publish', needUser, wrap((req) => core.requestPublish(req.user, req.params.id, req.body)));

// الاتفاقات والموافقات
app.put('/api/agreements/:id', needUser, wrap((req) => core.editAgreement(req.user, req.params.id, req.body)));
app.post(
  '/api/agreements/:id/status',
  needUser,
  wrap((req) => core.setAgreementStatus(req.user, req.params.id, req.body.status))
);
app.post(
  '/api/approvals/:id/decide',
  needUser,
  wrap((req) => core.decideApproval(req.user, req.params.id, req.body.decision))
);

app.use('/api', (req, res) => res.status(404).json({ error: 'مش موجود' }));

// موصل المساعد
mcp.mount(app);

// ملفات الواجهة
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

// أي خطأ بقراءة الطلب (مثلًا JSON مكسور)
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'طلب غير صالح' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'الطلب كبير كثير' });
  console.error(err);
  res.status(500).json({ error: 'صار خطأ بالسيرفر' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const user = core.userBySession(parseCookies(req.headers.cookie).cilyo_session);
  const client = { ws, userId: user ? user.id : null };
  clients.add(client);
  ws.on('close', () => clients.delete(client));
  ws.on('error', () => clients.delete(client));
});

// ---------- سيرفر الألعاب المعزول ----------
// منفذ منفصل = أصل (origin) منفصل، فاللعبة ما بتقدر توصل لحسابات الموقع.
const games = express();
games.disable('x-powered-by');
games.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-cache');
  next();
});
games.use('/b', express.static(core.BUILDS_DIR, { dotfiles: 'ignore', index: 'index.html', redirect: true }));
games.get('/', (req, res) => res.type('text/plain; charset=utf-8').send('Cilyo games'));

server.listen(PORT, () => {
  console.log(`Cilyo شغال على http://localhost:${PORT}`);
});
http.createServer(games).listen(GAMES_PORT, () => {
  console.log(`سيرفر الألعاب شغال على http://localhost:${GAMES_PORT} (عنوانه العام: ${GAMES_ORIGIN})`);
});

function shutdown() {
  try {
    store.flush();
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
