'use strict';
// سيرفر تجريبي للواجهة: بيشغّل الموقع الحقيقي (public/) مع قواعد السيرفر الحقيقية (functions/lib)
// فوق قاعدة بيانات بالذاكرة، بدل Firebase. بس للاختبار، وما فيه قواعد الحماية تبع القراءة.
// التشغيل: node tests/ui/serve.js   ثم افتح http://localhost:4600
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const root = path.join(__dirname, '..', '..');
const express = require(path.join(root, 'functions/node_modules/express'));
const { makeCore, AppError } = require(path.join(root, 'functions/lib/core'));
const { makeGameHandler } = require(path.join(root, 'functions/lib/serve'));
const { makeMcpHandler } = require(path.join(root, 'functions/lib/mcp'));
const { makeFakes, FakeTimestamp } = require('../fake');

const PORT = Number(process.env.PORT) || 4600;
const GAMES_PORT = PORT + 1;
const fakes = makeFakes();
const core = makeCore(fakes.deps);
const accounts = new Map();
const NOW = '__server_time__';

function plain(v) {
  if (v instanceof FakeTimestamp) return v.toMillis();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}
const fromSnap = (s) => ({ id: s.id, ...plain(s.data()) });

function query(p, opts = {}) {
  let q = fakes.db.collection(p);
  (opts.where || []).forEach(([f, op, val]) => (q = q.where(f, op, val)));
  if (opts.orderBy) q = q.orderBy(opts.orderBy[0], opts.orderBy[1] || 'asc');
  if (opts.limit) q = q.limit(opts.limit);
  return q;
}

const app = express();
// نفس ترويسات الحماية اللي بـ firebase.json، عشان نكشف أي مخالفة CSP
const hosting = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8')).hosting[0];
const headers = hosting.headers.find((x) => x.source === '**').headers;
app.use((req, res, next) => {
  headers.forEach((x) => res.set(x.key, x.value));
  next();
});
app.use('/t', express.json({ limit: '1mb' }));
const wrap = (fn) => async (req, res) => {
  try {
    res.json({ data: await fn(req.body || {}, req) });
  } catch (err) {
    if (!(err instanceof AppError)) console.error(err);
    res.status(400).json({ code: err.code || 'internal', message: err instanceof AppError ? err.message : 'INTERNAL' });
  }
};
app.post('/t/signup', wrap(({ email, password }) => {
  if (accounts.has(email)) throw new AppError('auth/email-already-in-use', 'في حساب بهاد الإيميل. جرّب تسجّل دخول.');
  if (String(password).length < 6) throw new AppError('auth/weak-password', 'كلمة السر ضعيفة. لازم 6 أحرف على الأقل.');
  const user = { uid: 'u' + crypto.randomBytes(10).toString('hex'), email, password };
  accounts.set(email, user);
  return { uid: user.uid, email };
}));
app.post('/t/signin', wrap(({ email, password }) => {
  const user = accounts.get(email);
  if (!user || user.password !== password) throw new AppError('auth/invalid-credential', 'الإيميل أو كلمة السر غلط');
  return { uid: user.uid, email };
}));
app.post('/t/call', wrap(({ uid, op, args, heavy }) => core.call(uid, op, args, { heavy })));
app.post('/t/get', wrap(async ({ path: p }) => {
  const snap = await fakes.db.doc(p).get();
  return snap.exists ? fromSnap(snap) : null;
}));
app.post('/t/list', wrap(async ({ path: p, opts }) => (await query(p, opts).get()).docs.map(fromSnap)));
app.post('/t/add', wrap(async ({ path: p, data }) => {
  const out = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === NOW ? fakes.deps.serverTimestamp() : v]));
  return (await fakes.db.collection(p).add(out)).id;
}));
app.post('/t/remove', wrap(({ path: p }) => fakes.db.doc(p).delete()));
app.post('/t/admin', wrap(({ uid }) => fakes.db.doc(`admins/${uid}`).set({ note: 'test admin' })));
app.get('/t/version', (req, res) => res.json({ version: fakes.db.version }));
app.post('/t/upload', express.raw({ type: '*/*', limit: '110mb' }), (req, res) => {
  fakes.bucket.put(`uploads/${req.query.uid}/${req.query.id}.zip`, req.body, 'application/zip');
  res.json({ data: true });
});
app.post('/mcp', express.json(), makeMcpHandler(core.connector, console));
app.get('/js/driver.js', (req, res) => res.type('text/javascript').sendFile(path.join(__dirname, 'test-driver.js')));
app.use(express.static(path.join(root, 'public')));
app.listen(PORT, () => console.log(`الموقع التجريبي: http://localhost:${PORT}`));

const games = express();
games.use(makeGameHandler(core, console));
games.listen(GAMES_PORT, () => console.log(`الألعاب: http://localhost:${GAMES_PORT}`));
