'use strict';
// اختبارات قواعد السيرفر. التشغيل: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');

const fn = (p) => path.join(__dirname, '..', 'functions', p);
const AdmZip = require(fn('node_modules/adm-zip'));
const express = require(fn('node_modules/express'));
const { makeCore, AppError } = require(fn('lib/core'));
const { planGameZip, ZipError } = require(fn('lib/zip'));
const { parseVideoUrl, cleanUsername } = require(fn('lib/ctx'));
const { makeGameHandler, parseRange } = require(fn('lib/serve'));
const { makeMcpHandler } = require(fn('lib/mcp'));
const { contentTypeFor } = require(fn('lib/mime'));
const { makeFakes } = require('./fake');

function zip(files) {
  const z = new AdmZip();
  for (const [name, text] of Object.entries(files)) z.addFile(name, Buffer.from(text));
  return z.toBuffer();
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AppError, 'expected AppError, got: ' + (err && err.stack));
    assert.equal(err.code, code, err.message);
    return true;
  });
}

// عالم جديد لكل اختبار: مستخدمين بأسماء، ودالة لرفع zip
async function world(...names) {
  const fakes = makeFakes();
  const core = makeCore(fakes.deps);
  const users = {};
  for (const name of names) {
    users[name] = 'uid' + name.padEnd(12, '0');
    await core.api.createProfile(users[name], { username: name });
  }
  let n = 0;
  const upload = (uid, files) => {
    const id = 'upload' + String(++n).padStart(4, '0');
    fakes.bucket.put(`uploads/${uid}/${id}.zip`, zip(files || { 'index.html': '<h1>game</h1>', 'js/a.js': '1' }));
    return id;
  };
  const get = async (p) => (await fakes.db.doc(p).get()).data();
  const list = async (p) => (await fakes.db.collection(p).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const personal = async (name) => (await get(`users/${users[name]}`)).personalStudioId;
  return { ...fakes, core, api: core.api, users, upload, get, list, personal };
}

// استوديو مشترك شغال بعضوين
async function sharedStudio(w, a, b, sharePct = 10) {
  const { studioId } = await w.api.createStudio(w.users[a], { name: 'استوديو التجربة', sharePct });
  await w.api.inviteToStudio(w.users[a], { studioId, username: b });
  await w.api.respondStudioInvite(w.users[b], { studioId, accept: true });
  await w.api.signStudioContract(w.users[a], { studioId });
  const r = await w.api.signStudioContract(w.users[b], { studioId });
  assert.equal(r.status, 'active');
  return studioId;
}

// مشروع بميثاق موقّع ودورين
async function chartered(w, a, b, kind = 'game', rule = 'unanimous') {
  const studioId = await sharedStudio(w, a, b);
  const { projectId } = await w.api.createProject(w.users[a], { studioId, name: 'القلعة', kind, repoUrl: 'https://github.com/x/y' });
  await w.api.saveCharter(w.users[a], {
    projectId,
    decisionRule: rule,
    roles: [
      { name: 'أنظمة اللعب', kind: 'production', holderUid: w.users[a], weight: 50 },
      { name: 'العالم والخريطة', kind: 'production', holderUid: w.users[b], weight: 30 },
      { name: 'التسويق', kind: 'service', holderUid: w.users[b], weight: 20, periods: 4 }
    ]
  });
  await w.api.signCharter(w.users[b], { projectId });
  const roles = (await w.list(`projects/${projectId}/roles`)).sort((x, y) => x.order - y.order);
  return { studioId, projectId, roles };
}

test('zip: بيقبل لعبة سليمة وبيختار أقرب index.html', () => {
  const plan = planGameZip(zip({ 'game/index.html': 'a', 'game/deep/index.html': 'b', 'game/js/x.js': 'c', '../evil.txt': 'x', '__MACOSX/junk': 'j' }));
  assert.equal(plan.entry, 'game/index.html');
  assert.deepEqual(plan.files.map((f) => f.path).sort(), ['evil.txt', 'game/deep/index.html', 'game/index.html', 'game/js/x.js']);
  assert.equal(plan.files.find((f) => f.path === 'game/js/x.js').read().toString(), 'c');
});

test('zip: بيرفض الملفات الغلط', () => {
  assert.throws(() => planGameZip(Buffer.from('not a zip')), ZipError);
  assert.throws(() => planGameZip(zip({ 'main.js': '1' })), /index\.html/);
  assert.throws(() => planGameZip(Buffer.alloc(0)), ZipError);
});

test('أدوات: أنواع الملفات وروابط الفيديو وأسماء المستخدمين والـRange', () => {
  assert.equal(contentTypeFor('a/b/game.JS'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('data.unknown'), 'application/octet-stream');
  assert.deepEqual(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'), { provider: 'youtube', videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ'), { provider: 'youtube', videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseVideoUrl('https://vimeo.com/123456789'), { provider: 'vimeo', videoId: '123456789' });
  assert.throws(() => parseVideoUrl('https://evil.example/watch?v=dQw4w9WgXcQ'), AppError);
  assert.throws(() => parseVideoUrl('javascript:alert(1)'), AppError);
  assert.equal(cleanUsername('  عماد_1 '), 'عماد_1');
  assert.throws(() => cleanUsername('a b'), AppError);
  assert.throws(() => cleanUsername('Admin'), AppError);
  assert.throws(() => cleanUsername('__proto__'), AppError);
  assert.deepEqual(parseRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.equal(parseRange('bytes=20-', 10), 'invalid');
  assert.equal(parseRange(undefined, 10), null);
});

test('الحساب: اسم مستخدم فريد واستوديو شخصي تلقائي', async () => {
  const w = await world('imad');
  const user = await w.get(`users/${w.users.imad}`);
  const studio = await w.get(`studios/${user.personalStudioId}`);
  assert.equal(studio.kind, 'personal');
  assert.equal(studio.status, 'active');
  assert.deepEqual(studio.members, [w.users.imad]);
  await rejects(w.api.createProfile('uidother0000000', { username: 'IMAD' }), 'already-exists');
  await rejects(w.api.createProfile(w.users.imad, { username: 'second' }), 'already-exists');
  await rejects(w.api.publishWork('uidnoprofile000', { type: 'game', title: 'x', uploadId: 'upload0001' }), 'failed-precondition');
});

test('النشر المباشر: لعبة من zip، تحديث، إخفاء، وصلاحيات', async () => {
  const w = await world('imad', 'sameer');
  const uploadId = w.upload(w.users.imad);
  const { workId } = await w.api.publishWork(w.users.imad, { type: 'game', title: 'لعبتي', description: 'وصف', controls: '', uploadId });
  const work = await w.get(`works/${workId}`);
  assert.equal(work.status, 'published');
  assert.equal(work.entry, 'index.html');
  assert.deepEqual(work.teamUids, [w.users.imad]);
  assert.deepEqual(work.credits, [{ username: 'imad', role: 'صاحب العمل' }]);
  assert.deepEqual(w.bucket.names('games/').sort(), [`games/${work.buildId}/index.html`, `games/${work.buildId}/js/a.js`]);
  assert.equal(w.bucket.names('uploads/').length, 0, 'ملف الرفع لازم ينحذف');
  assert.equal(w.bucket.files.get(`games/${work.buildId}/js/a.js`).contentType, 'text/javascript; charset=utf-8');
  assert.equal((await w.list(`works/${workId}/channels/general/messages`)).length, 1);

  await rejects(w.api.updateWorkInfo(w.users.sameer, { workId, title: 'سرقة' }), 'permission-denied');
  await w.api.updateWorkInfo(w.users.imad, { workId, title: 'اسم جديد' });
  await w.api.setWorkStatus(w.users.imad, { workId, status: 'hidden' });
  assert.equal((await w.get(`works/${workId}`)).status, 'hidden');
  await rejects(w.api.setWorkStatus(w.users.imad, { workId, status: 'removed' }), 'invalid-argument');

  const second = w.upload(w.users.imad, { 'index.html': 'v2' });
  await w.api.updateWorkBuild(w.users.imad, { workId, uploadId: second });
  const after = await w.get(`works/${workId}`);
  assert.notEqual(after.buildId, work.buildId);
  assert.equal(w.bucket.names(`games/${work.buildId}/`).length, 0, 'النسخة القديمة لازم تنحذف');
  assert.equal(after.title, 'اسم جديد');
});

test('النشر المباشر: zip غلط بينرفض وبيتنظف', async () => {
  const w = await world('imad');
  const bad = w.upload(w.users.imad, { 'main.js': 'no index' });
  await rejects(w.api.publishWork(w.users.imad, { type: 'app', title: 'x', uploadId: bad }), 'invalid-argument');
  assert.equal(w.bucket.files.size, 0);
  await rejects(w.api.publishWork(w.users.imad, { type: 'app', title: 'x', uploadId: 'missing000' }), 'not-found');
  await rejects(w.api.publishWork(w.users.imad, { type: 'movie', title: 'x', uploadId: 'missing000' }), 'invalid-argument');
});

test('العمل المرئي: نشر بحلقة وإضافة حلقات', async () => {
  const w = await world('imad');
  const { workId } = await w.api.publishWork(w.users.imad, { type: 'video', title: 'مسلسلي', episodeTitle: 'الحلقة 1', videoUrl: 'https://youtu.be/dQw4w9WgXcQ' });
  await w.api.addEpisode(w.users.imad, { workId, episodeTitle: 'الحلقة 2', videoUrl: 'https://vimeo.com/123456789' });
  const work = await w.get(`works/${workId}`);
  assert.equal(work.buildId, null);
  assert.deepEqual(work.episodes, [
    { title: 'الحلقة 1', provider: 'youtube', videoId: 'dQw4w9WgXcQ' },
    { title: 'الحلقة 2', provider: 'vimeo', videoId: '123456789' }
  ]);
  await rejects(w.api.publishWork(w.users.imad, { type: 'video', title: 'x', episodeTitle: 'y', videoUrl: 'https://example.com/v' }), 'invalid-argument');
});

test('الإشراف: بس المشرف بيشيل عمل، وملفاته بتنحذف', async () => {
  const w = await world('imad', 'boss');
  const { workId } = await w.api.publishWork(w.users.imad, { type: 'game', title: 'لعبة', uploadId: w.upload(w.users.imad) });
  await rejects(w.api.adminRemoveWork(w.users.imad, { workId }), 'permission-denied');
  await w.db.doc(`admins/${w.users.boss}`).set({ note: 'admin' });
  await w.api.adminRemoveWork(w.users.boss, { workId });
  assert.equal((await w.get(`works/${workId}`)).status, 'removed');
  assert.equal(w.bucket.names('games/').length, 0);
  await rejects(w.api.setWorkStatus(w.users.imad, { workId, status: 'published' }), 'failed-precondition');
});

test('الاستوديو المشترك: العقد والتوقيع قبل الفتح', async () => {
  const w = await world('imad', 'sameer', 'stranger');
  const { studioId } = await w.api.createStudio(w.users.imad, { name: 'استوديو الليمون' });
  await rejects(w.api.createProject(w.users.imad, { studioId, name: 'x', kind: 'game' }), 'failed-precondition');
  await w.api.signStudioContract(w.users.imad, { studioId });
  assert.equal((await w.get(`studios/${studioId}`)).status, 'pending', 'عضو واحد ما بيفتح استوديو مشترك');
  await rejects(w.api.inviteToStudio(w.users.stranger, { studioId, username: 'sameer' }), 'permission-denied');
  await rejects(w.api.inviteToStudio(w.users.imad, { studioId, username: 'nobody' }), 'not-found');
  await w.api.inviteToStudio(w.users.imad, { studioId, username: 'Sameer' });
  await rejects(w.api.respondStudioInvite(w.users.stranger, { studioId, accept: true }), 'not-found');
  assert.equal((await w.api.respondStudioInvite(w.users.sameer, { studioId, accept: true })).status, 'joined');
  let contract = await w.get(`studios/${studioId}/internal/contract`);
  assert.deepEqual(contract.signatures, {}, 'عضو جديد بيرجّع التواقيع');
  await w.api.signStudioContract(w.users.imad, { studioId });
  await w.api.setStudioContract(w.users.sameer, { studioId, sharePct: 15 });
  contract = await w.get(`studios/${studioId}/internal/contract`);
  assert.deepEqual(contract.signatures, {}, 'تعديل العقد بيرجّع التواقيع');
  assert.equal(contract.sharePct, 15);
  await rejects(w.api.setStudioContract(w.users.sameer, { studioId, sharePct: 80 }), 'invalid-argument');
  await w.api.signStudioContract(w.users.imad, { studioId });
  assert.equal((await w.api.signStudioContract(w.users.sameer, { studioId })).status, 'active');
  assert.equal((await w.get(`studios/${studioId}`)).status, 'active');
});

test('الاستوديو المشترك: بعد الفتح، العضو الجديد وتعديل العقد بدهم موافقة الكل', async () => {
  const w = await world('imad', 'sameer', 'lina');
  const studioId = await sharedStudio(w, 'imad', 'sameer');
  await w.api.inviteToStudio(w.users.imad, { studioId, username: 'lina' });
  assert.equal((await w.api.respondStudioInvite(w.users.lina, { studioId, accept: true })).status, 'waiting');
  await rejects(w.api.approveStudioMember(w.users.imad, { studioId, memberUid: '__proto__', approve: true }), 'not-found');
  await rejects(w.api.approveStudioMember(w.users.imad, { studioId, memberUid: 'constructor', approve: true }), 'not-found');
  await rejects(w.api.inviteToStudio(w.users.imad, { studioId, username: '..' }), 'not-found');
  await rejects(w.api.inviteToStudio(w.users.imad, { studioId, username: 'a/b' }), 'not-found');
  assert.equal((await w.api.approveStudioMember(w.users.imad, { studioId, memberUid: w.users.lina, approve: true })).status, 'waiting');
  assert.deepEqual((await w.get(`studios/${studioId}`)).members, [w.users.imad, w.users.sameer]);
  assert.equal((await w.api.approveStudioMember(w.users.sameer, { studioId, memberUid: w.users.lina, approve: true })).status, 'joined');
  const studio = await w.get(`studios/${studioId}`);
  assert.deepEqual(studio.members, [w.users.imad, w.users.sameer, w.users.lina]);
  assert.deepEqual(studio.invites, []);

  assert.equal((await w.api.setStudioContract(w.users.imad, { studioId, sharePct: 20 })).status, 'proposed');
  assert.equal((await w.get(`studios/${studioId}/internal/contract`)).sharePct, 10, 'النسبة ما بتتغير قبل توقيع الكل');
  await w.api.signStudioContract(w.users.sameer, { studioId });
  assert.equal((await w.api.signStudioContract(w.users.lina, { studioId })).status, 'changed');
  assert.equal((await w.get(`studios/${studioId}/internal/contract`)).sharePct, 20);

  await w.api.leaveStudio(w.users.imad, { studioId });
  const after = await w.get(`studios/${studioId}`);
  assert.deepEqual(after.members, [w.users.sameer, w.users.lina]);
  assert.equal(after.ownerUid, w.users.sameer);
});

test('المشروع: الميثاق لازم ينوقّع من الكل قبل الشغل', async () => {
  const w = await world('imad', 'sameer');
  const studioId = await sharedStudio(w, 'imad', 'sameer');
  const { projectId } = await w.api.createProject(w.users.imad, { studioId, name: 'القلعة', kind: 'game' });
  const p = await w.get(`projects/${projectId}`);
  assert.deepEqual(p.participants, [w.users.imad, w.users.sameer]);
  assert.equal(p.studioSharePct, 10);
  await rejects(w.api.saveCharter(w.users.sameer, { projectId, decisionRule: 'unanimous', roles: [] }), 'permission-denied');
  await rejects(
    w.api.saveCharter(w.users.imad, { projectId, decisionRule: 'unanimous', roles: [{ name: 'x', kind: 'production', holderUid: 'uidstranger0000', weight: 5 }] }),
    'invalid-argument'
  );
  await w.api.saveCharter(w.users.imad, {
    projectId,
    decisionRule: 'unanimous',
    roles: [
      { name: 'أنظمة اللعب', kind: 'production', holderUid: w.users.imad, weight: 60 },
      { name: 'العالم', kind: 'production', holderUid: w.users.sameer, weight: 40 }
    ]
  });
  const roles = await w.list(`projects/${projectId}/roles`);
  await rejects(
    w.api.proposeAgreement(w.users.imad, { projectId, title: 'x', fromRoleId: roles[0].id, toRoleId: roles[1].id }),
    'failed-precondition'
  );
  assert.equal((await w.api.signCharter(w.users.sameer, { projectId })).active, true);
  // تعديل الميثاق بيرجّع التواقيع
  await w.api.saveCharter(w.users.imad, {
    projectId,
    decisionRule: 'lead',
    roles: roles.map((r) => ({ id: r.id, name: r.name, kind: r.kind, holderUid: r.holderUid, weight: r.weight }))
  });
  const again = await w.get(`projects/${projectId}`);
  assert.deepEqual(again.charterSignatures, { [w.users.imad]: true });
  assert.equal(again.charterVersion, 2);
  assert.equal(again.roleIds.length, 2);
});

test('الاتفاقات: اقتراح، موافقة، منفّذ، معتمد، وتعديل بيرجّعها للموافقة', async () => {
  const w = await world('imad', 'sameer');
  const { projectId, roles } = await chartered(w, 'imad', 'sameer');
  const [gameplay, world_] = roles;
  const { agreementId, status } = await w.api.proposeAgreement(w.users.imad, { projectId, title: 'اللاعب بيقفز مترين', fromRoleId: gameplay.id, toRoleId: world_.id });
  assert.equal(status, 'proposed');
  let approvals = await w.list(`projects/${projectId}/approvals`);
  assert.deepEqual(approvals[0].required, [w.users.sameer]);
  await rejects(w.api.decideApproval(w.users.imad, { projectId, approvalId: approvals[0].id, decision: 'yes' }), 'permission-denied');
  await rejects(w.api.setAgreementStatus(w.users.imad, { projectId, agreementId, status: 'implemented' }), 'failed-precondition');
  await w.api.decideApproval(w.users.sameer, { projectId, approvalId: approvals[0].id, decision: 'yes' });
  assert.equal((await w.get(`projects/${projectId}/agreements/${agreementId}`)).status, 'agreed');
  await rejects(w.api.decideApproval(w.users.sameer, { projectId, approvalId: approvals[0].id, decision: 'yes' }), 'failed-precondition');
  await rejects(w.api.setAgreementStatus(w.users.sameer, { projectId, agreementId, status: 'implemented' }), 'permission-denied');
  await w.api.setAgreementStatus(w.users.imad, { projectId, agreementId, status: 'implemented' });
  await rejects(w.api.setAgreementStatus(w.users.imad, { projectId, agreementId, status: 'approved' }), 'permission-denied');
  await w.api.setAgreementStatus(w.users.sameer, { projectId, agreementId, status: 'approved' });

  await w.api.editAgreement(w.users.imad, { projectId, agreementId, title: 'اللاعب بيقفز متر ونص' });
  const g = await w.get(`projects/${projectId}/agreements/${agreementId}`);
  assert.equal(g.status, 'proposed');
  approvals = await w.list(`projects/${projectId}/approvals`);
  const open = approvals.find((a) => a.status === 'open');
  await w.api.decideApproval(w.users.sameer, { projectId, approvalId: open.id, decision: 'no' });
  assert.equal((await w.get(`projects/${projectId}/agreements/${agreementId}`)).status, 'rejected');

  // تعديل ثاني بيلغي الطلب المفتوح القديم
  await w.api.editAgreement(w.users.imad, { projectId, agreementId, title: 'نسخة 2' });
  await w.api.editAgreement(w.users.imad, { projectId, agreementId, title: 'نسخة 3' });
  approvals = await w.list(`projects/${projectId}/approvals`);
  assert.equal(approvals.filter((a) => a.status === 'open').length, 1);
  assert.equal(approvals.filter((a) => a.status === 'cancelled').length, 1);
});

test('الحصص: بتنكسب بالتسليم المعتمد، ودور الخدمة على فترات', async () => {
  const w = await world('imad', 'sameer');
  const { projectId, roles } = await chartered(w, 'imad', 'sameer');
  const [gameplay, , marketing] = roles;
  await rejects(w.api.requestEarning(w.users.sameer, { projectId, roleId: gameplay.id }), 'permission-denied');
  await w.api.requestEarning(w.users.imad, { projectId, roleId: gameplay.id, note: 'خلصت' });
  await rejects(w.api.requestEarning(w.users.imad, { projectId, roleId: gameplay.id }), 'failed-precondition');
  let open = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
  await w.api.decideApproval(w.users.sameer, { projectId, approvalId: open.id, decision: 'yes' });
  let p = await w.get(`projects/${projectId}`);
  assert.equal(p.earned[w.users.imad], 50);
  await rejects(w.api.requestEarning(w.users.imad, { projectId, roleId: gameplay.id }), 'failed-precondition');

  // التسويق: 20 نقطة على 4 فترات = 5 لكل فترة
  for (let i = 0; i < 2; i++) {
    await w.api.requestEarning(w.users.sameer, { projectId, roleId: marketing.id });
    open = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
    await w.api.decideApproval(w.users.imad, { projectId, approvalId: open.id, decision: 'yes' });
  }
  p = await w.get(`projects/${projectId}`);
  assert.equal(p.earned[w.users.sameer], 10);
  const role = await w.get(`projects/${projectId}/roles/${marketing.id}`);
  assert.equal(role.periodsEarned, 2);
  assert.equal((await w.list(`projects/${projectId}/earnings`)).length, 3);

  // رفض فترة: ما بتنكسب، وبيقدر يطلب من جديد
  await w.api.requestEarning(w.users.sameer, { projectId, roleId: marketing.id });
  open = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
  await w.api.decideApproval(w.users.imad, { projectId, approvalId: open.id, decision: 'no' });
  assert.equal((await w.get(`projects/${projectId}`)).earned[w.users.sameer], 10);
  await w.api.requestEarning(w.users.sameer, { projectId, roleId: marketing.id });

  // وزن الدور ما بينزل تحت اللي انكسب، والدور المحذوف نقاطه بتضل محسوبة
  const cur = (await w.list(`projects/${projectId}/roles`)).sort((x, y) => x.order - y.order);
  const asInput = (r, extra) => ({ id: r.id, name: r.name, kind: r.kind, holderUid: r.holderUid, weight: r.weight, periods: r.periods, ...extra });
  await rejects(
    w.api.saveCharter(w.users.imad, { projectId, decisionRule: 'unanimous', roles: [asInput(cur[0], { weight: 40 }), asInput(cur[1]), asInput(cur[2])] }),
    'invalid-argument'
  );
  await w.api.saveCharter(w.users.imad, { projectId, decisionRule: 'unanimous', roles: [asInput(cur[1]), asInput(cur[2])] });
  p = await w.get(`projects/${projectId}`);
  assert.equal(p.orphanPoints, 50);
  assert.equal(p.earned[w.users.imad], 50);
});

test('التجارب والنشر: بدّه موافقة كل المشاركين، وبينعمل العمل بالمتجر بأسماء الأدوار', async () => {
  const w = await world('imad', 'sameer', 'stranger');
  const { projectId, studioId } = await chartered(w, 'imad', 'sameer');
  await rejects(w.api.addTrial(w.users.stranger, { projectId, uploadId: w.upload(w.users.stranger) }), 'permission-denied');
  const { trialId } = await w.api.addTrial(w.users.imad, { projectId, uploadId: w.upload(w.users.imad), note: 'أول نسخة' });
  const link = await w.api.addTrialLink(w.users.sameer, { projectId, url: 'https://x.github.io/castle/', note: 'رابط' });
  await rejects(w.api.addTrialLink(w.users.sameer, { projectId, url: 'javascript:alert(1)' }), 'invalid-argument');
  await rejects(w.api.requestPublish(w.users.sameer, { projectId, trialId: link.trialId, title: 'القلعة' }), 'failed-precondition');

  assert.equal((await w.api.requestPublish(w.users.sameer, { projectId, trialId, title: 'القلعة', description: 'لعبة قصيرة' })).status, 'open');
  assert.equal((await w.list('works')).length, 0, 'ما بتنتشر قبل موافقة الكل');
  await rejects(w.api.requestPublish(w.users.imad, { projectId, trialId, title: 'القلعة' }), 'failed-precondition');
  await rejects(w.api.deleteTrial(w.users.imad, { projectId, trialId }), 'failed-precondition');
  const open = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
  await w.api.decideApproval(w.users.imad, { projectId, approvalId: open.id, decision: 'yes' });

  const works = await w.list('works');
  assert.equal(works.length, 1);
  const work = works[0];
  assert.equal(work.title, 'القلعة');
  assert.equal(work.studioId, studioId);
  assert.equal(work.projectId, projectId);
  assert.deepEqual(work.teamUids, [w.users.imad, w.users.sameer]);
  assert.deepEqual(work.credits, [
    { username: 'imad', role: 'أنظمة اللعب' },
    { username: 'sameer', role: 'العالم والخريطة' },
    { username: 'sameer', role: 'التسويق' }
  ]);
  assert.equal((await w.get(`projects/${projectId}`)).workId, work.id);
  // العمل التابع لمشروع ما بيتعدّل من «أعمالي»
  await rejects(w.api.updateWorkInfo(w.users.imad, { workId: work.id, title: 'x' }), 'permission-denied');
  await rejects(w.api.deleteTrial(w.users.imad, { projectId, trialId }), 'failed-precondition');

  // تحديث: نسخة جديدة بنفس المسار
  const v2 = await w.api.addTrial(w.users.sameer, { projectId, uploadId: w.upload(w.users.sameer, { 'index.html': 'v2' }), note: 'v2' });
  await w.api.requestPublish(w.users.imad, { projectId, trialId: v2.trialId });
  const open2 = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
  await w.api.decideApproval(w.users.sameer, { projectId, approvalId: open2.id, decision: 'yes' });
  const updated = await w.get(`works/${work.id}`);
  assert.notEqual(updated.buildId, work.buildId);
  assert.equal(updated.title, 'القلعة');
  assert.equal((await w.list('works')).length, 1);
  // رفض النشر بيفتح المجال لطلب جديد
  await w.api.requestPublish(w.users.imad, { projectId, trialId: v2.trialId });
  const open3 = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
  await w.api.decideApproval(w.users.sameer, { projectId, approvalId: open3.id, decision: 'no' });
  assert.equal((await w.get(`projects/${projectId}`)).openPublishId, null);
});

test('مشروع مرئي: النشر بالحلقات', async () => {
  const w = await world('imad', 'sameer');
  const { projectId } = await chartered(w, 'imad', 'sameer', 'video');
  await rejects(w.api.addTrial(w.users.imad, { projectId, uploadId: w.upload(w.users.imad) }), 'failed-precondition');
  await w.api.requestPublish(w.users.imad, { projectId, title: 'الأنمي', episodeTitle: 'الحلقة 1', videoUrl: 'https://youtu.be/dQw4w9WgXcQ' });
  let open = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
  await w.api.decideApproval(w.users.sameer, { projectId, approvalId: open.id, decision: 'yes' });
  await w.api.requestPublish(w.users.sameer, { projectId, episodeTitle: 'الحلقة 2', videoUrl: 'https://youtu.be/aaaaaaaaaaa' });
  open = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
  await w.api.decideApproval(w.users.imad, { projectId, approvalId: open.id, decision: 'yes' });
  const [work] = await w.list('works');
  assert.equal(work.type, 'video');
  assert.deepEqual(work.episodes.map((e) => e.title), ['الحلقة 1', 'الحلقة 2']);
});

test('مشروع فردي بضيف: دعوة، انضمام، ونشر فوري للمشارك الوحيد', async () => {
  const w = await world('imad', 'guest');
  const studioId = await w.personal('imad');
  const { projectId } = await w.api.createProject(w.users.imad, { studioId, name: 'برنامجي', kind: 'app' });
  const { trialId } = await w.api.addTrial(w.users.imad, { projectId, uploadId: w.upload(w.users.imad) });
  assert.equal((await w.api.requestPublish(w.users.imad, { projectId, trialId, title: 'برنامجي' })).status, 'approved');
  const [work] = await w.list('works');
  assert.deepEqual(work.teamUids, [w.users.imad]);

  await rejects(w.api.inviteToProject(w.users.guest, { projectId, username: 'guest' }), 'permission-denied');
  await w.api.inviteToProject(w.users.imad, { projectId, username: 'guest' });
  await w.api.respondProjectInvite(w.users.guest, { projectId, accept: true });
  assert.deepEqual((await w.get(`works/${work.id}`)).teamUids, [w.users.imad, w.users.guest], 'فريق العمل بالمتجر بيتحدّث');
  // صار في مشاركين: لازم ميثاق موقّع
  await rejects(w.api.requestPublish(w.users.imad, { projectId, trialId }), 'failed-precondition');
  await rejects(w.api.leaveProject(w.users.imad, { projectId }), 'failed-precondition');
  await w.api.leaveProject(w.users.guest, { projectId });
  assert.deepEqual((await w.get(`works/${work.id}`)).teamUids, [w.users.imad]);
});

test('قاعدة القرار: القائد بيحسم بس لما الميثاق بيعطيه، وما بيحسم طلب بيخصه', async () => {
  const w = await world('imad', 'sameer');
  const strict = await chartered(w, 'imad', 'sameer');
  const { trialId } = await w.api.addTrial(w.users.imad, { projectId: strict.projectId, uploadId: w.upload(w.users.imad) });
  await w.api.requestPublish(w.users.imad, { projectId: strict.projectId, trialId, title: 'لعبة' });
  let open = (await w.list(`projects/${strict.projectId}/approvals`)).find((a) => a.status === 'open');
  await rejects(w.api.decideApproval(w.users.imad, { projectId: strict.projectId, approvalId: open.id, decision: 'yes', force: true }), 'permission-denied');

  const w2 = await world('imad', 'sameer');
  const led = await chartered(w2, 'imad', 'sameer', 'game', 'lead');
  const t = await w2.api.addTrial(w2.users.imad, { projectId: led.projectId, uploadId: w2.upload(w2.users.imad) });
  await w2.api.requestPublish(w2.users.sameer, { projectId: led.projectId, trialId: t.trialId, title: 'لعبة' });
  open = (await w2.list(`projects/${led.projectId}/approvals`)).find((a) => a.status === 'open');
  await rejects(w2.api.decideApproval(w2.users.sameer, { projectId: led.projectId, approvalId: open.id, decision: 'yes', force: true }), 'permission-denied');
  assert.equal((await w2.api.decideApproval(w2.users.imad, { projectId: led.projectId, approvalId: open.id, decision: 'yes', force: true })).status, 'approved');
  assert.equal((await w2.list('works')).length, 1);
  await w2.api.requestEarning(w2.users.imad, { projectId: led.projectId, roleId: led.roles[0].id });
  open = (await w2.list(`projects/${led.projectId}/approvals`)).find((a) => a.status === 'open');
  await rejects(w2.api.decideApproval(w2.users.imad, { projectId: led.projectId, approvalId: open.id, decision: 'yes', force: true }), 'permission-denied');
});

test('سحب دور وشيل مشارك: بموافقة الباقين، والمكتسب بيضل لصاحبه', async () => {
  const w = await world('imad', 'sameer', 'lina');
  const { projectId, roles } = await chartered(w, 'imad', 'sameer');
  await w.api.inviteToProject(w.users.imad, { projectId, username: 'lina' });
  await w.api.respondProjectInvite(w.users.lina, { projectId, accept: true });
  await w.api.signCharter(w.users.lina, { projectId });
  // sameer كسب فترة تسويق
  await w.api.requestEarning(w.users.sameer, { projectId, roleId: roles[2].id });
  let open = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
  await w.api.decideApproval(w.users.imad, { projectId, approvalId: open.id, decision: 'yes' });
  await w.api.decideApproval(w.users.lina, { projectId, approvalId: open.id, decision: 'yes' });
  assert.equal((await w.get(`projects/${projectId}`)).earned[w.users.sameer], 5);

  // سحب دور التسويق: بدّه موافقة imad و lina (مش sameer)
  assert.equal((await w.api.requestRemoval(w.users.imad, { projectId, roleId: roles[2].id, reason: 'غاب شهرين' })).status, 'requested');
  open = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
  assert.deepEqual(open.required, [w.users.imad, w.users.lina]);
  await rejects(w.api.decideApproval(w.users.sameer, { projectId, approvalId: open.id, decision: 'no' }), 'permission-denied');
  await w.api.decideApproval(w.users.lina, { projectId, approvalId: open.id, decision: 'yes' });
  assert.equal((await w.get(`projects/${projectId}/roles/${roles[2].id}`)).holderUid, null);

  // تنازل صاحب الدور عن دوره: فوري
  assert.equal((await w.api.requestRemoval(w.users.sameer, { projectId, roleId: roles[1].id, reason: 'مشغول' })).status, 'released');
  // شيل مشارك
  await rejects(w.api.requestRemoval(w.users.lina, { projectId, targetUid: w.users.imad, reason: 'x' }), 'failed-precondition');
  await w.api.requestRemoval(w.users.lina, { projectId, targetUid: w.users.sameer, reason: 'ما بيرد' });
  open = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
  await w.api.decideApproval(w.users.imad, { projectId, approvalId: open.id, decision: 'yes' });
  const p = await w.get(`projects/${projectId}`);
  assert.deepEqual(p.participants, [w.users.imad, w.users.lina]);
  assert.equal(p.earned[w.users.sameer], 5, 'المكتسب بيضل');
  await rejects(w.api.signCharter(w.users.sameer, { projectId }), 'permission-denied');
  // نقل القيادة
  await w.api.transferLead(w.users.imad, { projectId, toUid: w.users.lina });
  await w.api.leaveProject(w.users.imad, { projectId });
  assert.deepEqual((await w.get(`projects/${projectId}`)).participants, [w.users.lina]);
});

test('لوحة الفرص: نشر دور، تقديم، وإغلاق', async () => {
  const w = await world('imad', 'sameer', 'lina');
  const studioId = await sharedStudio(w, 'imad', 'sameer');
  await rejects(w.api.postOpenRole(w.users.lina, { studioId, title: 'x', description: 'y', kind: 'service' }), 'permission-denied');
  const { roleId } = await w.api.postOpenRole(w.users.imad, { studioId, title: 'مطلوب مسوّق', description: 'تسويق للعبة', kind: 'service' });
  await rejects(w.api.applyToRole(w.users.sameer, { roleId, message: 'أنا' }), 'failed-precondition');
  await w.api.applyToRole(w.users.lina, { roleId, message: 'عندي خبرة' });
  const apps = await w.list(`openRoles/${roleId}/applications`);
  assert.equal(apps[0].username, 'lina');
  assert.equal(apps[0].studioId, studioId);
  await rejects(w.api.closeOpenRole(w.users.lina, { roleId }), 'permission-denied');
  await w.api.closeOpenRole(w.users.sameer, { roleId });
  await rejects(w.api.applyToRole(w.users.lina, { roleId, message: 'كمان مرة' }), 'not-found');
});

test('core.call: بس العمليات المعروفة، والثقيلة لدالتها', async () => {
  const w = await world('imad');
  await rejects(w.core.call(w.users.imad, 'constructor', {}), 'invalid-argument');
  await rejects(w.core.call(w.users.imad, 'nope', {}), 'invalid-argument');
  await rejects(w.core.call(w.users.imad, 'publishWork', {}), 'invalid-argument');
  await rejects(w.core.call(w.users.imad, 'createStudio', { name: 'x' }, { heavy: true }), 'invalid-argument');
  const r = await w.core.call(w.users.imad, 'createStudio', { name: 'استوديو' });
  assert.ok(r.studioId);
});

// سيرفر HTTP صغير عشان نجرب دوال الطلبات الحقيقية
function listen(handler) {
  const app = express();
  app.use(express.json());
  app.use((req, res) => handler(req, res));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

test('تشغيل ملفات الأعمال: الملفات، والمسارات الخبيثة، والـRange', async () => {
  const w = await world('imad');
  const { workId } = await w.api.publishWork(w.users.imad, { type: 'game', title: 'لعبة', uploadId: w.upload(w.users.imad, { 'index.html': '<h1>hello</h1>', 'a b/x.js': 'let a=1' }) });
  const work = await w.get(`works/${workId}`);
  w.bucket.put('secret/key.txt', 'top secret');
  const s = await listen(makeGameHandler(w.core, { error() {} }));
  try {
    const base = `${s.url}/g/${work.buildId}`;
    let r = await fetch(`${base}/index.html`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await r.text(), '<h1>hello</h1>');
    r = await fetch(`${base}/`);
    assert.equal(await r.text(), '<h1>hello</h1>');
    r = await fetch(base, { redirect: 'manual' });
    assert.equal(r.status, 301);
    r = await fetch(`${base}/a%20b/x.js`);
    assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
    r = await fetch(`${base}/index.html`, { headers: { range: 'bytes=4-8' } });
    assert.equal(r.status, 206);
    assert.equal(await r.text(), 'hello');
    assert.equal(r.headers.get('content-range'), 'bytes 4-8/14');
    r = await fetch(`${base}/index.html`, { headers: { 'if-none-match': (await fetch(`${base}/index.html`)).headers.get('etag') } });
    assert.equal(r.status, 304);
    r = await fetch(`${base}/index.html`, { method: 'HEAD' });
    assert.equal(r.headers.get('content-length'), '14');
    for (const bad of [`${base}/missing.js`, `${base}/..%2f..%2fsecret/key.txt`, `${base}/%2e%2e/%2e%2e/secret/key.txt`, `${s.url}/secret/key.txt`, `${s.url}/g/zzz/index.html`, `${base}//index.html`]) {
      assert.equal((await fetch(bad)).status, 404, bad);
    }
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
    assert.equal((await fetch(`${base}/index.html`, { method: 'POST' })).status, 405);
  } finally {
    s.close();
  }
});

test('موصل المساعد (MCP): الرمز، والأدوات، ونفس قواعد الموقع', async () => {
  const w = await world('imad', 'sameer', 'stranger');
  const { projectId, roles } = await chartered(w, 'imad', 'sameer');
  const { token } = await w.api.createConnectorToken(w.users.imad);
  const strangerToken = (await w.api.createConnectorToken(w.users.stranger)).token;
  const s = await listen(makeMcpHandler(w.core.connector, { error() {} }));
  const rpc = async (body, t = token) => {
    const r = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: JSON.stringify(body) });
    return { status: r.status, data: r.status === 202 ? null : await r.json() };
  };
  const tool = async (name, args, t) => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, t);
    const text = r.data.result.content[0].text;
    return { isError: !!r.data.result.isError, value: r.data.result.isError ? text : JSON.parse(text) };
  };
  try {
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'cil_' + '0'.repeat(48))).status, 401);
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.data.result.protocolVersion, '2025-06-18');
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).data.result.tools.length, 9);
    assert.equal((await tool('cilyo_list_projects', {})).value.projects[0].id, projectId);
    const ctx = await tool('cilyo_project_context', { project_id: projectId });
    assert.deepEqual(ctx.value.roles.filter((r) => r.yours).map((r) => r.name), ['أنظمة اللعب']);
    assert.equal(ctx.value.project.charterSigned, true);
    const proposed = await tool('cilyo_propose_agreement', { project_id: projectId, title: 'حدث التقاط المفتاح', from_role: 'أنظمة اللعب', to_role: roles[1].id });
    assert.equal(proposed.value.status, 'proposed');
    assert.equal((await w.list(`projects/${projectId}/agreements`))[0].createdByName, 'imad (المساعد)');
    await tool('cilyo_post_message', { project_id: projectId, text: 'خلصت القفزة' });
    const chat = await tool('cilyo_read_chat', { project_id: projectId });
    assert.equal(chat.value.at(-1).author, 'imad (المساعد)');
    // المساعد ما بيقدر يوافق عن شريك صاحبه
    const open = (await w.list(`projects/${projectId}/approvals`)).find((a) => a.status === 'open');
    assert.equal((await tool('cilyo_decide_approval', { project_id: projectId, approval_id: open.id, decision: 'yes' })).isError, true);
    assert.equal((await tool('cilyo_project_context', { project_id: projectId }, strangerToken)).isError, true);
    assert.equal((await tool('cilyo_list_projects', {}, strangerToken)).value.projects.length, 0);
    // رمز جديد بيوقّف القديم
    await w.api.createConnectorToken(w.users.imad);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 401);
  } finally {
    s.close();
  }
});
