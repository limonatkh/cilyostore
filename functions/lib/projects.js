'use strict';
// المشروع: المشاركون، وميثاق المشروع (الأدوار والأوزان وقاعدة القرار)،
// والاتفاقات بين الأدوار، والموافقات، والنسخ التجريبية، والنشر.
//
// ثلاث مستويات لا تختلط:
//   - عقد الاستوديو (studios.js): مين الأعضاء ونسبة الاستوديو.
//   - ميثاق المشروع (هون): حصص هاد المشروع بالذات، حسب الأدوار.
//   - المهام: كل دور إله صاحب مسؤول عنه. المسؤولية مش ملكية؛ الحصة بتنكسب بالتسليم المعتمد.
const { fail, requiredText, optionalText, cleanId, cleanRepoUrl, cleanLink, uniq } = require('./ctx');

const PROJECT_KINDS = ['game', 'app', 'video'];
const ROLE_KINDS = ['production', 'service'];
const RULES = ['unanimous', 'lead'];
const MAX_PARTICIPANTS = 20;
const MAX_ROLES = 30;
const MAX_TRIALS = 50;
const MAX_AGREEMENTS = 200;
const AGREEMENT_STATUS = { proposed: 'مقترح', agreed: 'متفق عليه', implemented: 'منفّذ', approved: 'معتمد', rejected: 'مرفوض' };

const round2 = (n) => Math.round(n * 100) / 100;

function charterOk(p) {
  return p.participants.length === 1 || p.participants.every((u) => p.charterSignatures[u]);
}

function intBetween(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail('invalid-argument', `${label} لازم يكون رقم صحيح بين ${min} و${max}`);
  return n;
}

