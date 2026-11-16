'use strict';
// قاعدة بيانات وتخزين تجريبيين بالذاكرة، بنفس شكل firebase-admin،
// عشان نختبر قواعد السيرفر بدون Firebase حقيقي.
// بتدعم بس العمليات اللي بيستخدمها الكود (شوف الملاحظة بأول functions/lib/ctx.js).
const { Readable } = require('stream');

const TS = Symbol('serverTimestamp');
let clock = Date.now();

class FakeTimestamp {
  constructor(ms) {
    this.ms = ms;
  }
  toMillis() {
    return this.ms;
  }
  toDate() {
    return new Date(this.ms);
  }
}

function clone(v) {
  if (v === TS) return new FakeTimestamp(++clock);
  if (v instanceof FakeTimestamp) return v;
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) throw new Error(`Firestore: undefined value in field "${k}"`);
      out[k] = clone(x);
    }
    return out;
  }
  return v;
}

function autoId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

class DocSnap {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = data !== undefined;
    this._data = data;
  }
  data() {
    return this._data === undefined ? undefined : clone(this._data);
  }
}

class DocRef {
  constructor(db, path) {
    if (path.split('/').length % 2 !== 0) throw new Error('Bad document path: ' + path);
    this.db = db;
    this.path = path;
    this.id = path.split('/').pop();
  }
  collection(name) {
    return new CollRef(this.db, `${this.path}/${name}`);
  }
  async get() {
    return new DocSnap(this, this.db.docs.get(this.path));
  }
  async set(data) {
    this.db._apply([{ type: 'set', ref: this, data }]);
  }
  async update(data) {
    this.db._apply([{ type: 'update', ref: this, data }]);
  }
  async delete() {
    this.db._apply([{ type: 'delete', ref: this }]);
  }
}

class Query {
  constructor(db, path, filters = [], order = null, max = null) {
    this.db = db;
    this.path = path;
    this.filters = filters;
    this.order = order;
    this.max = max;
  }
  where(field, op, value) {
    if (!['==', 'array-contains'].includes(op)) throw new Error('Unsupported operator: ' + op);
    return new Query(this.db, this.path, [...this.filters, { field, op, value }], this.order, this.max);
  }
  orderBy(field, dir = 'asc') {
    return new Query(this.db, this.path, this.filters, { field, dir }, this.max);
  }
  limit(n) {
    return new Query(this.db, this.path, this.filters, this.order, n);
  }
  _run() {
    const prefix = this.path + '/';
    const depth = this.path.split('/').length + 1;
    let rows = [];
    for (const [path, data] of this.db.docs) {
      if (!path.startsWith(prefix) || path.split('/').length !== depth) continue;
      const ok = this.filters.every((f) => (f.op === '==' ? data[f.field] === f.value : Array.isArray(data[f.field]) && data[f.field].includes(f.value)));
      if (ok) rows.push([path, data]);
    }
    if (this.order) {
      const { field, dir } = this.order;
      const key = (d) => (d[field] instanceof FakeTimestamp ? d[field].ms : d[field]);
      rows = rows.filter(([, d]) => d[field] !== undefined);
      rows.sort((a, b) => (key(a[1]) < key(b[1]) ? -1 : key(a[1]) > key(b[1]) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return rows.map(([path, data]) => new DocSnap(new DocRef(this.db, path), data));
  }
  async get() {
    const docs = this._run();
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
  count() {
    return { get: async () => ({ data: () => ({ count: this._run().length }) }) };
  }
}

class CollRef extends Query {
  doc(id) {
    return new DocRef(this.db, `${this.path}/${id || autoId()}`);
  }
  async add(data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

class FakeFirestore {
  constructor() {
    this.docs = new Map();
    this.queue = Promise.resolve();
    this.version = 0;
  }
  doc(path) {
    return new DocRef(this, path);
  }
  collection(path) {
    return new CollRef(this, path);
  }
  // بيطبّق مجموعة كتابات مرة وحدة: يا كلها يا ولا وحدة
  _apply(ops) {
    const staged = new Map();
    const read = (path) => (staged.has(path) ? staged.get(path) : this.docs.get(path));
    for (const op of ops) {
      const path = op.ref.path;
      if (op.type === 'set') staged.set(path, clone(op.data));
      else if (op.type === 'update') {
        const cur = read(path);
        if (cur === undefined) throw Object.assign(new Error('NOT_FOUND: no document to update: ' + path), { code: 5 });
        if (Object.keys(op.data).some((k) => k.includes('.'))) throw new Error('Dotted field paths are not supported: ' + path);
        staged.set(path, { ...cur, ...clone(op.data) });
      } else staged.set(path, undefined);
    }
    for (const [path, data] of staged) {
      if (data === undefined) this.docs.delete(path);
      else this.docs.set(path, data);
    }
    this.version++;
  }
  batch() {
    const ops = [];
    const batch = {
      set: (ref, data) => (ops.push({ type: 'set', ref, data }), batch),
      update: (ref, data) => (ops.push({ type: 'update', ref, data }), batch),
      delete: (ref) => (ops.push({ type: 'delete', ref }), batch),
      commit: async () => this._apply(ops)
    };
    return batch;
  }
  // المعاملات بتتنفذ وحدة ورا الثانية. وزي Firestore: ممنوع قراءة بعد كتابة.
  runTransaction(fn) {
    const run = async () => {
      const ops = [];
      const tx = {
        get: async (ref) => {
          if (ops.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
          if (!(ref instanceof DocRef)) throw new Error('tx.get supports documents only');
          return ref.get();
        },
        set: (ref, data) => (ops.push({ type: 'set', ref, data }), tx),
        update: (ref, data) => (ops.push({ type: 'update', ref, data }), tx),
        delete: (ref) => (ops.push({ type: 'delete', ref }), tx)
      };
      const result = await fn(tx);
      this._apply(ops);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}

class FakeBucket {
  constructor() {
    this.files = new Map();
  }
  put(name, data, contentType) {
    this.files.set(name, { data: Buffer.from(data), contentType: contentType || 'application/octet-stream' });
  }
  file(name) {
    const files = this.files;
    const need = () => {
      const f = files.get(name);
      if (!f) throw Object.assign(new Error('No such object: ' + name), { code: 404 });
      return f;
    };
    return {
      name,
      getMetadata: async () => {
        const f = need();
        return [{ size: String(f.data.length), contentType: f.contentType, etag: 'e' + f.data.length }];
      },
      download: async () => [need().data],
      save: async (data, options = {}) => {
        files.set(name, { data: Buffer.from(data), contentType: options.contentType || 'application/octet-stream' });
      },
      delete: async () => {
        need();
        files.delete(name);
      },
      createReadStream: (options = {}) => {
        const f = need();
        const end = options.end === undefined ? f.data.length : options.end + 1;
        return Readable.from([f.data.subarray(options.start || 0, end)]);
      }
    };
  }
  async deleteFiles({ prefix }) {
    for (const name of Array.from(this.files.keys())) if (name.startsWith(prefix)) this.files.delete(name);
  }
  names(prefix = '') {
    return Array.from(this.files.keys()).filter((n) => n.startsWith(prefix));
  }
}

function makeFakes() {
  const db = new FakeFirestore();
  const bucket = new FakeBucket();
  const quiet = { error() {}, warn() {}, info() {}, log() {} };
  return { db, bucket, deps: { db, getBucket: () => bucket, serverTimestamp: () => TS, logger: quiet } };
}

module.exports = { makeFakes, FakeTimestamp };
