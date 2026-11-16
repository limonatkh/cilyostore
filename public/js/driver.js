// الطبقة الوحيدة اللي بتحكي مع Firebase مباشرة.
// بتقدّم عمليات عامة بسيطة (دخول، قراءة، متابعة، كتابة، رفع، مناداة السيرفر)،
// وكل منطق المنصة فوقها بملف backend.js.
import { initializeApp } from '../vendor/firebase/firebase-app.js';
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  sendPasswordResetEmail
} from '../vendor/firebase/firebase-auth.js';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  addDoc,
  deleteDoc,
  serverTimestamp
} from '../vendor/firebase/firebase-firestore.js';
import { getStorage, connectStorageEmulator, ref, uploadBytesResumable } from '../vendor/firebase/firebase-storage.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from '../vendor/firebase/firebase-functions.js';

let auth;
let db;
let storage;
let functions;

const ERRORS = {
  'auth/invalid-credential': 'الإيميل أو كلمة السر غلط',
  'auth/wrong-password': 'الإيميل أو كلمة السر غلط',
  'auth/user-not-found': 'الإيميل أو كلمة السر غلط',
  'auth/invalid-email': 'الإيميل مش مكتوب صح',
  'auth/missing-password': 'اكتب كلمة السر',
  'auth/email-already-in-use': 'في حساب بهاد الإيميل. جرّب تسجّل دخول.',
  'auth/weak-password': 'كلمة السر ضعيفة. لازم 6 أحرف على الأقل.',
  'auth/too-many-requests': 'محاولات كثير. استنى شوي وجرّب كمان مرة.',
  'auth/network-request-failed': 'ما في اتصال بالإنترنت',
  'auth/popup-closed-by-user': 'سكّرت نافذة الدخول قبل ما تكمل',
  'auth/cancelled-popup-request': 'سكّرت نافذة الدخول قبل ما تكمل',
  'auth/popup-blocked': 'المتصفح منع نافذة الدخول. اسمح بالنوافذ المنبثقة وجرّب كمان مرة.',
  'auth/operation-not-allowed': 'طريقة الدخول هاي مش مفعّلة بالمنصة',
  'auth/unauthorized-domain': 'هاد الرابط مش مضاف لقائمة النطاقات المسموحة بإعدادات الدخول',
  'permission-denied': 'ما عندك صلاحية لهالإشي',
  unavailable: 'ما قدرنا نوصل للسيرفر. تأكد من الإنترنت.',
  'deadline-exceeded': 'العملية أخذت وقت أطول من اللازم. جرّب كمان مرة.',
  'failed-precondition': 'قاعدة البيانات لسا بتتجهز (الفهارس). استنى كم دقيقة وجرّب.',
  'storage/unauthorized': 'ما انقبل الملف. لازم يكون zip وأقل من 100 ميغا.',
  'storage/canceled': 'انلغى الرفع',
  'storage/retry-limit-exceeded': 'انقطع الرفع. تأكد من الإنترنت وجرّب كمان مرة.'
};

