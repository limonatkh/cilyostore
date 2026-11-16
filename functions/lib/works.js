'use strict';
// الحساب، والاستوديو الشخصي، والأعمال اللي بينشرها صاحبها مباشرة، وملفات الأعمال.
const crypto = require('crypto');
const { planGameZip, ZipError, LIMITS } = require('./zip');
const { contentTypeFor } = require('./mime');
const { fail, requiredText, optionalText, cleanId, cleanUsername, parseVideoUrl } = require('./ctx');

const WORK_TYPES = ['game', 'app', 'video'];
const MAX_WORKS_PER_STUDIO = 50;
const MAX_EPISODES = 200;
const UPLOAD_RE = /^[A-Za-z0-9_-]{6,40}$/;
const BUILD_RE = /^\/g\/([a-f0-9]{24})(?:\/(.*))?$/;

async function runPool(items, size, worker) {
  let next = 0;
  let failed = false;
  const run = async () => {
    while (next < items.length && !failed) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  // allSettled عشان نستنى كل الشغل اللي بلّش قبل ما ننظّف
  const results = await Promise.allSettled(Array.from({ length: Math.min(size, items.length) }, run));
  const bad = results.find((r) => r.status === 'rejected');
  if (bad) throw bad.reason;
}

function workFields(data, { partial } = {}) {
  const out = {};
  if (!partial || data.title !== undefined) out.title = requiredText(data.title, 80, 'اسم العمل');
  if (!partial || data.description !== undefined) out.description = optionalText(data.description, 2000, 'الوصف');
  if (!partial || data.controls !== undefined) out.controls = optionalText(data.controls, 500, 'طريقة الاستخدام');
  return out;
}

function cleanType(type) {
  if (!WORK_TYPES.includes(type)) fail('invalid-argument', 'نوع العمل لازم يكون لعبة أو برنامج أو عمل مرئي');
  return type;
}

function cleanEpisode(data) {
  const video = parseVideoUrl(data.videoUrl);
  return { title: requiredText(data.episodeTitle, 120, 'عنوان الحلقة أو الفيلم'), ...video };
}

function makeWorks(ctx) {
  const { db, getBucket, ts, log, getProfile } = ctx;

  // ---------- الحساب والاستوديو الشخصي ----------
  async function createProfile(uid, data) {
    const username = cleanUsername(data.username);
    const userRef = db.doc(`users/${uid}`);
    const nameRef = db.doc(`usernames/${username.toLowerCase()}`);
    const studioRef = db.collection('studios').doc();
    await db.runTransaction(async (tx) => {
      const [userSnap, nameSnap] = await Promise.all([tx.get(userRef), tx.get(nameRef)]);
      if (userSnap.exists) fail('already-exists', 'حسابك إله اسم مستخدم أصلًا');
      if (nameSnap.exists) fail('already-exists', 'اسم المستخدم مأخوذ، جرّب اسم ثاني');
      tx.set(nameRef, { uid });
      tx.set(studioRef, {
        name: username,
        kind: 'personal',
        status: 'active',
        ownerUid: uid,
        members: [uid],
        invites: [],
        createdAt: ts()
      });
      tx.set(userRef, { username, personalStudioId: studioRef.id, bio: '', specialties: [], createdAt: ts() });
    });
    return { username, studioId: studioRef.id };
  }

  async function updateProfile(uid, data) {
    await getProfile(uid);
    const bio = optionalText(data.bio, 300, 'النبذة');
    const raw = Array.isArray(data.specialties) ? data.specialties : [];
    const specialties = raw
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
      .slice(0, 8);
    if (specialties.some((s) => s.length > 30)) fail('invalid-argument', 'التخصص الواحد لحد 30 حرف');
    await db.doc(`users/${uid}`).update({ bio, specialties });
    return { ok: true };
  }

  async function renameStudio(uid, data) {
    const studioId = cleanId(data.studioId, 'رقم الاستوديو');
    const name = requiredText(data.name, 40, 'اسم الاستوديو');
    if (name.length < 2) fail('invalid-argument', 'اسم الاستوديو قصير كثير');
    const studioRef = db.doc(`studios/${studioId}`);
    const studioSnap = await studioRef.get();
    if (!studioSnap.exists) fail('not-found', 'الاستوديو مش موجود');
    if (studioSnap.data().ownerUid !== uid) fail('permission-denied', 'بس اللي أنشأ الاستوديو بيغيّر اسمه');
    const works = await db.collection('works').where('studioId', '==', studioId).get();
    const projects = await db.collection('projects').where('studioId', '==', studioId).get();
    const batch = db.batch();
    batch.update(studioRef, { name });
    works.docs.forEach((d) => batch.update(d.ref, { studioName: name }));
    projects.docs.forEach((d) => batch.update(d.ref, { studioName: name }));
    await batch.commit();
    return { name };
  }

  // ---------- ملفات العمل ----------
  // بياخد الـzip اللي رفعه المستخدم، بيفحصه، وبيفكّه لمجلد نسخة جديدة.
  async function ingestUpload(uid, uploadId) {
    if (typeof uploadId !== 'string' || !UPLOAD_RE.test(uploadId)) fail('invalid-argument', 'لازم ترفع ملف zip');
    const bucket = getBucket();
    const zipFile = bucket.file(`uploads/${uid}/${uploadId}.zip`);
    const discard = () => zipFile.delete().catch(() => {});
    let meta;
    try {
      [meta] = await zipFile.getMetadata();
    } catch (e) {
      fail('not-found', 'ما لقينا الملف المرفوع. ارفعه كمان مرة.');
    }
    if (Number(meta.size) > LIMITS.zipBytes) {
      await discard();
      fail('invalid-argument', 'الملف المضغوط أكبر من 100 ميغا');
    }
    const [buffer] = await zipFile.download();
    let plan;
    try {
      plan = planGameZip(buffer);
    } catch (e) {
      await discard();
      if (e instanceof ZipError) fail('invalid-argument', e.message);
      throw e;
    }
    const buildId = crypto.randomBytes(12).toString('hex');
    const prefix = `games/${buildId}/`;
    try {
      await runPool(plan.files, 6, (f) =>
        bucket.file(prefix + f.path).save(f.read(), {
          resumable: false,
          contentType: contentTypeFor(f.path),
          metadata: { cacheControl: 'public, max-age=600' }
        })
      );
    } catch (e) {
      await deleteBuildFiles(buildId);
      await discard();
      if (e instanceof ZipError) fail('invalid-argument', e.message);
      throw e;
    }
    await discard();
    return { id: buildId, entry: plan.entry, size: plan.total, fileCount: plan.files.length };
  }

  async function deleteBuildFiles(buildId) {
    if (!buildId) return;
    try {
      await getBucket().deleteFiles({ prefix: `games/${buildId}/` });
    } catch (e) {
      log.error('فشل حذف ملفات النسخة', buildId, e);
    }
  }

  // ---------- إنشاء عمل (مشترك بين النشر المباشر والنشر من مشروع) ----------
  // writer: batch أو transaction. بيرجّع مرجع العمل الجديد.
  function writeNewWork(writer, { uid, type, fields, studioId, studioName, teamUids, build, episodes, projectId, credits }) {
    const workRef = db.collection('works').doc();
    writer.set(workRef, {
      ...fields,
      type,
      studioId,
      studioName,
      teamUids,
      status: 'published',
      buildId: build ? build.id : null,
      entry: build ? build.entry : null,
      episodes: episodes || [],
      projectId: projectId || null,
      credits: credits || [],
      createdBy: uid,
      createdAt: ts(),
      updatedAt: ts()
    });
    writer.set(workRef.collection('channels').doc('general').collection('messages').doc(), {
      uid: null,
      author: 'Cilyo',
      system: true,
      text: `أهلًا بسيرفر «${fields.title}». انعمل تلقائيًا لما انتشر العمل.`,
      createdAt: ts()
    });
    return workRef;
  }

  function writeNews(writer, workRef, text) {
    writer.set(workRef.collection('channels').doc('news').collection('messages').doc(), {
      uid: null,
      author: 'Cilyo',
      system: true,
      text,
      createdAt: ts()
    });
  }

  // ---------- الأعمال المباشرة (صاحب الاستوديو الشخصي) ----------
  // الأعمال اللي جاية من مشروع بتتعدّل من المشروع بموافقة المشاركين، مش من هون.
  async function loadManagedWork(uid, rawWorkId) {
    const workId = cleanId(rawWorkId, 'رقم العمل');
    const workRef = db.doc(`works/${workId}`);
    const workSnap = await workRef.get();
    if (!workSnap.exists) fail('not-found', 'العمل مش موجود');
    const work = workSnap.data();
    if (work.projectId) fail('permission-denied', 'هاد العمل تابع لمشروع. تعديله بيصير من صفحة المشروع بموافقة المشاركين.');
    const studioSnap = await db.doc(`studios/${work.studioId}`).get();
    const studio = studioSnap.exists ? studioSnap.data() : null;
    if (!studio || studio.kind !== 'personal' || studio.ownerUid !== uid) {
      fail('permission-denied', 'بس صاحب العمل بيقدر يعدّله');
    }
    if (work.status === 'removed') fail('failed-precondition', 'هاد العمل انشال من المنصة');
    return { workRef, work };
  }

  async function publishWork(uid, data) {
    const profile = await getProfile(uid);
    const type = cleanType(data.type);
    const fields = workFields(data);
    const episodes = type === 'video' ? [cleanEpisode(data)] : null;
    const studioId = profile.personalStudioId;
    const studioSnap = await db.doc(`studios/${studioId}`).get();
    if (!studioSnap.exists) fail('failed-precondition', 'الاستوديو الشخصي مش موجود');
    const studio = studioSnap.data();
    const countSnap = await db.collection('works').where('studioId', '==', studioId).count().get();
    if (countSnap.data().count >= MAX_WORKS_PER_STUDIO) {
      fail('resource-exhausted', `وصلت الحد الأقصى (${MAX_WORKS_PER_STUDIO} عمل لكل استوديو)`);
    }
    const build = type === 'video' ? null : await ingestUpload(uid, data.uploadId);
    const batch = db.batch();
    const workRef = writeNewWork(batch, {
      uid,
      type,
      fields,
      studioId,
      studioName: studio.name,
      teamUids: studio.members,
      build,
      episodes,
      credits: [{ username: profile.username, role: 'صاحب العمل' }]
    });
    try {
      await batch.commit();
    } catch (e) {
      if (build) await deleteBuildFiles(build.id);
      throw e;
    }
    return { workId: workRef.id };
  }

  async function updateWorkBuild(uid, data) {
    const { workRef, work } = await loadManagedWork(uid, data.workId);
    if (work.type === 'video') fail('failed-precondition', 'العمل المرئي بتنضافله حلقات، مش ملفات');
    const build = await ingestUpload(uid, data.uploadId);
    const batch = db.batch();
    batch.update(workRef, { buildId: build.id, entry: build.entry, updatedAt: ts() });
    writeNews(batch, workRef, 'نزلت نسخة جديدة.');
    try {
      await batch.commit();
    } catch (e) {
      await deleteBuildFiles(build.id);
      throw e;
    }
    if (work.buildId !== build.id) await deleteBuildFiles(work.buildId);
    return { buildId: build.id };
  }

  async function addEpisode(uid, data) {
    const { workRef, work } = await loadManagedWork(uid, data.workId);
    if (work.type !== 'video') fail('failed-precondition', 'الحلقات للأعمال المرئية بس');
    const episode = cleanEpisode(data);
    const episodes = work.episodes || [];
    if (episodes.length >= MAX_EPISODES) fail('resource-exhausted', 'وصلت الحد الأقصى للحلقات');
    const batch = db.batch();
    batch.update(workRef, { episodes: [...episodes, episode], updatedAt: ts() });
    writeNews(batch, workRef, `نزلت حلقة جديدة: ${episode.title}`);
    await batch.commit();
    return { count: episodes.length + 1 };
  }

  async function updateWorkInfo(uid, data) {
    const { workRef } = await loadManagedWork(uid, data.workId);
    const fields = workFields(data, { partial: true });
    if (Object.keys(fields).length === 0) fail('invalid-argument', 'ما في إشي ينعدّل');
    await workRef.update(fields);
    return { ok: true };
  }

  async function setWorkStatus(uid, data) {
    const { workRef } = await loadManagedWork(uid, data.workId);
    if (data.status !== 'published' && data.status !== 'hidden') {
      fail('invalid-argument', 'الحالة لازم تكون منشور أو مخفي');
    }
    await workRef.update({ status: data.status });
    return { status: data.status };
  }

  // ---------- الإشراف ----------
  async function adminRemoveWork(uid, data) {
    const adminSnap = await db.doc(`admins/${uid}`).get();
    if (!adminSnap.exists) fail('permission-denied', 'هاي العملية لمشرفي المنصة بس');
    const workId = cleanId(data.workId, 'رقم العمل');
    const workRef = db.doc(`works/${workId}`);
    const workSnap = await workRef.get();
    if (!workSnap.exists) fail('not-found', 'العمل مش موجود');
    const work = workSnap.data();
    await workRef.update({ status: 'removed', removedBy: uid, removedAt: ts() });
    await deleteBuildFiles(work.buildId);
    return { ok: true };
  }

  // ---------- تشغيل ملفات الأعمال ----------
  async function resolveGameFile(rawPath) {
    let path;
    try {
      path = decodeURIComponent(rawPath);
    } catch (e) {
      return { status: 400 };
    }
    const m = BUILD_RE.exec(path);
    if (!m) return { status: 404 };
    if (m[2] === undefined) return { status: 301, location: `/g/${m[1]}/` };
    let rel = m[2];
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    if (rel.split('/').some((s) => s === '' || s === '.' || s === '..')) return { status: 404 };
    const file = getBucket().file(`games/${m[1]}/${rel}`);
    try {
      const [meta] = await file.getMetadata();
      return { status: 200, file, meta };
    } catch (e) {
      if (e && e.code !== 404) log.error('فشل قراءة ملف', path, e);
      return { status: 404 };
    }
  }

  return {
    api: {
      createProfile,
      updateProfile,
      renameStudio,
      publishWork,
      updateWorkBuild,
      addEpisode,
      updateWorkInfo,
      setWorkStatus,
      adminRemoveWork
    },
    resolveGameFile,
    ingestUpload,
    deleteBuildFiles,
    writeNewWork,
    writeNews,
    workFields,
    cleanEpisode,
    MAX_EPISODES
  };
}

module.exports = { makeWorks, WORK_TYPES };
