'use strict';
// لوحة الفرص: استوديو بينشر دور مفتوح (مطلوب مسوّق، مصمم شخصيات…)، والناس بتتقدم.
const { fail, requiredText, optionalText, cleanId } = require('./ctx');

const MAX_OPEN_PER_STUDIO = 10;

function makeBoard(ctx, studios) {
  const { db, ts, getProfile } = ctx;

  async function postOpenRole(uid, data) {
    const profile = await getProfile(uid);
    const { studioId, studio } = await studios.activeStudioFor(uid, data.studioId);
    const title = requiredText(data.title, 80, 'عنوان الدور');
    const description = requiredText(data.description, 1000, 'وصف الدور');
    if (data.kind !== 'production' && data.kind !== 'service') fail('invalid-argument', 'نوع الدور لازم يكون إنتاج أو خدمة');
    const open = await db.collection('openRoles').where('studioId', '==', studioId).where('status', '==', 'open').count().get();
    if (open.data().count >= MAX_OPEN_PER_STUDIO) fail('resource-exhausted', 'وصل الاستوديو للحد الأقصى من الأدوار المفتوحة. سكّروا دور قديم.');
    const ref = db.collection('openRoles').doc();
    await ref.set({
      studioId,
      studioName: studio.name,
      title,
      description,
      kind: data.kind,
      createdBy: uid,
      createdByName: profile.username,
      status: 'open',
      createdAt: ts()
    });
    return { roleId: ref.id };
  }

  async function closeOpenRole(uid, data) {
    const ref = db.doc(`openRoles/${cleanId(data.roleId, 'رقم الدور')}`);
    const snap = await ref.get();
    if (!snap.exists) fail('not-found', 'الدور مش موجود');
    const studioSnap = await db.doc(`studios/${snap.data().studioId}`).get();
    if (!studioSnap.exists || !studioSnap.data().members.includes(uid)) fail('permission-denied', 'بس أعضاء الاستوديو بيسكّروا الدور');
    await ref.update({ status: 'closed' });
    return { ok: true };
  }

  async function applyToRole(uid, data) {
    const profile = await getProfile(uid);
    const ref = db.doc(`openRoles/${cleanId(data.roleId, 'رقم الدور')}`);
    const snap = await ref.get();
    if (!snap.exists || snap.data().status !== 'open') fail('not-found', 'هاد الدور مش مفتوح');
    const role = snap.data();
    const studioSnap = await db.doc(`studios/${role.studioId}`).get();
    if (studioSnap.exists && studioSnap.data().members.includes(uid)) fail('failed-precondition', 'إنت عضو بهاد الاستوديو أصلًا');
    const message = optionalText(data.message, 600, 'رسالتك');
    if (!message) fail('invalid-argument', 'اكتب رسالة قصيرة عن خبرتك وليش مناسب للدور');
    await ref.collection('applications').doc(uid).set({
      uid,
      username: profile.username,
      studioId: role.studioId,
      message,
      at: ts()
    });
    return { ok: true };
  }

  return { api: { postOpenRole, closeOpenRole, applyToRole } };
}

module.exports = { makeBoard };
