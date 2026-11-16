// منطق المنصة من جهة المتصفح: بيقرأ البيانات وبينادي عمليات السيرفر.
// ما بيحكي مع Firebase مباشرة؛ كله عن طريق driver.js.
import { driver } from './driver.js';

let gamesOrigin = '';
let session = { user: null, profile: null, isAdmin: false };

const byNewest = (field) => (a, b) => (b[field] || 0) - (a[field] || 0);

function needUser() {
  if (!session.user) throw new Error('لازم تسجّل دخول');
  return session.user;
}

async function loadSession(user) {
  if (!user) return { user: null, profile: null, isAdmin: false };
  const profile = await driver.get(`users/${user.uid}`);
  const isAdmin = profile ? !!(await driver.get(`admins/${user.uid}`)) : false;
  return { user, profile, isAdmin };
}

function checkZip(file) {
  if (!file) throw new Error('اختار ملف zip');
  if (file.size > 100 * 1024 * 1024) throw new Error('الملف أكبر من 100 ميغا');
}

// للمتابعة اللحظية: بينادي onChange بس لما البيانات تتغيّر فعلًا عن أول مرة وصلت
function changeTracker(onChange) {
  let last = null;
  return (data) => {
    const text = JSON.stringify(data);
    if (last !== null && text !== last) onChange();
    last = text;
  };
}

// بيقرأ مستند، وبيرجّع null إذا مش موجود أو ممنوع
async function getOrNull(path) {
  try {
    return await driver.get(path);
  } catch (err) {
    if (err.code === 'permission-denied') return null;
    throw err;
  }
}

