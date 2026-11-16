'use strict';
// موصل المساعد: رمز لكل مستخدم، وأدوات بيستخدمها مساعد الـAI تبعه (عن طريق MCP).
// الأدوات بتنادي نفس دوال الموقع، فنفس القواعد بتنطبق على المساعد.
const crypto = require('crypto');
const { fail, cleanId } = require('./ctx');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (t) => (t && typeof t.toDate === 'function' ? t.toDate().toISOString() : null);

function makeConnector(ctx, projects) {
  const { db, ts, getProfile } = ctx;

  async function createConnectorToken(uid) {
    await getProfile(uid);
    const old = await db.collection('connectorTokens').where('uid', '==', uid).get();
    const token = 'cil_' + crypto.randomBytes(24).toString('hex');
    const batch = db.batch();
    old.docs.forEach((d) => batch.delete(d.ref));
    batch.set(db.doc(`connectorTokens/${sha(token)}`), { uid, createdAt: ts() });
    await batch.commit();
    return { token };
  }

  async function uidForToken(token) {
    if (typeof token !== 'string' || !/^cil_[a-f0-9]{48}$/.test(token)) return null;
    const snap = await db.doc(`connectorTokens/${sha(token)}`).get();
    return snap.exists ? snap.data().uid : null;
  }

  async function loadProject(uid, rawId) {
    const id = cleanId(rawId, 'project_id');
    const snap = await db.doc(`projects/${id}`).get();
    if (!snap.exists) fail('not-found', 'المشروع مش موجود');
    const p = snap.data();
    if (!p.participants.includes(uid)) fail('permission-denied', 'إنت مش مشارك بهاد المشروع');
    return { id, pRef: snap.ref, p };
  }

  async function rolesOf(pRef) {
    const snap = await pRef.collection('roles').get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.order - b.order);
  }

  async function resolveRole(pRef, ref) {
    const roles = await rolesOf(pRef);
    const key = String(ref || '').trim();
    const role = roles.find((r) => r.id === key) || roles.find((r) => r.name === key);
    if (!role) fail('invalid-argument', 'الدور مش موجود. الأدوار: ' + roles.map((r) => r.name).join('، '));
    return role.id;
  }

  const tools = {
    async cilyo_list_projects(uid) {
      const profile = await getProfile(uid);
      const snap = await db.collection('projects').where('participants', 'array-contains', uid).get();
      return {
        you: profile.username,
        projects: snap.docs.map((d) => {
          const p = d.data();
          return { id: d.id, name: p.name, kind: p.kind, studio: p.studioName, lead: p.names[p.leadUid], repoUrl: p.repoUrl };
        })
      };
    },

    async cilyo_project_context(uid, a) {
      const profile = await getProfile(uid);
      const { pRef, p } = await loadProject(uid, a.project_id);
      const [roles, agreements, approvals, trials] = await Promise.all([
        rolesOf(pRef),
        pRef.collection('agreements').get(),
        pRef.collection('approvals').where('status', '==', 'open').get(),
        pRef.collection('trials').get()
      ]);
      return {
        you: profile.username,
        project: {
          name: p.name,
          kind: p.kind,
          studio: p.studioName,
          repoUrl: p.repoUrl,
          lead: p.names[p.leadUid],
          participants: p.participants.map((u) => p.names[u]),
          decisionRule: p.decisionRule === 'lead' ? 'the lead decides when partners disagree' : 'every participant must approve',
          charterSigned: projects.charterOk(p)
        },
        roles: roles.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          holder: r.holderUid ? p.names[r.holderUid] : null,
          yours: r.holderUid === uid,
          note: r.note
        })),
        agreements: agreements.docs.map((d) => {
          const g = d.data();
          return { id: d.id, title: g.title, description: g.description, from: g.fromRoleName, to: g.toRoleName, status: g.status };
        }),
        openApprovals: approvals.docs.map((d) => {
          const ap = d.data();
          return {
            id: d.id,
            summary: ap.summary,
            detail: ap.detail,
            requestedBy: ap.createdByName,
            needsYourDecision: ap.required.includes(uid) && !ap.decisions[uid]
          };
        }),
        recentTrials: trials.docs
          .map((d) => d.data())
          .sort((x, y) => (iso(y.at) || '').localeCompare(iso(x.at) || ''))
          .slice(0, 10)
          .map((t) => ({ by: t.byName, note: t.note, link: t.url, uploadedBuild: !!t.buildId, at: iso(t.at) })),
        agreementStatusMeaning: projects.AGREEMENT_STATUS
      };
    },

    async cilyo_propose_agreement(uid, a) {
      const { pRef } = await loadProject(uid, a.project_id);
      const [fromRoleId, toRoleId] = [await resolveRole(pRef, a.from_role), await resolveRole(pRef, a.to_role)];
      return projects.api.proposeAgreement(
        uid,
        { projectId: a.project_id, title: a.title, description: a.description, fromRoleId, toRoleId },
        { viaAI: true }
      );
    },

    cilyo_update_agreement: (uid, a) =>
      projects.api.editAgreement(
        uid,
        { projectId: a.project_id, agreementId: a.agreement_id, title: a.title, description: a.description },
        { viaAI: true }
      ),

    cilyo_set_agreement_status: (uid, a) =>
      projects.api.setAgreementStatus(uid, { projectId: a.project_id, agreementId: a.agreement_id, status: a.status }, { viaAI: true }),

    async cilyo_read_chat(uid, a) {
      const { pRef } = await loadProject(uid, a.project_id);
      const n = Math.max(1, Math.min(100, Number(a.limit) || 30));
      const snap = await pRef.collection('channels').doc('general').collection('messages').orderBy('createdAt', 'desc').limit(n).get();
      return snap.docs
        .map((d) => d.data())
        .reverse()
        .map((m) => ({ author: m.author, text: m.text, at: iso(m.createdAt) }));
    },

    cilyo_post_message: (uid, a) => projects.postAssistantMessage(uid, { projectId: a.project_id, text: a.text }),

    cilyo_post_trial_link: (uid, a) => projects.api.addTrialLink(uid, { projectId: a.project_id, url: a.url, note: a.note }, { viaAI: true }),

    cilyo_decide_approval: (uid, a) =>
      projects.api.decideApproval(uid, { projectId: a.project_id, approvalId: a.approval_id, decision: a.decision }, { viaAI: true })
  };

  return { api: { createConnectorToken }, uidForToken, tools };
}

module.exports = { makeConnector };
