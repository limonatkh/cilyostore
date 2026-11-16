'use strict';
// الاستوديو المشترك: الأعضاء، وعقد الاستوديو، والتوقيع.
//
// عقد الاستوديو بيحدد: مين الأعضاء، ونسبة الاستوديو من كل عمل (صندوق التكاليف والاسم).
// حصص كل مشروع بتتحدد بميثاق المشروع نفسه (شوف projects.js).
const { fail, requiredText, cleanId } = require('./ctx');

const MAX_MEMBERS = 20;
const MAX_STUDIOS_PER_USER = 10;

function cleanSharePct(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 50) fail('invalid-argument', 'نسبة الاستوديو لازم تكون رقم صحيح بين 0 و50');
  return n;
}

function makeStudios(ctx) {
  const { db, ts, getProfile, userByName } = ctx;

  const refs = (studioId) => {
    const studioRef = db.doc(`studios/${studioId}`);
    return { studioRef, internalRef: studioRef.collection('internal').doc('contract') };
  };

  function addLog(writer, studioRef, who, text) {
    writer.set(studioRef.collection('log').doc(), { who, text, at: ts() });
  }

  function systemMessage(writer, studioRef, text) {
    writer.set(studioRef.collection('channels').doc('general').collection('messages').doc(), {
      uid: null,
      author: 'Cilyo',
      system: true,
      text,
      createdAt: ts()
    });
  }

  // بيقرأ الاستوديو وعقده جوّا transaction
  async function load(tx, rawStudioId) {
    const studioId = cleanId(rawStudioId, 'رقم الاستوديو');
    const { studioRef, internalRef } = refs(studioId);
    const [studioSnap, internalSnap] = await Promise.all([tx.get(studioRef), tx.get(internalRef)]);
    if (!studioSnap.exists) fail('not-found', 'الاستوديو مش موجود');
    const studio = studioSnap.data();
    if (studio.kind !== 'shared' || !internalSnap.exists) fail('failed-precondition', 'هاي العملية للاستوديو المشترك بس');
    if (studio.status === 'closed') fail('failed-precondition', 'هاد الاستوديو مسكّر');
    return { studioId, studioRef, internalRef, studio, internal: internalSnap.data() };
  }

  function requireMember(studio, uid) {
    if (!studio.members.includes(uid)) fail('permission-denied', 'إنت مش عضو بهاد الاستوديو');
  }

  async function createStudio(uid, data) {
    const profile = await getProfile(uid);
    const name = requiredText(data.name, 40, 'اسم الاستوديو');
    if (name.length < 2) fail('invalid-argument', 'اسم الاستوديو قصير كثير');
    const sharePct = data.sharePct === undefined ? 10 : cleanSharePct(data.sharePct);
    const mine = await db.collection('studios').where('members', 'array-contains', uid).count().get();
    if (mine.data().count >= MAX_STUDIOS_PER_USER) fail('resource-exhausted', 'وصلت الحد الأقصى لعدد الاستوديوهات');
    const studioRef = db.collection('studios').doc();
    const batch = db.batch();
    batch.set(studioRef, {
      name,
      kind: 'shared',
      status: 'pending',
      ownerUid: uid,
      members: [uid],
      invites: [],
      createdAt: ts()
    });
    batch.set(studioRef.collection('internal').doc('contract'), {
      sharePct,
      version: 1,
      signatures: {},
      proposal: null,
      joinRequests: {},
      names: { [uid]: profile.username }
    });
    addLog(batch, studioRef, profile.username, `أنشأ الاستوديو «${name}»`);
    await batch.commit();
    return { studioId: studioRef.id };
  }

  async function inviteToStudio(uid, data) {
    const profile = await getProfile(uid);
    const target = await userByName(data.username);
    await db.runTransaction(async (tx) => {
      const s = await load(tx, data.studioId);
      requireMember(s.studio, uid);
      if (s.studio.members.includes(target.uid)) fail('already-exists', 'هاد المستخدم عضو أصلًا');
      if (s.studio.invites.includes(target.uid)) fail('already-exists', 'هاد المستخدم معزوم أصلًا');
      if (s.studio.members.length + s.studio.invites.length >= MAX_MEMBERS) fail('resource-exhausted', 'وصل الاستوديو للحد الأقصى من الأعضاء');
      tx.update(s.studioRef, { invites: [...s.studio.invites, target.uid] });
      tx.update(s.internalRef, { names: { ...s.internal.names, [target.uid]: target.username } });
      addLog(tx, s.studioRef, profile.username, `عزم ${target.username} على الاستوديو`);
    });
    return { ok: true };
  }

  async function respondStudioInvite(uid, data) {
    const profile = await getProfile(uid);
    return db.runTransaction(async (tx) => {
      const s = await load(tx, data.studioId);
      if (!s.studio.invites.includes(uid)) fail('not-found', 'ما في دعوة إلك لهاد الاستوديو');
      const invites = s.studio.invites.filter((x) => x !== uid);
      const joinRequests = { ...s.internal.joinRequests };
      if (!data.accept) {
        delete joinRequests[uid];
        tx.update(s.studioRef, { invites });
        tx.update(s.internalRef, { joinRequests });
        addLog(tx, s.studioRef, profile.username, 'رفض الدعوة');
        return { status: 'declined' };
      }
      if (s.studio.status === 'pending') {
        // قبل فتح الاستوديو: بينضم فورًا، والعقد بيرجع بدّه توقيع الكل
        tx.update(s.studioRef, { invites, members: [...s.studio.members, uid] });
        tx.update(s.internalRef, { signatures: {}, version: s.internal.version + 1 });
        addLog(tx, s.studioRef, profile.username, 'قبل الدعوة وانضم. العقد رجع بدّه توقيع الكل.');
        return { status: 'joined' };
      }
      // بعد فتح الاستوديو: قبوله يعني توقيعه على العقد، وبيستنى موافقة كل الأعضاء
      if (joinRequests[uid]) fail('already-exists', 'قبلت الدعوة أصلًا، وبتستنى موافقة الأعضاء');
      joinRequests[uid] = { approvals: {} };
      tx.update(s.internalRef, { joinRequests });
      addLog(tx, s.studioRef, profile.username, 'قبل الدعوة ووقّع العقد. بيستنى موافقة كل الأعضاء.');
      return { status: 'waiting' };
    });
  }

  async function approveStudioMember(uid, data) {
    const profile = await getProfile(uid);
    const memberUid = typeof data.memberUid === 'string' ? data.memberUid : '';
    return db.runTransaction(async (tx) => {
      const s = await load(tx, data.studioId);
      requireMember(s.studio, uid);
      const has = Object.prototype.hasOwnProperty.call(s.internal.joinRequests, memberUid);
      const request = has ? s.internal.joinRequests[memberUid] : null;
      if (!request || !s.studio.invites.includes(memberUid)) fail('not-found', 'ما في طلب انضمام من هاد المستخدم');
      const name = s.internal.names[memberUid] || 'العضو الجديد';
      const joinRequests = { ...s.internal.joinRequests };
      if (!data.approve) {
        delete joinRequests[memberUid];
        tx.update(s.studioRef, { invites: s.studio.invites.filter((x) => x !== memberUid) });
        tx.update(s.internalRef, { joinRequests });
        addLog(tx, s.studioRef, profile.username, `رفض انضمام ${name}`);
        return { status: 'rejected' };
      }
      const approvals = { ...request.approvals, [uid]: true };
      if (!s.studio.members.every((m) => approvals[m])) {
        joinRequests[memberUid] = { approvals };
        tx.update(s.internalRef, { joinRequests });
        addLog(tx, s.studioRef, profile.username, `وافق على انضمام ${name}`);
        return { status: 'waiting' };
      }
      delete joinRequests[memberUid];
      tx.update(s.studioRef, {
        invites: s.studio.invites.filter((x) => x !== memberUid),
        members: [...s.studio.members, memberUid]
      });
      tx.update(s.internalRef, { joinRequests, signatures: { ...s.internal.signatures, [memberUid]: true } });
      addLog(tx, s.studioRef, profile.username, `وافق على انضمام ${name}. صار عضو بموافقة الكل.`);
      systemMessage(tx, s.studioRef, `انضم ${name} للاستوديو بموافقة كل الأعضاء.`);
      return { status: 'joined' };
    });
  }

  async function setStudioContract(uid, data) {
    const profile = await getProfile(uid);
    const sharePct = cleanSharePct(data.sharePct);
    return db.runTransaction(async (tx) => {
      const s = await load(tx, data.studioId);
      requireMember(s.studio, uid);
      if (s.studio.status === 'pending') {
        if (sharePct === s.internal.sharePct) return { status: 'unchanged' };
        tx.update(s.internalRef, { sharePct, signatures: {}, version: s.internal.version + 1 });
        addLog(tx, s.studioRef, profile.username, `عدّل نسبة الاستوديو إلى ${sharePct}%. التواقيع رجعت من الأول.`);
        return { status: 'changed' };
      }
      if (sharePct === s.internal.sharePct) fail('invalid-argument', 'هاي نفس النسبة الحالية');
      tx.update(s.internalRef, { proposal: { sharePct, by: uid, signatures: { [uid]: true } } });
      addLog(tx, s.studioRef, profile.username, `اقترح تغيير نسبة الاستوديو إلى ${sharePct}%. بدّه توقيع الكل.`);
      return { status: 'proposed' };
    });
  }

  async function signStudioContract(uid, data) {
    const profile = await getProfile(uid);
    return db.runTransaction(async (tx) => {
      const s = await load(tx, data.studioId);
      requireMember(s.studio, uid);
      const members = s.studio.members;
      if (s.studio.status === 'pending') {
        const signatures = { ...s.internal.signatures, [uid]: true };
        tx.update(s.internalRef, { signatures });
        addLog(tx, s.studioRef, profile.username, `وقّع عقد الاستوديو (نسخة ${s.internal.version})`);
        if (members.length >= 2 && members.every((m) => signatures[m])) {
          tx.update(s.studioRef, { status: 'active' });
          addLog(tx, s.studioRef, 'Cilyo', 'كل الأعضاء وقّعوا. انفتح الاستوديو.');
          systemMessage(tx, s.studioRef, `انفتح استوديو ${s.studio.name}. ابدأوا بإنشاء مشروع.`);
          return { status: 'active' };
        }
        return { status: 'pending' };
      }
      const proposal = s.internal.proposal;
      if (!proposal) fail('failed-precondition', 'العقد موقّع، وما في تعديل مقترح عليه');
      if (data.reject) {
        tx.update(s.internalRef, { proposal: null });
        addLog(tx, s.studioRef, profile.username, 'رفض تعديل العقد المقترح. العقد ضل زي ما هو.');
        return { status: 'rejected' };
      }
      const signatures = { ...proposal.signatures, [uid]: true };
      if (!members.every((m) => signatures[m])) {
        tx.update(s.internalRef, { proposal: { ...proposal, signatures } });
        addLog(tx, s.studioRef, profile.username, 'وقّع تعديل العقد المقترح');
        return { status: 'proposed' };
      }
      const all = {};
      members.forEach((m) => {
        all[m] = true;
      });
      tx.update(s.internalRef, { sharePct: proposal.sharePct, version: s.internal.version + 1, signatures: all, proposal: null });
      addLog(tx, s.studioRef, 'Cilyo', `كل الأعضاء وقّعوا. نسبة الاستوديو صارت ${proposal.sharePct}% للمشاريع الجديدة.`);
      return { status: 'changed' };
    });
  }

  async function leaveStudio(uid, data) {
    const profile = await getProfile(uid);
    return db.runTransaction(async (tx) => {
      const s = await load(tx, data.studioId);
      requireMember(s.studio, uid);
      const members = s.studio.members.filter((m) => m !== uid);
      const signatures = { ...s.internal.signatures };
      delete signatures[uid];
      const update = { members };
      if (members.length === 0) update.status = 'closed';
      else if (s.studio.ownerUid === uid) update.ownerUid = members[0];
      tx.update(s.studioRef, update);
      tx.update(s.internalRef, { signatures, proposal: null });
      addLog(tx, s.studioRef, profile.username, 'طلع من الاستوديو. حصصه المكتسبة بالمشاريع بتضل إله.');
      if (members.length) systemMessage(tx, s.studioRef, `${profile.username} طلع من الاستوديو.`);
      return { ok: true };
    });
  }

  // لاستخدام ملفات ثانية: هل المستخدم عضو باستوديو شغال؟ بيرجّع بيانات الاستوديو ونسبته.
  async function activeStudioFor(uid, rawStudioId) {
    const studioId = cleanId(rawStudioId, 'رقم الاستوديو');
    const { studioRef, internalRef } = refs(studioId);
    const studioSnap = await studioRef.get();
    if (!studioSnap.exists) fail('not-found', 'الاستوديو مش موجود');
    const studio = studioSnap.data();
    if (!studio.members.includes(uid)) fail('permission-denied', 'إنت مش عضو بهاد الاستوديو');
    if (studio.status !== 'active') fail('failed-precondition', 'الاستوديو لسا ما انفتح. لازم كل الأعضاء يوقّعوا العقد أول.');
    let sharePct = 0;
    if (studio.kind === 'shared') {
      const internalSnap = await internalRef.get();
      sharePct = internalSnap.exists ? internalSnap.data().sharePct : 0;
    }
    return { studioId, studioRef, studio, sharePct };
  }

  return {
    api: { createStudio, inviteToStudio, respondStudioInvite, approveStudioMember, setStudioContract, signStudioContract, leaveStudio },
    activeStudioFor
  };
}

module.exports = { makeStudios };
