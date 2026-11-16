// منطق Cilyo كله هون: الصلاحيات والقواعد.
// الموقع والموصل (MCP) بيستخدموا نفس الدوال، فالقواعد وحدة للاثنين.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const store = require('./db');

const D = () => store.db;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

let gamesOrigin = 'http://localhost:4001';
let emit = () => {};
function configure(opts) {
  if (opts.gamesOrigin) gamesOrigin = opts.gamesOrigin.replace(/\/$/, '');
  if (opts.emit) emit = opts.emit;
}

const BUILDS_DIR = path.join(store.DATA_DIR, 'builds');
const MAX_UNZIPPED = 300 * 1024 * 1024;
const MAX_FILES = 5000;

// ---------- ثوابت ----------
const DEFAULT_LAYERS = ['العالم والخريطة', 'أنظمة اللعب', 'القصة والمهمات', 'الشخصيات والمظهر', 'الواجهة والصوت'];

const GAME_CHANNELS = [
  { id: 'general', name: 'عام', type: 'chat' },
  { id: 'news', name: 'أخبار', type: 'chat', teamOnly: true },
  { id: 'bugs', name: 'بلاغات-أخطاء', type: 'chat' },
  { id: 'devlog', name: 'يوميات-التطوير', type: 'chat', teamOnly: true }
];

const STUDIO_CHANNELS = [
  { id: 'general', name: 'عام', type: 'chat', group: 'عام' },
  ...DEFAULT_LAYERS.map((n, i) => ({ id: 'layer' + (i + 1), name: n.replace(/ /g, '-'), type: 'chat', group: 'الطبقات' })),
  { id: 'project', name: 'المشروع', type: 'project', group: 'التنسيق' },
  { id: 'agreements', name: 'الاتفاقات', type: 'agreements', group: 'التنسيق' },
  { id: 'approvals', name: 'الموافقات', type: 'approvals', group: 'التنسيق' },
  { id: 'trials', name: 'التجارب', type: 'trials', group: 'التنسيق' },
  { id: 'log', name: 'السجل', type: 'log', group: 'التنسيق' }
];

const AGREEMENT_STATUS = {
  proposed: 'مقترح',
  agreed: 'متفق عليه',
  implemented: 'منفّذ',
  approved: 'معتمد',
  rejected: 'مرفوض'
};

const OWNERSHIP = { equal: 'بالتساوي بين الأعضاء', contribution: 'حسب المساهمة المسجّلة' };
const EXIT = {
  vesting: 'نسبة اللي بيطلع بتتبنى مع الوقت',
  buyout: 'الباقين بيشتروا حصته',
  keep: 'بيحتفظ بنسبته كاملة'
};
const CONTRACT_CLAUSES = [
  'نشر لعبة بالمتجر، وتغيير النسب، وإضافة عضو جديد، وتغيير اسم اللعبة: كلها بدها موافقة كل الأعضاء.',
  'الشغل اللي بيجيبه كل عضو من قبل الاستوديو بيضل إله، وللاستوديو حق استخدامه بالمشروع بس.',
  'سجل المساهمات بينكتب تلقائيًا وما حدا بيقدر يعدّله أو يمحيه.',
  'اللي بينتجه مساعد الـAI تبع كل عضو بينحسب مساهمة من صاحبه.',
  'المنصة ما بتملك إشي من شغل الاستوديو.',
  'الأرباح بتتوزع حسب النسب لما تصير الألعاب مدفوعة. هلأ كل الألعاب مجانية.'
];

// ---------- مساعدات ----------
function now() {
  return Date.now();
}

function cleanText(v, max, label) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t) fail(400, `لازم تكتب ${label}`);
  if (t.length > max) fail(400, `${label} طويل كثير (الحد ${max} حرف)`);
  return t;
}

function optText(v, max) {
  const t = typeof v === 'string' ? v.trim() : '';
  return t.slice(0, max);
}

function findUser(id) {
  return D().users.find((u) => u.id === id) || null;
}

function userName(id) {
  const u = findUser(id);
  return u ? u.username : 'مستخدم محذوف';
}

function publicUser(u) {
  return u ? { id: u.id, username: u.username } : null;
}

// ---------- الحسابات ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function register(username, password) {
  username = typeof username === 'string' ? username.trim() : '';
  if (!/^[\p{L}\p{N}_.-]{3,24}$/u.test(username)) {
    fail(400, 'اسم المستخدم لازم يكون من 3 لـ24 حرف أو رقم، بدون مسافات');
  }
  if (typeof password !== 'string' || password.length < 6) fail(400, 'كلمة السر لازم تكون 6 أحرف على الأقل');
  if (D().users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    fail(409, 'اسم المستخدم مأخوذ');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: store.id('u'), username, salt, passHash: hashPassword(password, salt), createdAt: now() };
  D().users.push(user);
  store.save();
  return user;
}

function login(username, password) {
  const u = D().users.find((x) => x.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!u || typeof password !== 'string') fail(401, 'اسم المستخدم أو كلمة السر غلط');
  const h = hashPassword(password, u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.passHash, 'hex'))) {
    fail(401, 'اسم المستخدم أو كلمة السر غلط');
  }
  const token = crypto.randomBytes(32).toString('hex');
  D().sessions[token] = u.id;
  store.save();
  return { user: u, token };
}

