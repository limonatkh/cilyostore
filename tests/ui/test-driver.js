// بديل driver.js للاختبار: نفس الواجهة، بس بيحكي مع السيرفر التجريبي (tests/ui/serve.js) بدل Firebase.
const listeners = new Set();
let user = JSON.parse(sessionStorage.getItem('t.user') || 'null');

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(/[؀-ۿ]/.test(json.message || '') ? json.message : 'صار خطأ، جرّب كمان مرة');
    err.code = json.code;
    throw err;
  }
  return json.data;
}

function setUser(next) {
  user = next;
  if (next) sessionStorage.setItem('t.user', JSON.stringify(next));
  else sessionStorage.removeItem('t.user');
  listeners.forEach((cb) => cb(user));
}

// المتابعة اللحظية: بنسأل السيرفر كل شوي إذا تغيّر إشي
function poll(load, onData, onError) {
  let stopped = false;
  let last = null;
  let seen = -1;
  const tick = async () => {
    if (stopped) return;
    try {
      const { version } = await (await fetch('/t/version')).json();
      if (version !== seen) {
        seen = version;
        const data = await load();
        const text = JSON.stringify(data);
        if (!stopped && text !== last) {
          last = text;
          onData(data);
        }
      }
    } catch (err) {
      if (!stopped && onError) onError(err);
    }
    if (!stopped) setTimeout(tick, 250);
  };
  tick();
  return () => {
    stopped = true;
  };
}

export const driver = {
  NOW: '__server_time__',
  async init() {
    return { projectId: 'test', gamesOrigin: `http://localhost:${Number(location.port) + 1}` };
  },
  onAuth(cb) {
    listeners.add(cb);
    Promise.resolve().then(() => cb(user));
    return () => listeners.delete(cb);
  },
  signIn: async (email, password) => setUser(await post('/t/signin', { email, password })),
  signUp: async (email, password) => setUser(await post('/t/signup', { email, password })),
  signInGoogle: async () => {
    throw new Error('دخول Google مش متوفر بالنسخة التجريبية');
  },
  signOut: async () => setUser(null),
  resetPassword: async () => {},
  call: (op, args, heavy) => post('/t/call', { uid: user && user.uid, op, args: args || {}, heavy: !!heavy }),
  get: (path) => post('/t/get', { path }),
  list: (path, opts) => post('/t/list', { path, opts }),
  watch: (path, opts, onData, onError) => poll(() => post('/t/list', { path, opts }), onData, onError),
  watchDoc: (path, onData, onError) => poll(() => post('/t/get', { path }), onData, onError),
  add: (path, data) => post('/t/add', { path, data }),
  remove: (path) => post('/t/remove', { path }),
  async upload(file, onProgress) {
    if (!user) throw new Error('لازم تسجّل دخول');
    const id = 'up' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    if (onProgress) onProgress(0.5);
    await fetch(`/t/upload?uid=${user.uid}&id=${id}`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file });
    if (onProgress) onProgress(1);
    return id;
  }
};