// بيحوّل أخطاء Firebase لرسائل مفهومة. أخطاء دوال السيرفر رسائلها جاهزة بالعربي.
function friendly(err) {
  const code = String((err && err.code) || '');
  const short = code.replace(/^(firestore|functions)\//, '');
  let message = null;
  if (code.startsWith('functions/') && err.message && /[؀-ۿ]/.test(err.message)) message = err.message;
  else message = ERRORS[code] || ERRORS[short];
  if (!message) {
    console.error(err);
    message = 'صار خطأ، جرّب كمان مرة';
  }
  const out = new Error(message);
  out.code = short;
  return out;
}

async function guard(promise) {
  try {
    return await promise;
  } catch (err) {
    throw friendly(err);
  }
}

// بيحوّل تواريخ Firestore لأرقام (ميلي ثانية)
function plain(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return value;
}

const fromSnap = (snap) => ({ id: snap.id, ...plain(snap.data({ serverTimestamps: 'estimate' })) });

function buildQuery(path, opts = {}) {
  const parts = [];
  (opts.where || []).forEach(([field, op, value]) => parts.push(where(field, op, value)));
  if (opts.orderBy) parts.push(orderBy(opts.orderBy[0], opts.orderBy[1] || 'asc'));
  if (opts.limit) parts.push(limit(opts.limit));
  return query(collection(db, path), ...parts);
}

function randomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export const driver = {
  // علامة: «حط وقت السيرفر هون» لما نكتب مستند
  NOW: '__server_time__',

  // بيرجّع { projectId, gamesOrigin }
  async init() {
    const cfg = window.CILYO_CONFIG || {};
    let firebaseConfig = cfg.firebase;
    if (!firebaseConfig) {
      const res = await fetch('/__/firebase/init.json');
      if (!res.ok) throw new Error('ما لقينا إعدادات Firebase. عبّي firebase بملف config.js');
      firebaseConfig = await res.json();
    }
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    storage = getStorage(app);
    functions = getFunctions(app, cfg.functionsRegion || 'us-central1');
    const host = location.hostname;
    let gamesOrigin = cfg.gamesOrigin || `https://${firebaseConfig.projectId}-games.web.app`;
    if ((host === 'localhost' || host === '127.0.0.1') && cfg.emulators) {
      const e = cfg.emulators;
      connectAuthEmulator(auth, `http://${host}:${e.auth}`, { disableWarnings: true });
      connectFirestoreEmulator(db, host, e.firestore);
      connectStorageEmulator(storage, host, e.storage);
      connectFunctionsEmulator(functions, host, e.functions);
      gamesOrigin = e.gamesOrigin;
    }
    return { projectId: firebaseConfig.projectId, gamesOrigin: gamesOrigin.replace(/\/$/, '') };
  },

  // cb(user) كل ما تغيّر الدخول. user = { uid, email } أو null
  onAuth(cb) {
    return onAuthStateChanged(auth, (user) => cb(user ? { uid: user.uid, email: user.email } : null));
  },

  signIn: (email, password) => guard(signInWithEmailAndPassword(auth, email, password)).then(() => {}),
  signUp: (email, password) => guard(createUserWithEmailAndPassword(auth, email, password)).then(() => {}),
  signInGoogle: () => guard(signInWithPopup(auth, new GoogleAuthProvider())).then(() => {}),
  signOut: () => guard(signOut(auth)),
  resetPassword: (email) => guard(sendPasswordResetEmail(auth, email)),

  // مناداة السيرفر. heavy: العمليات اللي بتفك ضغط ملف
  async call(op, args, heavy) {
    const fn = httpsCallable(functions, heavy ? 'apiHeavy' : 'api', heavy ? { timeout: 540000 } : undefined);
    const result = await guard(fn({ op, args: args || {} }));
    return result.data;
  },

  // مستند واحد، أو null إذا مش موجود
  async get(path) {
    const snap = await guard(getDoc(doc(db, path)));
    return snap.exists() ? fromSnap(snap) : null;
  },

  // opts: { where: [[field, op, value]], orderBy: [field, 'asc'|'desc'], limit }
  async list(path, opts) {
    const snap = await guard(getDocs(buildQuery(path, opts)));
    return snap.docs.map(fromSnap);
  },

  // متابعة لحظية لقائمة. بترجّع دالة لإيقاف المتابعة.
  watch(path, opts, onData, onError) {
    return onSnapshot(
      buildQuery(path, opts),
      (snap) => onData(snap.docs.map(fromSnap)),
      (err) => onError && onError(friendly(err))
    );
  },

  watchDoc(path, onData, onError) {
    return onSnapshot(
      doc(db, path),
      (snap) => onData(snap.exists() ? fromSnap(snap) : null),
      (err) => onError && onError(friendly(err))
    );
  },

  async add(path, data) {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = v === driver.NOW ? serverTimestamp() : v;
    const refDoc = await guard(addDoc(collection(db, path), out));
    return refDoc.id;
  },

  remove: (path) => guard(deleteDoc(doc(db, path))),

  // بيرفع ملف zip لمجلد المستخدم، وبيرجّع رقم الرفع
  upload(file, onProgress) {
    const user = auth.currentUser;
    if (!user) return Promise.reject(new Error('لازم تسجّل دخول'));
    const uploadId = randomId();
    const task = uploadBytesResumable(ref(storage, `uploads/${user.uid}/${uploadId}.zip`), file, { contentType: 'application/zip' });
    return new Promise((resolve, reject) => {
      task.on(
        'state_changed',
        (s) => onProgress && onProgress(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0),
        (err) => reject(friendly(err)),
        () => resolve(uploadId)
      );
    });
  }
};