function logout(token) {
  if (token && D().sessions[token]) {
    delete D().sessions[token];
    store.save();
  }
}

function userBySession(token) {
  const id = token && D().sessions[token];
  return id ? findUser(id) : null;
}

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function createConnectorToken(user) {
  for (const [h, uid] of Object.entries(D().tokens)) {
    if (uid === user.id) delete D().tokens[h];
  }
  const token = 'cil_' + crypto.randomBytes(24).toString('hex');
  D().tokens[sha(token)] = user.id;
  store.save();
  return token;
}

function hasConnectorToken(user) {
  return Object.values(D().tokens).includes(user.id);
}

function userByToken(token) {
  const id = token && D().tokens[sha(token)];
  return id ? findUser(id) : null;
}

// ---------- ملفات الألعاب ----------
function findIndex(dir) {
  const queue = [dir];
  while (queue.length) {
    const cur = queue.shift();
    const items = fs.readdirSync(cur, { withFileTypes: true });
    const idx = items.find((i) => i.isFile() && i.name.toLowerCase() === 'index.html');
    if (idx) return path.join(cur, idx.name);
    for (const i of items) if (i.isDirectory()) queue.push(path.join(cur, i.name));
  }
  return null;
}

function extractBuild(buffer, uploaderId, kind) {
  if (!buffer || !buffer.length) fail(400, 'لازم تختار ملف مضغوط (zip) فيه اللعبة');
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (e) {
    fail(400, 'الملف مش zip صالح');
  }
  const entries = zip.getEntries();
  if (entries.length > MAX_FILES) fail(400, 'الملف فيه ملفات كثير كثير');
  const bid = store.id('b');
  const dir = path.join(BUILDS_DIR, bid);
  fs.mkdirSync(dir, { recursive: true });
  const seen = new Set();
  let total = 0;
  try {
    for (const e of entries) {
      if (e.isDirectory) continue;
      const name = e.entryName.replace(/\\/g, '/');
      if (name.startsWith('__MACOSX/') || name.split('/').some((p) => p === '..')) continue;
      const target = path.resolve(dir, name);
      if (!target.startsWith(dir + path.sep)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      const declared = e.header && e.header.size ? e.header.size : 0;
      if (total + declared > MAX_UNZIPPED) fail(400, 'اللعبة بعد فك الضغط أكبر من الحد المسموح');
      const data = e.getData();
      total += data.length;
      if (total > MAX_UNZIPPED) fail(400, 'اللعبة بعد فك الضغط أكبر من الحد المسموح');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data, { mode: 0o644 });
    }
    const found = findIndex(dir);
    if (!found) fail(400, 'ما لقينا ملف index.html جوّا الملف المضغوط');
    const entry = path.relative(dir, found).split(path.sep).join('/');
    const build = { id: bid, uploaderId, kind, entry, size: total, createdAt: now() };
    D().builds.push(build);
    return build;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function buildUrl(buildId) {
  const b = D().builds.find((x) => x.id === buildId);
  if (!b) return null;
  return `${gamesOrigin}/b/${b.id}/${b.entry.split('/').map(encodeURIComponent).join('/')}`;
}

// ---------- السيرفرات والرسائل ----------
function createServer(kind, refId, name, channels) {
  const s = { id: store.id('s'), kind, refId, name, channels: channels.map((c) => ({ ...c })), createdAt: now() };
  D().servers.push(s);
  return s;
}

function getServer(id) {
  return D().servers.find((s) => s.id === id) || null;
}

function studioOfServer(server) {
  return server.kind === 'studio' ? getStudioRaw(server.refId) : null;
}

function gameOfServer(server) {
  return server.kind === 'game' ? D().games.find((g) => g.id === server.refId) : null;
}

function canReadServer(user, server) {
  if (server.kind === 'game') return true;
  const st = studioOfServer(server);
  return !!(st && user && isMember(st, user.id));
}

function serverAudience(server) {
  if (server.kind === 'game') return null;
  const st = studioOfServer(server);
  return st ? st.members.slice() : [];
}

function isGameTeam(user, game) {
  if (!user || !game) return false;
  if (game.ownerType === 'user') return game.ownerId === user.id;
  const st = getStudioRaw(game.ownerId);
  return !!(st && isMember(st, user.id));
}

function channelOf(server, channelId) {
  const ch = server.channels.find((c) => c.id === channelId);
  if (!ch) fail(404, 'القناة مش موجودة');
  return ch;
}

function serverView(user, server) {
  let canManage = false;
  if (server.kind === 'game') canManage = isGameTeam(user, gameOfServer(server));
  else canManage = canReadServer(user, server);
  return {
    id: server.id,
    kind: server.kind,
    name: server.name,
    channels: server.channels.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      group: c.group || null,
      canPost: c.type === 'chat' && !!user && (!c.teamOnly || canManage)
    }))
  };
}

function listMessages(user, serverId, channelId, limit) {
  const server = getServer(serverId);
  if (!server) fail(404, 'السيرفر مش موجود');
  if (!canReadServer(user, server)) fail(403, 'هاد السيرفر خاص بأعضائه');
  channelOf(server, channelId);
  const n = Math.max(1, Math.min(200, Number(limit) || 100));
  return D()
    .messages.filter((m) => m.serverId === serverId && m.channelId === channelId)
    .slice(-n);
}

