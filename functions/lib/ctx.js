'use strict';
// أدوات مشتركة بين كل ملفات القواعد.
//
// ملاحظة للمطوّر: الكود هون بيستخدم عمليات Firestore البسيطة بس
// (get / set / update / delete / where / batch / transaction)،
// وما بيستخدم arrayUnion ولا increment ولا تحديث بمسار منقّط،
// عشان نفس الكود يشتغل على قاعدة البيانات التجريبية اللي بالاختبارات.

class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new AppError(code, message);
}

const ID_RE = /^[A-Za-z0-9]{10,40}$/;
const RESERVED_NAMES = ['cilyo', 'admin', 'administrator', 'support', 'system'];

function requiredText(value, max, label) {
  const t = typeof value === 'string' ? value.trim() : '';
  if (!t) fail('invalid-argument', `لازم تكتب ${label}`);
  if (t.length > max) fail('invalid-argument', `${label} طويل كثير (الحد ${max} حرف)`);
  return t;
}

function optionalText(value, max, label) {
  const t = typeof value === 'string' ? value.trim() : '';
  if (t.length > max) fail('invalid-argument', `${label} طويل كثير (الحد ${max} حرف)`);
  return t;
}

function cleanId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail('invalid-argument', `${label} غير صالح`);
  return value;
}

function cleanUsername(value) {
  const name = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(name)) {
    fail('invalid-argument', 'اسم المستخدم لازم يكون من 3 لـ24 حرف أو رقم، بدون مسافات ولا رموز غير _ و -');
  }
  if (RESERVED_NAMES.includes(name.toLowerCase())) fail('invalid-argument', 'هاد الاسم محجوز، اختار اسم ثاني');
  // قاعدة البيانات بتحجز الأسماء اللي شكلها __x__
  if (/^__.*__$/.test(name)) fail('invalid-argument', 'اسم المستخدم ما بينفع يبدأ وينتهي بشرطتين سفليتين');
  return name;
}

function cleanRepoUrl(value) {
  const t = optionalText(value, 300, 'رابط المستودع');
  if (t && !/^https:\/\/[^\s]+$/i.test(t)) fail('invalid-argument', 'رابط المستودع لازم يبدأ بـ https://');
  return t;
}

function cleanLink(value, label) {
  const t = optionalText(value, 500, label);
  if (!/^https?:\/\/[^\s]+$/i.test(t)) fail('invalid-argument', `${label} لازم يبدأ بـ http:// أو https://`);
  return t;
}

// بيطلّع رقم الفيديو من رابط YouTube أو Vimeo
function parseVideoUrl(value) {
  const raw = optionalText(value, 300, 'رابط الفيديو');
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    fail('invalid-argument', 'رابط الفيديو مش صحيح');
  }
  const host = url.hostname.replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = /^\/(embed|shorts|live)\/([^/]+)/.exec(url.pathname);
      if (m) id = m[2];
    }
  }
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return { provider: 'youtube', videoId: id };
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /(?:^|\/)(\d{6,12})(?:$|\/)/.exec(url.pathname);
    if (m) return { provider: 'vimeo', videoId: m[1] };
  }
  return fail('invalid-argument', 'بنقبل روابط YouTube و Vimeo بس');
}

function uniq(list) {
  return Array.from(new Set(list));
}

function makeCtx({ db, getBucket, serverTimestamp, logger }) {
  const log = logger || console;

  async function getProfile(uid) {
    const snap = await db.doc(`users/${uid}`).get();
    if (!snap.exists) fail('failed-precondition', 'لازم تختار اسم مستخدم أول');
    return snap.data();
  }

  async function userByName(username) {
    const key = typeof username === 'string' ? username.normalize('NFKC').trim().toLowerCase() : '';
    // نفس شروط اسم المستخدم، عشان ما ينبعت لقاعدة البيانات اسم مستند غير صالح
    if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(key) || /^__.*__$/.test(key)) fail('not-found', 'ما في مستخدم بهالاسم');
    const nameSnap = await db.doc(`usernames/${key}`).get();
    if (!nameSnap.exists) fail('not-found', 'ما في مستخدم بهالاسم. لازم يعمل حساب بـCilyo أول.');
    const uid = nameSnap.data().uid;
    const profile = await getProfile(uid);
    return { uid, username: profile.username };
  }

  return { db, getBucket, ts: serverTimestamp, log, getProfile, userByName };
}

module.exports = {
  AppError,
  fail,
  requiredText,
  optionalText,
  cleanId,
  cleanUsername,
  cleanRepoUrl,
  cleanLink,
  parseVideoUrl,
  uniq,
  makeCtx
};