function makeProjects(ctx, studios, works) {
  const { db, ts, getProfile, userByName } = ctx;

  const projectRef = (id) => db.doc(`projects/${id}`);

  function addLog(writer, pRef, who, text) {
    writer.set(pRef.collection('log').doc(), { who, text, at: ts() });
  }

  function systemMessage(writer, pRef, text) {
    writer.set(pRef.collection('channels').doc('general').collection('messages').doc(), {
      uid: null,
      author: 'Cilyo',
      system: true,
      text,
      createdAt: ts()
    });
  }

  async function load(tx, rawId) {
    const id = cleanId(rawId, 'رقم المشروع');
    const pRef = projectRef(id);
    const snap = await tx.get(pRef);
    if (!snap.exists) fail('not-found', 'المشروع مش موجود');
    return { id, pRef, p: snap.data() };
  }

  function requireParticipant(p, uid) {
    if (!p.participants.includes(uid)) fail('permission-denied', 'إنت مش مشارك بهاد المشروع');
  }

  function requireLead(p, uid) {
    if (p.leadUid !== uid) fail('permission-denied', 'هاي العملية لقائد المشروع بس');
  }

  function requireCharter(p) {
    if (!charterOk(p)) fail('failed-precondition', 'الميثاق لسا مش موقّع من كل المشاركين. وقّعوه أول من صفحة «الميثاق».');
  }

  async function readRoles(tx, pRef, p) {
    const snaps = await Promise.all(p.roleIds.map((rid) => tx.get(pRef.collection('roles').doc(rid))));
    return snaps.filter((s) => s.exists).map((s) => ({ id: s.id, ref: s.ref, ...s.data() }));
  }

  // لو العمل منشور، فريقه بالمتجر لازم يطابق مشاركي المشروع
  function syncWorkTeam(tx, p, participants) {
    if (p.workId) tx.update(db.doc(`works/${p.workId}`), { teamUids: participants });
  }

  // ---------- إنشاء المشروع والمشاركون ----------
  async function createProject(uid, data) {
    const profile = await getProfile(uid);
    const { studioId, studio, sharePct } = await studios.activeStudioFor(uid, data.studioId);
    const name = requiredText(data.name, 80, 'اسم المشروع');
    if (!PROJECT_KINDS.includes(data.kind)) fail('invalid-argument', 'نوع المشروع لازم يكون لعبة أو برنامج أو عمل مرئي');
    const repoUrl = cleanRepoUrl(data.repoUrl);
    const count = await db.collection('projects').where('studioId', '==', studioId).count().get();
    if (count.data().count >= 50) fail('resource-exhausted', 'وصل الاستوديو للحد الأقصى من المشاريع');
    // بالاستوديو المشترك: كل الأعضاء بيدخلوا المشروع، إلا إذا انطلب غير هيك
    const participants = data.includeMembers === false ? [uid] : uniq([uid, ...studio.members]).slice(0, MAX_PARTICIPANTS);
    const names = {};
    await Promise.all(
      participants.map(async (u) => {
        names[u] = u === uid ? profile.username : (await getProfile(u)).username;
      })
    );
    const pRef = db.collection('projects').doc();
    const batch = db.batch();
    batch.set(pRef, {
      studioId,
      studioName: studio.name,
      studioKind: studio.kind,
      studioSharePct: sharePct,
      name,
      kind: data.kind,
      repoUrl,
      leadUid: uid,
      participants,
      invites: [],
      names,
      decisionRule: 'unanimous',
      charterVersion: 0,
      charterSignatures: {},
      roleIds: [],
      earned: {},
      orphanPoints: 0,
      workId: null,
      openPublishId: null,
      createdAt: ts()
    });
    addLog(batch, pRef, profile.username, `أنشأ المشروع «${name}»`);
    systemMessage(batch, pRef, `انفتح مشروع «${name}». القائد: ${profile.username}.`);
    await batch.commit();
    return { projectId: pRef.id };
  }

  async function updateProject(uid, data) {
    const profile = await getProfile(uid);
    await db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      requireLead(p, uid);
      const update = {};
      if (data.name !== undefined) update.name = requiredText(data.name, 80, 'اسم المشروع');
      if (data.repoUrl !== undefined) update.repoUrl = cleanRepoUrl(data.repoUrl);
      if (!Object.keys(update).length) fail('invalid-argument', 'ما في إشي ينعدّل');
      tx.update(pRef, update);
      addLog(tx, pRef, profile.username, 'عدّل بيانات المشروع');
    });
    return { ok: true };
  }

  async function inviteToProject(uid, data) {
    const profile = await getProfile(uid);
    const target = await userByName(data.username);
    await db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      requireLead(p, uid);
      if (p.participants.includes(target.uid)) fail('already-exists', 'هاد المستخدم مشارك أصلًا');
      if (p.invites.includes(target.uid)) fail('already-exists', 'هاد المستخدم معزوم أصلًا');
      if (p.participants.length + p.invites.length >= MAX_PARTICIPANTS) fail('resource-exhausted', 'وصل المشروع للحد الأقصى من المشاركين');
      tx.update(pRef, { invites: [...p.invites, target.uid], names: { ...p.names, [target.uid]: target.username } });
      addLog(tx, pRef, profile.username, `عزم ${target.username} على المشروع`);
    });
    return { ok: true };
  }

  async function respondProjectInvite(uid, data) {
    const profile = await getProfile(uid);
    return db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      if (!p.invites.includes(uid)) fail('not-found', 'ما في دعوة إلك لهاد المشروع');
      const invites = p.invites.filter((x) => x !== uid);
      if (!data.accept) {
        tx.update(pRef, { invites });
        addLog(tx, pRef, profile.username, 'رفض الدعوة');
        return { status: 'declined' };
      }
      const participants = [...p.participants, uid];
      tx.update(pRef, { invites, participants });
      syncWorkTeam(tx, p, participants);
      addLog(tx, pRef, profile.username, 'انضم للمشروع. لازم يوقّع الميثاق.');
      systemMessage(tx, pRef, `${profile.username} انضم للمشروع.`);
      return { status: 'joined' };
    });
  }

  async function transferLead(uid, data) {
    const profile = await getProfile(uid);
    await db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      requireLead(p, uid);
      if (!p.participants.includes(data.toUid) || data.toUid === uid) fail('invalid-argument', 'القائد الجديد لازم يكون مشارك ثاني بالمشروع');
      tx.update(pRef, { leadUid: data.toUid });
      addLog(tx, pRef, profile.username, `نقل قيادة المشروع إلى ${p.names[data.toUid]}`);
      systemMessage(tx, pRef, `قائد المشروع صار ${p.names[data.toUid]}.`);
    });
    return { ok: true };
  }

  // بيشيل مشارك: بيفضّي أدواره، وحصصه المكتسبة بتضل إله.
  function removeParticipantWrites(tx, pRef, p, roles, targetUid) {
    const participants = p.participants.filter((u) => u !== targetUid);
    const charterSignatures = { ...p.charterSignatures };
    delete charterSignatures[targetUid];
    tx.update(pRef, { participants, charterSignatures });
    roles.filter((r) => r.holderUid === targetUid).forEach((r) => tx.update(r.ref, { holderUid: null }));
    syncWorkTeam(tx, p, participants);
  }

  async function leaveProject(uid, data) {
    const profile = await getProfile(uid);
    await db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      requireParticipant(p, uid);
      if (p.participants.length === 1) fail('failed-precondition', 'إنت المشارك الوحيد بالمشروع');
      if (p.leadUid === uid) fail('failed-precondition', 'انقل قيادة المشروع لمشارك ثاني قبل ما تطلع');
      const roles = await readRoles(tx, pRef, p);
      removeParticipantWrites(tx, pRef, p, roles, uid);
      addLog(tx, pRef, profile.username, 'طلع من المشروع. أدواره فضيت، وحصصه المكتسبة بتضل إله.');
      systemMessage(tx, pRef, `${profile.username} طلع من المشروع.`);
    });
    return { ok: true };
  }

  // ---------- الميثاق والأدوار ----------
  // القائد بيحفظ جدول الأدوار وقاعدة القرار. أي تعديل بيرجّع التواقيع من الأول.
  async function saveCharter(uid, data) {
    const profile = await getProfile(uid);
    if (!RULES.includes(data.decisionRule)) fail('invalid-argument', 'قاعدة القرار غير معروفة');
    const input = Array.isArray(data.roles) ? data.roles : [];
    if (input.length > MAX_ROLES) fail('invalid-argument', `الحد الأقصى ${MAX_ROLES} دور`);
    await db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      requireLead(p, uid);
      const existing = await readRoles(tx, pRef, p);
      const byId = new Map(existing.map((r) => [r.id, r]));
      const roleIds = [];
      const writes = [];
      input.forEach((raw, order) => {
        const name = requiredText(raw.name, 60, 'اسم الدور');
        if (!ROLE_KINDS.includes(raw.kind)) fail('invalid-argument', `نوع الدور «${name}» لازم يكون إنتاج أو خدمة`);
        const holderUid = raw.holderUid || null;
        if (holderUid && !p.participants.includes(holderUid)) fail('invalid-argument', `صاحب الدور «${name}» لازم يكون مشارك بالمشروع`);
        const weight = intBetween(raw.weight, 1, 1000, `وزن الدور «${name}»`);
        const periods = raw.kind === 'service' ? intBetween(raw.periods, 1, 60, `عدد فترات الدور «${name}»`) : 1;
        const note = optionalText(raw.note, 300, 'وصف الدور');
        const old = raw.id ? byId.get(raw.id) : null;
        if (raw.id && !old) fail('invalid-argument', `الدور «${name}» مش موجود`);
        const fields = { name, kind: raw.kind, holderUid, weight, periods, note, order };
        if (old) {
          if (weight < old.earnedPoints) fail('invalid-argument', `وزن الدور «${name}» ما بينزل تحت اللي انكسب منه (${old.earnedPoints})`);
          if (periods < old.periodsEarned) fail('invalid-argument', `فترات الدور «${name}» ما بتنزل تحت اللي انعتمد منها (${old.periodsEarned})`);
          if (old.periodsEarned >= periods && weight !== old.earnedPoints) fail('invalid-argument', `الدور «${name}» خلصت فتراته، فوزنه لازم يضل ${old.earnedPoints}`);
          byId.delete(old.id);
          roleIds.push(old.id);
          writes.push(() => tx.update(old.ref, fields));
        } else {
          const ref = pRef.collection('roles').doc();
          roleIds.push(ref.id);
          writes.push(() => tx.set(ref, { ...fields, periodsEarned: 0, earnedPoints: 0, openEarnId: null }));
        }
      });
      // الأدوار المحذوفة: اللي انكسب منها بيضل محسوب بمجموع النقاط
      let orphanPoints = p.orphanPoints;
      byId.forEach((r) => {
        orphanPoints = round2(orphanPoints + r.earnedPoints);
        writes.push(() => tx.delete(r.ref));
      });
      writes.forEach((w) => w());
      tx.update(pRef, {
        roleIds,
        orphanPoints,
        decisionRule: data.decisionRule,
        charterVersion: p.charterVersion + 1,
        charterSignatures: { [uid]: true }
      });
      addLog(tx, pRef, profile.username, `عدّل الميثاق (نسخة ${p.charterVersion + 1}). لازم كل المشاركين يوقّعوه من جديد.`);
      if (p.participants.length > 1) systemMessage(tx, pRef, `تعدّل ميثاق المشروع (نسخة ${p.charterVersion + 1}). راجعوه ووقّعوه.`);
    });
    return { ok: true };
  }

  async function signCharter(uid, data) {
    const profile = await getProfile(uid);
    return db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      requireParticipant(p, uid);
      if (p.charterVersion === 0) fail('failed-precondition', 'القائد لسا ما كتب الميثاق');
      const charterSignatures = { ...p.charterSignatures, [uid]: true };
      tx.update(pRef, { charterSignatures });
      addLog(tx, pRef, profile.username, `وقّع الميثاق (نسخة ${p.charterVersion})`);
      const done = p.participants.every((u) => charterSignatures[u]);
      if (done) systemMessage(tx, pRef, 'كل المشاركين وقّعوا الميثاق. المشروع جاهز للشغل.');
      return { active: done };
    });
  }

  // ---------- الموافقات ----------
  function newApproval(tx, pRef, { kind, refId, summary, detail, payload, required, uid, username }) {
    const ref = pRef.collection('approvals').doc();
    tx.set(ref, {
      kind,
      refId: refId || null,
      summary,
      detail: detail || '',
      payload: payload || {},
      required,
      decisions: {},
      status: 'open',
      createdBy: uid,
      createdByName: username,
      createdAt: ts(),
      closedAt: null,
      forcedBy: null
    });
    return ref;
  }

  // بيطبّق نتيجة الموافقة. كل القراءات بتصير قبل أي كتابة.
  async function closeApproval(tx, pRef, p, aRef, a, approved) {
    const pay = a.payload;
    if (a.kind === 'agreement') {
      const gRef = pRef.collection('agreements').doc(a.refId);
      const g = await tx.get(gRef);
      return () => {
        if (!g.exists || g.data().openApprovalId !== aRef.id) return;
        const status = approved ? 'agreed' : 'rejected';
        tx.update(gRef, { status, openApprovalId: null, updatedAt: ts() });
        addLog(tx, pRef, 'Cilyo', `الاتفاق «${g.data().title}» صار ${AGREEMENT_STATUS[status]}`);
      };
    }
    if (a.kind === 'earn' || a.kind === 'vacate') {
      const rRef = pRef.collection('roles').doc(a.refId);
      const r = await tx.get(rRef);
      return () => {
        if (!r.exists) return;
        const role = r.data();
        const stillHolder = role.holderUid === pay.subjectUid;
        if (a.kind === 'vacate') {
          if (approved && stillHolder) {
            tx.update(rRef, { holderUid: null });
            addLog(tx, pRef, 'Cilyo', `الدور «${role.name}» انسحب من ${p.names[pay.subjectUid]} وصار فاضي. اللي انكسب منه بيضل إله.`);
          }
          return;
        }
        const left = role.periods - role.periodsEarned;
        if (!approved || !stillHolder || left <= 0) {
          tx.update(rRef, { openEarnId: null });
          return;
        }
        // آخر فترة بتاخد الباقي بالضبط، عشان المجموع يطابق وزن الدور
        const points = left === 1 ? round2(role.weight - role.earnedPoints) : round2((role.weight - role.earnedPoints) / left);
        tx.update(rRef, {
          periodsEarned: role.periodsEarned + 1,
          earnedPoints: round2(role.earnedPoints + points),
          openEarnId: null
        });
        const earned = { ...p.earned, [pay.subjectUid]: round2((p.earned[pay.subjectUid] || 0) + points) };
        tx.update(pRef, { earned });
        tx.set(pRef.collection('earnings').doc(), {
          uid: pay.subjectUid,
          username: p.names[pay.subjectUid],
          roleId: a.refId,
          roleName: role.name,
          points,
          note: pay.note || '',
          at: ts()
        });
        addLog(tx, pRef, 'Cilyo', `${p.names[pay.subjectUid]} كسب ${points} نقطة من دور «${role.name}»`);
      };
    }
    if (a.kind === 'remove') {
      const roles = await readRoles(tx, pRef, p);
      return () => {
        if (!approved || !p.participants.includes(pay.subjectUid) || p.leadUid === pay.subjectUid) return;
        removeParticipantWrites(tx, pRef, p, roles, pay.subjectUid);
        addLog(tx, pRef, 'Cilyo', `${p.names[pay.subjectUid]} انشال من المشروع. أدواره فضيت، وحصصه المكتسبة بتضل إله.`);
        systemMessage(tx, pRef, `${p.names[pay.subjectUid]} انشال من المشروع بموافقة المشاركين.`);
      };
    }
    if (a.kind === 'publish') {
      if (!approved) {
        return () => {
          tx.update(pRef, { openPublishId: null });
          addLog(tx, pRef, 'Cilyo', `طلب النشر انرفض: ${a.summary}`);
        };
      }
      const roles = await readRoles(tx, pRef, p);
      const workRef = p.workId ? db.doc(`works/${p.workId}`) : null;
      const workSnap = workRef ? await tx.get(workRef) : null;
      if (workSnap && (!workSnap.exists || workSnap.data().status === 'removed')) {
        fail('failed-precondition', 'العمل انشال من المنصة، وما بينفع ننشر عليه');
      }
      return () => {
        const credits = roles
          .filter((r) => r.holderUid)
          .sort((x, y) => x.order - y.order)
          .map((r) => ({ username: p.names[r.holderUid], role: r.name }));
        const fields = { title: pay.title, description: pay.description, controls: pay.controls };
        const build = pay.buildId ? { id: pay.buildId, entry: pay.entry } : null;
        if (!workSnap) {
          const ref = works.writeNewWork(tx, {
            uid: a.createdBy,
            type: p.kind,
            fields,
            studioId: p.studioId,
            studioName: p.studioName,
            teamUids: p.participants,
            build,
            episodes: pay.episode ? [pay.episode] : [],
            projectId: pRef.id,
            credits
          });
          tx.update(pRef, { workId: ref.id, openPublishId: null });
          addLog(tx, pRef, 'Cilyo', `انتشر «${pay.title}» بالمتجر، وانعمل سيرفره العام`);
          systemMessage(tx, pRef, `انتشر «${pay.title}» بالمتجر.`);
          return;
        }
        const update = { ...fields, credits, teamUids: p.participants, updatedAt: ts() };
        if (build) {
          update.buildId = build.id;
          update.entry = build.entry;
        }
        if (pay.episode) update.episodes = [...(workSnap.data().episodes || []), pay.episode];
        tx.update(workRef, update);
        works.writeNews(tx, workRef, pay.episode ? `نزلت حلقة جديدة: ${pay.episode.title}` : 'نزلت نسخة جديدة.');
        tx.update(pRef, { openPublishId: null });
        addLog(tx, pRef, 'Cilyo', `نزل تحديث «${pay.title}» بالمتجر`);
      };
    }
    return () => {};
  }

  // decision: 'yes' أو 'no'. force: القائد بيحسم (بس لما قاعدة القرار «القائد بيحسم»).
  async function decideApproval(uid, data, opts = {}) {
    const profile = await getProfile(uid);
    const who = profile.username + (opts.viaAI ? ' (المساعد)' : '');
    if (data.decision !== 'yes' && data.decision !== 'no') fail('invalid-argument', 'القرار لازم يكون موافق أو رافض');
    const approvalId = cleanId(data.approvalId, 'رقم الطلب');
    return db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      requireParticipant(p, uid);
      const aRef = pRef.collection('approvals').doc(approvalId);
      const aSnap = await tx.get(aRef);
      if (!aSnap.exists) fail('not-found', 'طلب الموافقة مش موجود');
      const a = aSnap.data();
      if (a.status !== 'open') fail('failed-precondition', 'هاد الطلب انحسم أو انلغى');
      const decisions = { ...a.decisions };
      let outcome = null;
      let forcedBy = null;
      if (data.force) {
        if (p.decisionRule !== 'lead' || p.leadUid !== uid) fail('permission-denied', 'الحسم لقائد المشروع، ولما الميثاق بيعطيه هالحق بس');
        if (a.payload.subjectUid === uid) fail('permission-denied', 'ما بتقدر تحسم طلب بيخصك إنت');
        outcome = data.decision === 'yes';
        forcedBy = uid;
      } else {
        if (!a.required.includes(uid)) fail('permission-denied', 'هاد الطلب مش بدّه موافقتك');
        if (decisions[uid]) fail('failed-precondition', 'سجّلت قرارك على هاد الطلب أصلًا');
        decisions[uid] = data.decision;
        // اللي طلع من المشروع ما بنستنى قراره
        const needed = a.required.filter((u) => p.participants.includes(u));
        if (data.decision === 'no') outcome = false;
        else if (needed.every((u) => decisions[u] === 'yes')) outcome = true;
      }
      const effect = outcome === null ? null : await closeApproval(tx, pRef, p, aRef, a, outcome);
      const status = outcome === null ? 'open' : outcome ? 'approved' : 'rejected';
      tx.update(aRef, { decisions, status, forcedBy, closedAt: outcome === null ? null : ts() });
      const verb = data.force ? (data.decision === 'yes' ? 'حسم بالموافقة' : 'حسم بالرفض') : data.decision === 'yes' ? 'وافق على' : 'رفض';
      addLog(tx, pRef, who, `${verb}: ${a.summary}`);
      if (effect) effect();
      return { status };
    });
  }

  // ---------- تسليم الأدوار وسحبها ----------
  async function requestEarning(uid, data) {
    const profile = await getProfile(uid);
    const roleId = cleanId(data.roleId, 'رقم الدور');
    const note = optionalText(data.note, 500, 'الملاحظة');
    await db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      requireParticipant(p, uid);
      requireCharter(p);
      const rRef = pRef.collection('roles').doc(roleId);
      const rSnap = await tx.get(rRef);
      if (!rSnap.exists) fail('not-found', 'الدور مش موجود');
      const role = rSnap.data();
      if (role.holderUid !== uid) fail('permission-denied', 'بس صاحب الدور بيطلب اعتماد تسليمه');
      if (role.periodsEarned >= role.periods) fail('failed-precondition', 'هاد الدور انكسب كله');
      if (role.openEarnId) fail('failed-precondition', 'في طلب اعتماد مفتوح لهاد الدور');
      const required = p.participants.filter((u) => u !== uid);
      if (!required.length) fail('failed-precondition', 'ما في مشاركين غيرك عشان يعتمدوا التسليم');
      const label = role.kind === 'service' ? `اعتماد فترة ${role.periodsEarned + 1} من ${role.periods} لدور «${role.name}»` : `اعتماد تسليم دور «${role.name}»`;
      const aRef = newApproval(tx, pRef, {
        kind: 'earn',
        refId: roleId,
        summary: `${label} (${profile.username})`,
        detail: note,
        payload: { subjectUid: uid, note },
        required,
        uid,
        username: profile.username
      });
      tx.update(rRef, { openEarnId: aRef.id });
      addLog(tx, pRef, profile.username, `طلب ${label}`);
    });
    return { ok: true };
  }

  // سحب دور من صاحبه (غاب أو ما التزم)، أو شيل مشارك من المشروع.
  async function requestRemoval(uid, data) {
    const profile = await getProfile(uid);
    const reason = requiredText(data.reason, 500, 'السبب');
    const roleId = data.roleId ? cleanId(data.roleId, 'رقم الدور') : null;
    let created = null;
    const result = await db.runTransaction(async (tx) => {
      created = null;
      const { pRef, p } = await load(tx, data.projectId);
      requireParticipant(p, uid);
      let subjectUid = data.targetUid;
      let role = null;
      let rRef = null;
      if (roleId) {
        rRef = pRef.collection('roles').doc(roleId);
        const rSnap = await tx.get(rRef);
        if (!rSnap.exists) fail('not-found', 'الدور مش موجود');
        role = rSnap.data();
        subjectUid = role.holderUid;
        if (!subjectUid) fail('failed-precondition', 'هاد الدور فاضي أصلًا');
      }
      if (!p.participants.includes(subjectUid)) fail('invalid-argument', 'المستخدم مش مشارك بالمشروع');
      if (roleId && subjectUid === uid) {
        // صاحب الدور بيتنازل عنه بنفسه: ما بدها موافقة
        tx.update(rRef, { holderUid: null });
        addLog(tx, pRef, profile.username, `تنازل عن دور «${role.name}». اللي كسبه منه بيضل إله.`);
        return { status: 'released' };
      }
      if (!roleId) {
        if (subjectUid === uid) fail('invalid-argument', 'عشان تطلع من المشروع استخدم «اطلع من المشروع»');
        if (subjectUid === p.leadUid) fail('failed-precondition', 'القائد ما بينشال. لازم ينقل القيادة أول.');
      }
      const required = p.participants.filter((u) => u !== subjectUid);
      const summary = roleId ? `سحب دور «${role.name}» من ${p.names[subjectUid]}` : `شيل ${p.names[subjectUid]} من المشروع`;
      const aRef = newApproval(tx, pRef, {
        kind: roleId ? 'vacate' : 'remove',
        refId: roleId,
        summary,
        detail: reason,
        payload: { subjectUid },
        required,
        uid,
        username: profile.username
      });
      addLog(tx, pRef, profile.username, `طلب ${summary}`);
      created = aRef.id;
      return { status: 'requested' };
    });
    // صاحب الطلب موافق تلقائيًا
    if (created) await decideApproval(uid, { projectId: data.projectId, approvalId: created, decision: 'yes' });
    return result;
  }

  // ---------- الاتفاقات بين الأدوار ----------
  function agreementApprovers(p, from, to, actorUid) {
    const set = new Set();
    [from, to].forEach((r) => {
      if (r.holderUid) set.add(r.holderUid);
      else p.participants.forEach((u) => set.add(u));
    });
    set.delete(actorUid);
    return Array.from(set).filter((u) => p.participants.includes(u));
  }

  async function proposeAgreement(uid, data, opts = {}) {
    const profile = await getProfile(uid);
    const who = profile.username + (opts.viaAI ? ' (المساعد)' : '');
    const title = requiredText(data.title, 120, 'عنوان الاتفاق');
    const description = optionalText(data.description, 2000, 'التفاصيل');
    const fromRoleId = cleanId(data.fromRoleId, 'الدور اللي بيقدّم');
    const toRoleId = cleanId(data.toRoleId, 'الدور اللي بيعتمد');
    const count = await projectRef(cleanId(data.projectId, 'رقم المشروع')).collection('agreements').count().get();
    if (count.data().count >= MAX_AGREEMENTS) fail('resource-exhausted', 'وصل المشروع للحد الأقصى من الاتفاقات');
    return db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      requireParticipant(p, uid);
      requireCharter(p);
      const [fromSnap, toSnap] = await Promise.all([tx.get(pRef.collection('roles').doc(fromRoleId)), tx.get(pRef.collection('roles').doc(toRoleId))]);
      if (!fromSnap.exists || !toSnap.exists) fail('invalid-argument', 'لازم تحدد الدور اللي بيقدّم الاتفاق والدور اللي بيعتمد عليه');
      const from = fromSnap.data();
      const to = toSnap.data();
      const gRef = pRef.collection('agreements').doc();
      const required = agreementApprovers(p, from, to, uid);
      let status = 'agreed';
      let openApprovalId = null;
      if (required.length) {
        status = 'proposed';
        openApprovalId = newApproval(tx, pRef, {
          kind: 'agreement',
          refId: gRef.id,
          summary: `اتفاق جديد: «${title}»`,
          detail: `${from.name} ← ${to.name}${description ? '. ' + description : ''}`,
          required,
          uid,
          username: who
        }).id;
      }
      tx.set(gRef, {
        title,
        description,
        fromRoleId,
        toRoleId,
        fromRoleName: from.name,
        toRoleName: to.name,
        status,
        openApprovalId,
        createdBy: uid,
        createdByName: who,
        createdAt: ts(),
        updatedAt: ts()
      });
      addLog(tx, pRef, who, `اقترح اتفاق «${title}» (${from.name} ← ${to.name})`);
      return { agreementId: gRef.id, status };
    });
  }

  async function editAgreement(uid, data, opts = {}) {
    const profile = await getProfile(uid);
    const who = profile.username + (opts.viaAI ? ' (المساعد)' : '');
    const agreementId = cleanId(data.agreementId, 'رقم الاتفاق');
    return db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      requireParticipant(p, uid);
      requireCharter(p);
      const gRef = pRef.collection('agreements').doc(agreementId);
      const gSnap = await tx.get(gRef);
      if (!gSnap.exists) fail('not-found', 'الاتفاق مش موجود');
      const g = gSnap.data();
      const [fromSnap, toSnap] = await Promise.all([tx.get(pRef.collection('roles').doc(g.fromRoleId)), tx.get(pRef.collection('roles').doc(g.toRoleId))]);
      const from = fromSnap.exists ? fromSnap.data() : { name: g.fromRoleName, holderUid: null };
      const to = toSnap.exists ? toSnap.data() : { name: g.toRoleName, holderUid: null };
      const title = data.title === undefined ? g.title : requiredText(data.title, 120, 'عنوان الاتفاق');
      const description = data.description === undefined ? g.description : optionalText(data.description, 2000, 'التفاصيل');
      if (g.openApprovalId) tx.update(pRef.collection('approvals').doc(g.openApprovalId), { status: 'cancelled', closedAt: ts() });
      const required = agreementApprovers(p, from, to, uid);
      let status = 'agreed';
      let openApprovalId = null;
      if (required.length) {
        status = 'proposed';
        openApprovalId = newApproval(tx, pRef, {
          kind: 'agreement',
          refId: agreementId,
          summary: `تعديل اتفاق: «${title}»`,
          detail: `كان «${g.title}». ${from.name} ← ${to.name}${description ? '. ' + description : ''}`,
          required,
          uid,
          username: who
        }).id;
      }
      tx.update(gRef, { title, description, status, openApprovalId, updatedAt: ts() });
      addLog(tx, pRef, who, `عدّل الاتفاق «${g.title}»${g.title !== title ? ' إلى «' + title + '»' : ''}. رجع للموافقة.`);
      return { status };
    });
  }

  async function setAgreementStatus(uid, data, opts = {}) {
    const profile = await getProfile(uid);
    const who = profile.username + (opts.viaAI ? ' (المساعد)' : '');
    const agreementId = cleanId(data.agreementId, 'رقم الاتفاق');
    if (data.status !== 'implemented' && data.status !== 'approved') fail('invalid-argument', 'الحالة لازم تكون منفّذ أو معتمد');
    return db.runTransaction(async (tx) => {
      const { pRef, p } = await load(tx, data.projectId);
      requireParticipant(p, uid);
      const gRef = pRef.collection('agreements').doc(agreementId);
      const gSnap = await tx.get(gRef);
      if (!gSnap.exists) fail('not-found', 'الاتفاق مش موجود');
      const g = gSnap.data();
      const implementing = data.status === 'implemented';
      if (implementing && g.status !== 'agreed') fail('failed-precondition', 'الاتفاق لازم يكون «متفق عليه» قبل ما ينعلّم «منفّذ»');
      if (!implementing && g.status !== 'implemented') fail('failed-precondition', 'الاتفاق لازم يكون «منفّذ» قبل ما ينعتمد');
      const roleId = implementing ? g.fromRoleId : g.toRoleId;
      const rSnap = await tx.get(pRef.collection('roles').doc(roleId));
      const holder = rSnap.exists ? rSnap.data().holderUid : null;
      if (holder && holder !== uid) {
        fail(
          'permission-denied',
          implementing
            ? `بس صاحب دور «${g.fromRoleName}» (${p.names[holder]}) بيعلّمه منفّذ`
            : `بس صاحب دور «${g.toRoleName}» (${p.names[holder]}) بيعتمده، لأنه هو اللي بيعتمد عليه`
        );
      }
      tx.update(gRef, { status: data.status, updatedAt: ts() });
      addLog(tx, pRef, who, `علّم الاتفاق «${g.title}» ${AGREEMENT_STATUS[data.status]}`);
      return { status: data.status };
    });
  }

  // ---------- النسخ التجريبية ----------
  async function checkTrialRoom(uid, rawProjectId) {
    const id = cleanId(rawProjectId, 'رقم المشروع');
    const snap = await projectRef(id).get();
    if (!snap.exists) fail('not-found', 'المشروع مش موجود');
    const p = snap.data();
    requireParticipant(p, uid);
    const count = await projectRef(id).collection('trials').count().get();
    if (count.data().count >= MAX_TRIALS) fail('resource-exhausted', 'وصل المشروع للحد الأقصى من النسخ التجريبية. احذفوا نسخ قديمة.');
    return { id, p };
  }

  async function addTrial(uid, data) {
    const profile = await getProfile(uid);
    const note = optionalText(data.note, 300, 'الملاحظة');
    const { id, p } = await checkTrialRoom(uid, data.projectId);
    if (p.kind === 'video') fail('failed-precondition', 'للعمل المرئي شاركوا رابط معاينة بدل ملف');
    const build = await works.ingestUpload(uid, data.uploadId);
    const pRef = projectRef(id);
    const batch = db.batch();
    const tRef = pRef.collection('trials').doc();
    batch.set(tRef, { by: uid, byName: profile.username, buildId: build.id, entry: build.entry, url: null, note, at: ts() });
    addLog(batch, pRef, profile.username, `رفع نسخة تجريبية${note ? ': ' + note : ''}`);
    systemMessage(batch, pRef, `${profile.username} رفع نسخة تجريبية جديدة${note ? ': ' + note : ''}.`);
    try {
      await batch.commit();
    } catch (e) {
      await works.deleteBuildFiles(build.id);
      throw e;
    }
    return { trialId: tRef.id };
  }

  async function addTrialLink(uid, data, opts = {}) {
    const profile = await getProfile(uid);
    const who = profile.username + (opts.viaAI ? ' (المساعد)' : '');
    const url = cleanLink(data.url, 'الرابط');
    const note = optionalText(data.note, 300, 'الملاحظة');
    const { id } = await checkTrialRoom(uid, data.projectId);
    const pRef = projectRef(id);
    const batch = db.batch();
    const tRef = pRef.collection('trials').doc();
    batch.set(tRef, { by: uid, byName: who, buildId: null, entry: null, url, note, at: ts() });
    addLog(batch, pRef, who, `شارك رابط تجربة${note ? ': ' + note : ''}`);
    await batch.commit();
    return { trialId: tRef.id };
  }

  async function deleteTrial(uid, data) {
    const profile = await getProfile(uid);
    const trialId = cleanId(data.trialId, 'رقم النسخة');
    let buildId = null;
    await db.runTransaction(async (tx) => {
      buildId = null;
      const { pRef, p } = await load(tx, data.projectId);
      requireParticipant(p, uid);
      const tRef = pRef.collection('trials').doc(trialId);
      const tSnap = await tx.get(tRef);
      if (!tSnap.exists) fail('not-found', 'النسخة مش موجودة');
      const t = tSnap.data();
      if (t.by !== uid && p.leadUid !== uid) fail('permission-denied', 'بس اللي رفع النسخة أو القائد بيحذفها');
      if (t.buildId) {
        if (p.openPublishId) fail('failed-precondition', 'في طلب نشر مفتوح. احسموه قبل حذف النسخ.');
        if (p.workId) {
          const w = await tx.get(db.doc(`works/${p.workId}`));
          if (w.exists && w.data().buildId === t.buildId) fail('failed-precondition', 'هاي النسخة المنشورة بالمتجر، ما بتنحذف');
        }
        buildId = t.buildId;
      }
      tx.delete(tRef);
      addLog(tx, pRef, profile.username, 'حذف نسخة تجريبية');
    });
    await works.deleteBuildFiles(buildId);
    return { ok: true };
  }

  // ---------- النشر ----------
  async function requestPublish(uid, data) {
    const profile = await getProfile(uid);
    let created = null;
    await db.runTransaction(async (tx) => {
      created = null;
      const { pRef, p } = await load(tx, data.projectId);
      requireParticipant(p, uid);
      requireCharter(p);
      if (p.openPublishId) fail('failed-precondition', 'في طلب نشر مفتوح لهاد المشروع. احسموه أول.');
      const workSnap = p.workId ? await tx.get(db.doc(`works/${p.workId}`)) : null;
      const work = workSnap && workSnap.exists ? workSnap.data() : null;
      const payload = {
        title: data.title || !work ? requiredText(data.title, 80, 'اسم العمل') : work.title,
        description: data.description !== undefined || !work ? optionalText(data.description, 2000, 'الوصف') : work.description,
        controls: data.controls !== undefined || !work ? optionalText(data.controls, 500, 'طريقة الاستخدام') : work.controls
      };
      let detail = '';
      if (p.kind === 'video') {
        if (work && (work.episodes || []).length >= works.MAX_EPISODES) fail('resource-exhausted', 'وصل العمل للحد الأقصى من الحلقات');
        payload.episode = works.cleanEpisode(data);
        detail = `الحلقة: ${payload.episode.title}`;
      } else {
        const tSnap = await tx.get(pRef.collection('trials').doc(cleanId(data.trialId, 'رقم النسخة')));
        if (!tSnap.exists) fail('not-found', 'النسخة التجريبية مش موجودة');
        const t = tSnap.data();
        if (!t.buildId) fail('failed-precondition', 'بس النسخ المرفوعة كملف zip بتنتشر. الروابط للتجربة بس.');
        payload.trialId = tSnap.id;
        payload.buildId = t.buildId;
        payload.entry = t.entry;
        detail = t.note ? `النسخة: ${t.note}` : '';
      }
      const summary = work ? `نشر تحديث «${payload.title}» بالمتجر` : `نشر «${payload.title}» بالمتجر`;
      const aRef = newApproval(tx, pRef, {
        kind: 'publish',
        summary,
        detail,
        payload,
        required: p.participants,
        uid,
        username: profile.username
      });
      tx.update(pRef, { openPublishId: aRef.id });
      addLog(tx, pRef, profile.username, `طلب ${summary}`);
      created = aRef.id;
    });
    // صاحب الطلب موافق تلقائيًا. إذا هو المشارك الوحيد، العمل بينتشر فورًا.
    return decideApproval(uid, { projectId: data.projectId, approvalId: created, decision: 'yes' });
  }

  // ---------- للموصل: رسالة من المساعد بمحادثة المشروع ----------
  async function postAssistantMessage(uid, data) {
    const profile = await getProfile(uid);
    const text = requiredText(data.text, 2000, 'الرسالة');
    const id = cleanId(data.projectId, 'رقم المشروع');
    const snap = await projectRef(id).get();
    if (!snap.exists) fail('not-found', 'المشروع مش موجود');
    requireParticipant(snap.data(), uid);
    await projectRef(id).collection('channels').doc('general').collection('messages').doc().set({
      uid,
      author: `${profile.username} (المساعد)`,
      viaAI: true,
      text,
      createdAt: ts()
    });
    return { posted: true };
  }

  return {
    api: {
      createProject,
      updateProject,
      inviteToProject,
      respondProjectInvite,
      transferLead,
      leaveProject,
      saveCharter,
      signCharter,
      decideApproval,
      requestEarning,
      requestRemoval,
      proposeAgreement,
      editAgreement,
      setAgreementStatus,
      addTrial,
      addTrialLink,
      deleteTrial,
      requestPublish
    },
    postAssistantMessage,
    charterOk,
    AGREEMENT_STATUS
  };
}

module.exports = { makeProjects, charterOk };