function postMessage(user, serverId, channelId, text, opts = {}) {
  if (!user) fail(401, 'لازم تسجّل دخول');
  const server = getServer(serverId);
  if (!server) fail(404, 'السيرفر مش موجود');
  if (!canReadServer(user, server)) fail(403, 'هاد السيرفر خاص بأعضائه');
  const ch = channelOf(server, channelId);
  if (ch.type !== 'chat') fail(400, 'هاي القناة مش للرسائل');
  if (ch.teamOnly && !isGameTeam(user, gameOfServer(server))) fail(403, 'بس فريق اللعبة بيكتب بهاي القناة');
  const body = cleanText(text, 2000, 'الرسالة');
  const msg = {
    id: store.id('m'),
    serverId,
    channelId,
    userId: user.id,
    author: user.username + (opts.viaAI ? ' (المساعد)' : ''),
    viaAI: !!opts.viaAI,
    text: body,
    createdAt: now()
  };
  D().messages.push(msg);
  store.save();
  emit({ type: 'message', serverId, message: msg }, serverAudience(server));
  return msg;
}

function systemMessage(server, channelId, text) {
  const msg = {
    id: store.id('m'),
    serverId: server.id,
    channelId,
    userId: null,
    author: 'Cilyo',
    system: true,
    text,
    createdAt: now()
  };
  D().messages.push(msg);
  emit({ type: 'message', serverId: server.id, message: msg }, serverAudience(server));
  return msg;
}

// ---------- الألعاب والمتجر ----------
function gameView(user, g) {
  let maker;
  if (g.ownerType === 'user') maker = { type: 'user', name: userName(g.ownerId) };
  else {
    const st = getStudioRaw(g.ownerId);
    maker = { type: 'studio', name: st ? st.name : 'استوديو', members: st ? st.members.map(userName) : [] };
  }
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    controls: g.controls,
    maker,
    playUrl: buildUrl(g.buildId),
    serverId: g.serverId,
    isTeam: isGameTeam(user, g),
    createdAt: g.createdAt,
    updatedAt: g.updatedAt || g.createdAt
  };
}

function listGames(user) {
  return D()
    .games.slice()
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .map((g) => gameView(user, g));
}

function getGame(user, id) {
  const g = D().games.find((x) => x.id === id);
  if (!g) fail(404, 'اللعبة مش موجودة');
  const server = getServer(g.serverId);
  return { game: gameView(user, g), server: serverView(user, server) };
}

function createGame({ title, description, controls, ownerType, ownerId, buildId, projectId }) {
  const g = {
    id: store.id('g'),
    title,
    description,
    controls,
    ownerType,
    ownerId,
    buildId,
    projectId: projectId || null,
    createdAt: now()
  };
  const server = createServer('game', g.id, title, GAME_CHANNELS);
  g.serverId = server.id;
  D().games.push(g);
  systemMessage(server, 'general', `أهلًا بسيرفر ${title}. انعمل تلقائيًا لما نزلت اللعبة.`);
  return g;
}

function uploadSoloGame(user, buffer, fields) {
  if (!user) fail(401, 'لازم تسجّل دخول');
  const title = cleanText(fields.title, 80, 'اسم اللعبة');
  const description = optText(fields.description, 2000);
  const controls = optText(fields.controls, 500);
  const build = extractBuild(buffer, user.id, 'game');
  const g = createGame({ title, description, controls, ownerType: 'user', ownerId: user.id, buildId: build.id });
  store.save();
  emit({ type: 'games' }, null);
  return gameView(user, g);
}

function updateSoloGame(user, gameId, buffer) {
  const g = D().games.find((x) => x.id === gameId);
  if (!g) fail(404, 'اللعبة مش موجودة');
  if (g.ownerType !== 'user' || g.ownerId !== user.id) {
    fail(403, 'بس صاحب اللعبة بيرفع نسخة جديدة. ألعاب الاستوديو بتتحدث من الاستوديو بموافقة الكل.');
  }
  const build = extractBuild(buffer, user.id, 'game');
  g.buildId = build.id;
  g.updatedAt = now();
  systemMessage(getServer(g.serverId), 'news', 'نزلت نسخة جديدة من اللعبة.');
  store.save();
  emit({ type: 'games' }, null);
  return gameView(user, g);
}

// ---------- الاستوديوهات ----------
function getStudioRaw(id) {
  return D().studios.find((s) => s.id === id) || null;
}

function isMember(st, userId) {
  return st.members.includes(userId);
}

function studioAudience(st) {
  return Array.from(new Set([...st.members, ...st.invites]));
}

function touchStudio(st) {
  emit({ type: 'studio', studioId: st.id }, studioAudience(st));
}

function addLog(st, userId, text, viaAI) {
  D().log.push({
    id: store.id('l'),
    studioId: st.id,
    userId,
    who: userId ? userName(userId) + (viaAI ? ' (المساعد)' : '') : 'Cilyo',
    text,
    createdAt: now()
  });
}