export const backend = {
  async init() {
    const info = await driver.init();
    gamesOrigin = info.gamesOrigin;
  },

  // cb({ user, profile, isAdmin, error }) كل ما تغيّر الدخول
  onSession(cb) {
    let seq = 0;
    return driver.onAuth(async (user) => {
      const mine = ++seq;
      try {
        const next = await loadSession(user);
        if (mine !== seq) return;
        session = next;
        cb(session);
      } catch (error) {
        if (mine !== seq) return;
        session = { user, profile: null, isAdmin: false };
        cb({ ...session, error });
      }
    });
  },

  async refreshSession() {
    session = await loadSession(session.user);
    return session;
  },

  signIn: (email, password) => driver.signIn(email, password),
  signUp: (email, password) => driver.signUp(email, password),
  signInGoogle: () => driver.signInGoogle(),
  signOut: () => driver.signOut(),
  resetPassword: (email) => driver.resetPassword(email),

  // أي عملية سيرفر عادية: backend.op('signCharter', { projectId })
  op: (name, args) => driver.call(name, args, false),

  getUser: (uid) => driver.get(`users/${uid}`),

  // ---------- الأعمال والمتجر ----------
  playUrl: (buildId, entry) => `${gamesOrigin}/g/${buildId}/${entry.split('/').map(encodeURIComponent).join('/')}`,

  embedUrl(episode) {
    if (episode.provider === 'youtube') return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(episode.videoId)}`;
    if (episode.provider === 'vimeo') return `https://player.vimeo.com/video/${encodeURIComponent(episode.videoId)}`;
    return null;
  },

  listWorks: () => driver.list('works', { where: [['status', '==', 'published']], orderBy: ['updatedAt', 'desc'], limit: 90 }),

  async listMyWorks() {
    const user = needUser();
    return (await driver.list('works', { where: [['teamUids', 'array-contains', user.uid]] })).sort(byNewest('updatedAt'));
  },

  async listStudioWorks(studioId) {
    const works = await driver.list('works', { where: [['studioId', '==', studioId], ['status', '==', 'published']] });
    return works.sort(byNewest('updatedAt'));
  },

  getWork: (id) => getOrNull(`works/${id}`),

  async publishWork(fields, file, onProgress) {
    const args = { ...fields };
    if (fields.type !== 'video') {
      checkZip(file);
      args.uploadId = await driver.upload(file, onProgress);
    }
    // النشر دايمًا بيروح للدالة الثقيلة، حتى للعمل المرئي اللي ما فيه ملف
    return (await driver.call('publishWork', args, true)).workId;
  },

  async updateWorkBuild(workId, file, onProgress) {
    checkZip(file);
    const uploadId = await driver.upload(file, onProgress);
    await driver.call('updateWorkBuild', { workId, uploadId }, true);
  },

  async reportWork(workId, reason) {
    const user = needUser();
    await driver.add('reports', { uid: user.uid, workId, reason, createdAt: driver.NOW });
  },

  listReports: () => driver.list('reports', { orderBy: ['createdAt', 'desc'], limit: 100 }),
  resolveReport: (id) => driver.remove(`reports/${id}`),

  // ---------- المحادثة (سيرفر عمل، أو استوديو، أو مشروع) ----------
  // base: 'works/ID' أو 'studios/ID' أو 'projects/ID'
  subscribeMessages(base, channelId, onMessages, onError) {
    return driver.watch(
      `${base}/channels/${channelId}/messages`,
      { orderBy: ['createdAt', 'desc'], limit: 60 },
      (docs) => onMessages(docs.reverse()),
      onError
    );
  },

  async sendMessage(base, channelId, text) {
    const user = needUser();
    if (!session.profile) throw new Error('لازم تختار اسم مستخدم أول');
    await driver.add(`${base}/channels/${channelId}/messages`, {
      uid: user.uid,
      author: session.profile.username,
      text,
      createdAt: driver.NOW
    });
  },

  deleteMessage: (base, channelId, messageId) => driver.remove(`${base}/channels/${channelId}/messages/${messageId}`),

  // ---------- الاستوديوهات ----------
  async listMyStudios() {
    const user = needUser();
    const [mine, invites] = await Promise.all([
      driver.list('studios', { where: [['members', 'array-contains', user.uid]] }),
      driver.list('studios', { where: [['invites', 'array-contains', user.uid]] })
    ]);
    return {
      personal: mine.find((s) => s.kind === 'personal') || null,
      shared: mine.filter((s) => s.kind === 'shared' && s.status !== 'closed').sort(byNewest('createdAt')),
      invites
    };
  },

  // الاستوديو مع أسماء أعضائه
  async getStudio(id) {
    const studio = await driver.get(`studios/${id}`);
    if (!studio) return null;
    const names = {};
    await Promise.all(
      [...studio.members, ...(studio.invites || [])].slice(0, 40).map(async (uid) => {
        const u = await driver.get(`users/${uid}`);
        names[uid] = u ? u.username : 'مستخدم';
      })
    );
    return { ...studio, invites: studio.invites || [], names };
  },

  getStudioContract: (id) => getOrNull(`studios/${id}/internal/contract`),
  listStudioLog: (id) => driver.list(`studios/${id}/log`, { orderBy: ['at', 'desc'], limit: 200 }),

  // بتنادي onChange لما يتغيّر الاستوديو أو عقده (مش أول مرة)
  watchStudio(id, withContract, onChange) {
    const stops = [];
    const track = () => changeTracker(onChange);
    stops.push(driver.watchDoc(`studios/${id}`, track(), () => {}));
    if (withContract) stops.push(driver.watchDoc(`studios/${id}/internal/contract`, track(), () => {}));
    return () => stops.forEach((stop) => stop());
  },

  // ---------- المشاريع ----------
  async listMyProjects() {
    const user = needUser();
    const [projects, invites] = await Promise.all([
      driver.list('projects', { where: [['participants', 'array-contains', user.uid]] }),
      driver.list('projects', { where: [['invites', 'array-contains', user.uid]] })
    ]);
    return { projects: projects.sort(byNewest('createdAt')), invites };
  },

  getProject: (id) => getOrNull(`projects/${id}`),

  async listRoles(projectId) {
    return (await driver.list(`projects/${projectId}/roles`)).sort((a, b) => a.order - b.order);
  },

  listEarnings: (projectId) => driver.list(`projects/${projectId}/earnings`, { orderBy: ['at', 'desc'], limit: 200 }),

  async listAgreements(projectId) {
    return (await driver.list(`projects/${projectId}/agreements`)).sort(byNewest('updatedAt'));
  },

  listApprovals: (projectId) => driver.list(`projects/${projectId}/approvals`, { orderBy: ['createdAt', 'desc'], limit: 100 }),
  listTrials: (projectId) => driver.list(`projects/${projectId}/trials`, { orderBy: ['at', 'desc'], limit: 60 }),
  listProjectLog: (projectId) => driver.list(`projects/${projectId}/log`, { orderBy: ['at', 'desc'], limit: 300 }),

  // بتنادي onChange لما يتغيّر المشروع أو موافقاته أو اتفاقاته (مش أول مرة)
  watchProject(projectId, onChange) {
    const track = () => changeTracker(onChange);
    const stops = [
      driver.watchDoc(`projects/${projectId}`, track(), () => {}),
      driver.watch(`projects/${projectId}/approvals`, { orderBy: ['createdAt', 'desc'], limit: 30 }, track(), () => {}),
      driver.watch(`projects/${projectId}/agreements`, {}, track(), () => {})
    ];
    return () => stops.forEach((stop) => stop());
  },

  async addTrial(projectId, file, note, onProgress) {
    checkZip(file);
    const uploadId = await driver.upload(file, onProgress);
    await driver.call('addTrial', { projectId, uploadId, note }, true);
  },

  // ---------- لوحة الفرص ----------
  listOpenRoles: () => driver.list('openRoles', { where: [['status', '==', 'open']], orderBy: ['createdAt', 'desc'], limit: 100 }),

  async listApplications(roleId) {
    try {
      return (await driver.list(`openRoles/${roleId}/applications`)).sort(byNewest('at'));
    } catch (err) {
      if (err.code === 'permission-denied') return [];
      throw err;
    }
  },

  myApplication(roleId) {
    return session.user ? getOrNull(`openRoles/${roleId}/applications/${session.user.uid}`) : Promise.resolve(null);
  },

  // عنوان موصل المساعد
  mcpUrl: () => `${location.origin}/mcp`
};