function requireMember(user, studioId) {
  if (!user) fail(401, 'لازم تسجّل دخول');
  const st = getStudioRaw(studioId);
  if (!st) fail(404, 'الاستوديو مش موجود');
  if (!isMember(st, user.id)) fail(403, 'إنت مش عضو بهاد الاستوديو');
  return st;
}

function requireActive(st) {
  if (st.status !== 'active') fail(400, 'الاستوديو لسا ما انفتح. لازم كل الأعضاء يوقّعوا العقد أول.');
}

function listStudios(user) {
  const mine = D().studios.filter((s) => isMember(s, user.id));
  const invites = D().studios.filter((s) => s.invites.includes(user.id));
  const brief = (s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    members: s.members.map(userName),
    projects: D().projects.filter((p) => p.studioId === s.id).map((p) => ({ id: p.id, name: p.name }))
  });
  return { studios: mine.map(brief), invites: invites.map(brief) };
}

function createStudio(user, name) {
  if (!user) fail(401, 'لازم تسجّل دخول');
  const st = {
    id: store.id('st'),
    name: cleanText(name, 60, 'اسم الاستوديو'),
    status: 'pending',
    members: [user.id],
    invites: [],
    contract: { ownership: 'equal', exit: 'vesting', version: 1, signatures: {} },
    serverId: null,
    createdBy: user.id,
    createdAt: now()
  };
  D().studios.push(st);
  addLog(st, user.id, `أنشأ الاستوديو «${st.name}»`);
  store.save();
  return st;
}

function contractView(st) {
  return {
    ownership: st.contract.ownership,
    exit: st.contract.exit,
    version: st.contract.version,
    ownershipText: OWNERSHIP[st.contract.ownership],
    exitText: EXIT[st.contract.exit],
    ownershipOptions: OWNERSHIP,
    exitOptions: EXIT,
    clauses: CONTRACT_CLAUSES,
    signatures: st.members.map((uid) => ({
      userId: uid,
      username: userName(uid),
      signed: !!st.contract.signatures[uid],
      signedAt: st.contract.signatures[uid] || null
    }))
  };
}

function layerView(l) {
  return { id: l.id, name: l.name, ownerId: l.ownerId, owner: l.ownerId ? userName(l.ownerId) : null };
}

function projectView(p) {
  const game = p.gameId ? D().games.find((g) => g.id === p.gameId) : null;
  return {
    id: p.id,
    name: p.name,
    repoUrl: p.repoUrl,
    layers: p.layers.map(layerView),
    gameId: game ? game.id : null,
    createdAt: p.createdAt
  };
}

function agreementView(a, p) {
  const layer = (id) => p.layers.find((l) => l.id === id);
  const from = layer(a.fromLayer);
  const to = layer(a.toLayer);
  return {
    id: a.id,
    projectId: a.projectId,
    title: a.title,
    description: a.description,
    fromLayer: from ? layerView(from) : null,
    toLayer: to ? layerView(to) : null,
    status: a.status,
    statusText: AGREEMENT_STATUS[a.status],
    createdBy: userName(a.createdBy),
    updatedAt: a.updatedAt || a.createdAt
  };
}

function approvalView(ap) {
  return {
    id: ap.id,
    projectId: ap.projectId,
    kind: ap.kind,
    refId: ap.refId,
    summary: ap.summary,
    detail: ap.detail || '',
    status: ap.status,
    createdBy: userName(ap.createdBy),
    required: ap.required.map((uid) => ({
      userId: uid,
      username: userName(uid),
      decision: ap.decisions[uid] || null
    })),
    createdAt: ap.createdAt,
    closedAt: ap.closedAt || null
  };
}

function trialView(t) {
  return {
    id: t.id,
    projectId: t.projectId,
    by: userName(t.userId) + (t.viaAI ? ' (المساعد)' : ''),
    url: t.buildId ? buildUrl(t.buildId) : t.url,
    uploaded: !!t.buildId,
    note: t.note,
    createdAt: t.createdAt
  };
}

function getStudio(user, id) {
  if (!user) fail(401, 'لازم تسجّل دخول');
  const st = getStudioRaw(id);
  if (!st) fail(404, 'الاستوديو مش موجود');
  const member = isMember(st, user.id);
  const invited = st.invites.includes(user.id);
  if (!member && !invited) fail(403, 'إنت مش عضو بهاد الاستوديو');
  const base = {
    id: st.id,
    name: st.name,
    status: st.status,
    isMember: member,
    isInvited: invited,
    members: st.members.map((uid) => publicUser(findUser(uid))).filter(Boolean),
    invites: st.invites.map((uid) => publicUser(findUser(uid))).filter(Boolean),
    contract: contractView(st)
  };
  if (!member) return base;
  const projects = D().projects.filter((p) => p.studioId === st.id);
  const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
  return {
    ...base,
    server: st.serverId ? serverView(user, getServer(st.serverId)) : null,
    projects: projects.map(projectView),
    agreements: D()
      .agreements.filter((a) => byId[a.projectId])
      .map((a) => agreementView(a, byId[a.projectId])),
    approvals: D()
      .approvals.filter((a) => a.studioId === st.id)
      .slice(-100)
      .reverse()
      .map(approvalView),
    trials: D()
      .trials.filter((t) => byId[t.projectId])
      .slice(-100)
      .reverse()
      .map(trialView),
    log: D()
      .log.filter((l) => l.studioId === st.id)
      .slice(-300)
      .reverse()
  };
}

function inviteToStudio(user, studioId, username) {
  const st = requireMember(user, studioId);
  if (st.status !== 'pending') {
    fail(400, 'إضافة عضو بعد فتح الاستوديو بدها موافقة الكل، وهاي لسا مش موجودة بهالنسخة.');
  }
  const target = D().users.find((u) => u.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!target) fail(404, 'ما في مستخدم بهالاسم. لازم شريكك يعمل حساب أول.');
  if (isMember(st, target.id)) fail(400, 'هاد المستخدم عضو أصلًا');
  if (st.invites.includes(target.id)) fail(400, 'هاد المستخدم معزوم أصلًا');
  st.invites.push(target.id);
  addLog(st, user.id, `عزم ${target.username} على الاستوديو`);
  store.save();
  touchStudio(st);
  emit({ type: 'invites' }, [target.id]);
  return getStudio(user, st.id);
}

function resetSignatures(st) {
  st.contract.signatures = {};
  st.contract.version += 1;
}

function acceptInvite(user, studioId) {
  if (!user) fail(401, 'لازم تسجّل دخول');
  const st = getStudioRaw(studioId);
  if (!st || !st.invites.includes(user.id)) fail(404, 'ما في دعوة');
  st.invites = st.invites.filter((x) => x !== user.id);
  st.members.push(user.id);
  resetSignatures(st);
  addLog(st, user.id, 'قبل الدعوة وانضم للاستوديو. العقد رجع بدّه توقيع الكل.');
  store.save();
  touchStudio(st);
  return getStudio(user, st.id);
}

function declineInvite(user, studioId) {
  if (!user) fail(401, 'لازم تسجّل دخول');
  const st = getStudioRaw(studioId);
  if (!st || !st.invites.includes(user.id)) fail(404, 'ما في دعوة');
  st.invites = st.invites.filter((x) => x !== user.id);
  addLog(st, user.id, 'رفض الدعوة');
  store.save();
  touchStudio(st);
  return { ok: true };
}

function updateContract(user, studioId, { ownership, exit }) {
  const st = requireMember(user, studioId);
  if (st.status !== 'pending') {
    fail(400, 'العقد مقفول بعد ما انفتح الاستوديو. تعديله بعدين بدّه موافقة الكل.');
  }
  if (ownership && !OWNERSHIP[ownership]) fail(400, 'خيار ملكية غير معروف');
  if (exit && !EXIT[exit]) fail(400, 'خيار خروج غير معروف');
  const changed = (ownership && ownership !== st.contract.ownership) || (exit && exit !== st.contract.exit);
  if (!changed) return getStudio(user, st.id);
  if (ownership) st.contract.ownership = ownership;
  if (exit) st.contract.exit = exit;
  resetSignatures(st);
  addLog(st, user.id, `عدّل العقد (الملكية: ${OWNERSHIP[st.contract.ownership]}، الخروج: ${EXIT[st.contract.exit]}). التواقيع رجعت من الأول.`);
  store.save();
  touchStudio(st);
  return getStudio(user, st.id);
}

function signContract(user, studioId) {
  const st = requireMember(user, studioId);
  if (st.status !== 'pending') fail(400, 'العقد موقّع ومفتوح أصلًا');
  st.contract.signatures[user.id] = now();
  addLog(st, user.id, `وقّع العقد (نسخة ${st.contract.version})`);
  const allSigned = st.members.every((uid) => st.contract.signatures[uid]);
  if (allSigned && st.members.length >= 2) {
    st.status = 'active';
    st.activatedAt = now();
    const server = createServer('studio', st.id, st.name, STUDIO_CHANNELS);
    st.serverId = server.id;
    addLog(st, null, 'كل الأعضاء وقّعوا. انفتح الاستوديو وانعمل سيرفره الخاص.');
    systemMessage(server, 'general', `انفتح استوديو ${st.name}. ابدأوا بإنشاء مشروع من قناة #المشروع.`);
  }
  store.save();
  touchStudio(st);
  return getStudio(user, st.id);
}

// ---------- المشاريع والطبقات ----------
function getProjectRaw(id) {
  return D().projects.find((p) => p.id === id) || null;
}

function requireProject(user, projectId) {
  const p = getProjectRaw(projectId);
  if (!p) fail(404, 'المشروع مش موجود');
  const st = requireMember(user, p.studioId);
  requireActive(st);
  return { p, st };
}

function cleanRepoUrl(v) {
  const t = optText(v, 300);
  if (!t) return '';
  if (!/^https:\/\/[^\s]+$/i.test(t)) fail(400, 'رابط المستودع لازم يبدأ بـ https://');
  return t;
}

function createProject(user, studioId, { name, repoUrl }) {
  const st = requireMember(user, studioId);
  requireActive(st);
  const p = {
    id: store.id('p'),
    studioId: st.id,
    name: cleanText(name, 80, 'اسم المشروع'),
    repoUrl: cleanRepoUrl(repoUrl),
    layers: DEFAULT_LAYERS.map((n, i) => ({ id: 'L' + (i + 1), name: n, ownerId: null })),
    gameId: null,
    createdAt: now()
  };
  D().projects.push(p);
  addLog(st, user.id, `أنشأ مشروع «${p.name}»`);
  store.save();
  touchStudio(st);
  return projectView(p);
}

function updateProject(user, projectId, { name, repoUrl }) {
  const { p, st } = requireProject(user, projectId);
  if (name !== undefined) p.name = cleanText(name, 80, 'اسم المشروع');
  if (repoUrl !== undefined) p.repoUrl = cleanRepoUrl(repoUrl);
  addLog(st, user.id, `عدّل بيانات مشروع «${p.name}»`);
  store.save();
  touchStudio(st);
  return projectView(p);
}

function setLayerOwner(user, projectId, layerId, ownerId) {
  const { p, st } = requireProject(user, projectId);
  const layer = p.layers.find((l) => l.id === layerId);
  if (!layer) fail(404, 'الطبقة مش موجودة');
  if (ownerId && !isMember(st, ownerId)) fail(400, 'المسؤول لازم يكون عضو بالاستوديو');
  if (layer.ownerId && layer.ownerId !== user.id) {
    fail(403, `الطبقة إلها مسؤول (${userName(layer.ownerId)}). هو بس بيقدر ينقلها.`);
  }
  layer.ownerId = ownerId || null;
  addLog(st, user.id, `${ownerId ? 'حدّد ' + userName(ownerId) + ' مسؤول' : 'شال المسؤول عن'} طبقة «${layer.name}» بمشروع «${p.name}»`);
  store.save();
  touchStudio(st);
  return projectView(p);
}

function resolveLayer(p, ref) {
  if (!ref) return null;
  const r = String(ref).trim();
  return (
    p.layers.find((l) => l.id === r) ||
    p.layers.find((l) => l.name === r) ||
    p.layers.find((l) => l.name.replace(/ /g, '-') === r) ||
    null
  );
}

// ---------- الموافقات ----------
function otherMembers(st, userId) {
  return st.members.filter((m) => m !== userId);
}

function createApproval(st, p, user, { kind, refId, summary, detail, required, payload }) {
  const ap = {
    id: store.id('ap'),
    studioId: st.id,
    projectId: p ? p.id : null,
    kind,
    refId,
    summary,
    detail: detail || '',
    payload: payload || null,
    required,
    decisions: {},
    status: 'open',
    createdBy: user.id,
    createdAt: now()
  };
  D().approvals.push(ap);
  return ap;
}

function cancelOpenApprovals(kind, refId) {
  for (const ap of D().approvals) {
    if (ap.status === 'open' && ap.kind === kind && ap.refId === refId) {
      ap.status = 'cancelled';
      ap.closedAt = now();
    }
  }
}

function decideApproval(user, approvalId, decision, opts = {}) {
  const ap = D().approvals.find((a) => a.id === approvalId);
  if (!ap) fail(404, 'طلب الموافقة مش موجود');
  const st = requireMember(user, ap.studioId);
  if (ap.status !== 'open') fail(400, 'هاد الطلب انحسم أو انلغى');
  if (!ap.required.includes(user.id)) fail(403, 'هاد الطلب مش بدّه موافقتك');
  if (decision !== 'yes' && decision !== 'no') fail(400, 'القرار لازم يكون yes أو no');
  ap.decisions[user.id] = decision;
  addLog(st, user.id, `${decision === 'yes' ? 'وافق على' : 'رفض'}: ${ap.summary}`, opts.viaAI);
  if (decision === 'no') {
    ap.status = 'rejected';
    ap.closedAt = now();
    onApprovalClosed(st, ap, false);
  } else if (ap.required.every((uid) => ap.decisions[uid] === 'yes')) {
    ap.status = 'approved';
    ap.closedAt = now();
    onApprovalClosed(st, ap, true);
  }
  store.save();
  touchStudio(st);
  return approvalView(ap);
}

function onApprovalClosed(st, ap, approved) {
  if (ap.kind === 'agreement') {
    const a = D().agreements.find((x) => x.id === ap.refId);
    if (!a) return;
    a.status = approved ? 'agreed' : 'rejected';
    a.updatedAt = now();
    addLog(st, null, `الاتفاق «${a.title}» صار ${AGREEMENT_STATUS[a.status]}`);
  } else if (ap.kind === 'publish') {
    if (!approved) {
      addLog(st, null, `طلب النشر انرفض: ${ap.summary}`);
      return;
    }
    publishFromApproval(st, ap);
  }
}

// ---------- الاتفاقات ----------
function agreementRequired(st, p, from, to, actorId) {
  const req = new Set();
  for (const l of [from, to]) {
    if (l.ownerId) req.add(l.ownerId);
    else otherMembers(st, actorId).forEach((m) => req.add(m));
  }
  req.delete(actorId);
  return Array.from(req);
}

function proposeAgreement(user, projectId, fields, opts = {}) {
  const { p, st } = requireProject(user, projectId);
  const title = cleanText(fields.title, 120, 'عنوان الاتفاق');
  const description = optText(fields.description, 2000);
  const from = resolveLayer(p, fields.fromLayer);
  const to = resolveLayer(p, fields.toLayer);
  if (!from || !to) fail(400, 'لازم تحدد الطبقة اللي بتقدّم الاتفاق والطبقة اللي بتعتمد عليه');
  const a = {
    id: store.id('a'),
    projectId: p.id,
    title,
    description,
    fromLayer: from.id,
    toLayer: to.id,
    status: 'proposed',
    createdBy: user.id,
    createdAt: now()
  };
  D().agreements.push(a);
  addLog(st, user.id, `اقترح اتفاق «${title}» (${from.name} ← ${to.name})`, opts.viaAI);
  const required = agreementRequired(st, p, from, to, user.id);
  if (required.length === 0) {
    a.status = 'agreed';
    addLog(st, null, `الاتفاق «${title}» صار متفق عليه (ما في حدا ثاني لازم يوافق)`);
  } else {
    createApproval(st, p, user, {
      kind: 'agreement',
      refId: a.id,
      summary: `اتفاق جديد: «${title}»`,
      detail: `${from.name} ← ${to.name}${description ? '. ' + description : ''}`,
      required
    });
  }
  store.save();
  touchStudio(st);
  return agreementView(a, p);
}

function editAgreement(user, agreementId, fields, opts = {}) {
  const a = D().agreements.find((x) => x.id === agreementId);
  if (!a) fail(404, 'الاتفاق مش موجود');
  const { p, st } = requireProject(user, a.projectId);
  const oldTitle = a.title;
  if (fields.title !== undefined) a.title = cleanText(fields.title, 120, 'عنوان الاتفاق');
  if (fields.description !== undefined) a.description = optText(fields.description, 2000);
  a.status = 'proposed';
  a.updatedAt = now();
  cancelOpenApprovals('agreement', a.id);
  const from = p.layers.find((l) => l.id === a.fromLayer);
  const to = p.layers.find((l) => l.id === a.toLayer);
  addLog(st, user.id, `عدّل الاتفاق «${oldTitle}»${oldTitle !== a.title ? ' إلى «' + a.title + '»' : ''}. رجع مقترح.`, opts.viaAI);
  const required = agreementRequired(st, p, from, to, user.id);
  if (required.length === 0) {
    a.status = 'agreed';
  } else {
    createApproval(st, p, user, {
      kind: 'agreement',
      refId: a.id,
      summary: `تعديل اتفاق: «${a.title}»`,
      detail: `كان «${oldTitle}». ${from.name} ← ${to.name}${a.description ? '. ' + a.description : ''}`,
      required
    });
  }
  store.save();
  touchStudio(st);
  return agreementView(a, p);
}

function setAgreementStatus(user, agreementId, status, opts = {}) {
  const a = D().agreements.find((x) => x.id === agreementId);
  if (!a) fail(404, 'الاتفاق مش موجود');
  const { p, st } = requireProject(user, a.projectId);
  const from = p.layers.find((l) => l.id === a.fromLayer);
  const to = p.layers.find((l) => l.id === a.toLayer);
  if (status === 'implemented') {
    if (a.status !== 'agreed') fail(400, 'الاتفاق لازم يكون «متفق عليه» قبل ما ينعلّم «منفّذ»');
    if (from.ownerId && from.ownerId !== user.id) {
      fail(403, `بس مسؤول طبقة «${from.name}» (${userName(from.ownerId)}) بيعلّمه منفّذ`);
    }
  } else if (status === 'approved') {
    if (a.status !== 'implemented') fail(400, 'الاتفاق لازم يكون «منفّذ» قبل ما ينعتمد');
    if (to.ownerId && to.ownerId !== user.id) {
      fail(403, `بس مسؤول طبقة «${to.name}» (${userName(to.ownerId)}) بيعتمده، لأنه هو اللي بيعتمد عليه`);
    }
  } else {
    fail(400, 'الحالة لازم تكون implemented أو approved');
  }
  a.status = status;
  a.updatedAt = now();
  addLog(st, user.id, `علّم الاتفاق «${a.title}» ${AGREEMENT_STATUS[status]}`, opts.viaAI);
  store.save();
  touchStudio(st);
  return agreementView(a, p);
}

// ---------- التجارب ----------
function addTrialUpload(user, projectId, buffer, note) {
  const { p, st } = requireProject(user, projectId);
  const build = extractBuild(buffer, user.id, 'trial');
  const t = {
    id: store.id('t'),
    projectId: p.id,
    userId: user.id,
    buildId: build.id,
    url: null,
    note: optText(note, 300),
    createdAt: now()
  };
  D().trials.push(t);
  addLog(st, user.id, `رفع نسخة تجريبية لمشروع «${p.name}»${t.note ? ': ' + t.note : ''}`);
  store.save();
  touchStudio(st);
  return trialView(t);
}

function addTrialLink(user, projectId, url, note, opts = {}) {
  const { p, st } = requireProject(user, projectId);
  const u = optText(url, 500);
  if (!/^https?:\/\/[^\s]+$/i.test(u)) fail(400, 'الرابط لازم يبدأ بـ http:// أو https://');
  const t = {
    id: store.id('t'),
    projectId: p.id,
    userId: user.id,
    buildId: null,
    url: u,
    viaAI: !!opts.viaAI,
    note: optText(note, 300),
    createdAt: now()
  };
  D().trials.push(t);
  addLog(st, user.id, `شارك رابط تجربة لمشروع «${p.name}»${t.note ? ': ' + t.note : ''}`, opts.viaAI);
  store.save();
  touchStudio(st);
  return trialView(t);
}

// ---------- النشر ----------
function requestPublish(user, projectId, fields) {
  const { p, st } = requireProject(user, projectId);
  const t = D().trials.find((x) => x.id === fields.trialId && x.projectId === p.id);
  if (!t) fail(404, 'النسخة التجريبية مش موجودة');
  if (!t.buildId) fail(400, 'بس النسخ المرفوعة كملف zip بتنتشر. الروابط الخارجية للتجربة بس.');
  if (D().approvals.some((a) => a.kind === 'publish' && a.refId === p.id && a.status === 'open')) {
    fail(400, 'في طلب نشر مفتوح لهاد المشروع. احسموه أول.');
  }
  const existing = p.gameId ? D().games.find((g) => g.id === p.gameId) : null;
  const title = existing && !fields.title ? existing.title : cleanText(fields.title, 80, 'اسم اللعبة');
  const description = fields.description !== undefined ? optText(fields.description, 2000) : existing ? existing.description : '';
  const controls = fields.controls !== undefined ? optText(fields.controls, 500) : existing ? existing.controls : '';
  const ap = createApproval(st, p, user, {
    kind: 'publish',
    refId: p.id,
    summary: existing ? `نشر نسخة جديدة من «${title}» بالمتجر` : `نشر «${title}» بالمتجر`,
    detail: t.note || '',
    required: st.members.slice(),
    payload: { trialId: t.id, buildId: t.buildId, title, description, controls }
  });
  ap.decisions[user.id] = 'yes';
  addLog(st, user.id, `طلب ${ap.summary}، ووافق عليه`);
  if (ap.required.every((uid) => ap.decisions[uid] === 'yes')) {
    ap.status = 'approved';
    ap.closedAt = now();
    onApprovalClosed(st, ap, true);
  }
  store.save();
  touchStudio(st);
  return approvalView(ap);
}

function publishFromApproval(st, ap) {
  const p = getProjectRaw(ap.refId);
  if (!p) return;
  const { buildId, title, description, controls } = ap.payload;
  let g = p.gameId ? D().games.find((x) => x.id === p.gameId) : null;
  if (g) {
    g.buildId = buildId;
    g.title = title;
    g.description = description;
    g.controls = controls;
    g.updatedAt = now();
    systemMessage(getServer(g.serverId), 'news', 'نزلت نسخة جديدة من اللعبة.');
    addLog(st, null, `نزلت نسخة جديدة من «${title}» بالمتجر بموافقة الكل`);
  } else {
    g = createGame({ title, description, controls, ownerType: 'studio', ownerId: st.id, buildId, projectId: p.id });
    p.gameId = g.id;
    addLog(st, null, `انتشرت «${title}» بالمتجر بموافقة الكل، وانعمل سيرفرها العام`);
  }
  emit({ type: 'games' }, null);
}

// ---------- للموصل: ملخص المشروع ----------
function projectContext(user, projectId) {
  const { p, st } = requireProject(user, projectId);
  const full = getStudio(user, st.id);
  return {
    studio: { id: st.id, name: st.name, members: full.members.map((m) => m.username) },
    you: user.username,
    project: projectView(p),
    yourLayers: p.layers.filter((l) => l.ownerId === user.id).map((l) => l.name),
    agreements: full.agreements.filter((a) => a.projectId === p.id),
    openApprovals: full.approvals.filter((a) => a.projectId === p.id && a.status === 'open'),
    recentTrials: full.trials.filter((t) => t.projectId === p.id).slice(0, 10),
    statusMeaning: AGREEMENT_STATUS,
    studioChannels: STUDIO_CHANNELS.filter((c) => c.type === 'chat').map((c) => ({ id: c.id, name: c.name }))
  };
}

function studioChatChannel(st, ref) {
  const r = String(ref || 'general').trim().replace(/^#/, '');
  const ch = STUDIO_CHANNELS.find((c) => c.type === 'chat' && (c.id === r || c.name === r || c.name === r.replace(/ /g, '-')));
  if (!ch) fail(400, 'قناة غير معروفة. القنوات: ' + STUDIO_CHANNELS.filter((c) => c.type === 'chat').map((c) => c.name).join('، '));
  return ch;
}

module.exports = {
  HttpError,
  configure,
  BUILDS_DIR,
  STUDIO_CHANNELS,
  register,
  login,
  logout,
  userBySession,
  publicUser,
  createConnectorToken,
  hasConnectorToken,
  userByToken,
  listMessages,
  postMessage,
  serverView,
  getServer,
  canReadServer,
  listGames,
  getGame,
  uploadSoloGame,
  updateSoloGame,
  listStudios,
  createStudio,
  getStudio,
  getStudioRaw,
  requireMember,
  requireActive,
  inviteToStudio,
  acceptInvite,
  declineInvite,
  updateContract,
  signContract,
  createProject,
  updateProject,
  setLayerOwner,
  proposeAgreement,
  editAgreement,
  setAgreementStatus,
  decideApproval,
  addTrialUpload,
  addTrialLink,
  requestPublish,
  projectContext,
  studioChatChannel
};
