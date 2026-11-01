// قاعدة بيانات بسيطة بملف JSON، مناسبة للتست على جهاز واحد.
// كل البيانات بتنحفظ بمجلد data/ جنب المشروع.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.CILYO_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

function empty() {
  return {
    users: [],
    sessions: {},
    tokens: {},
    servers: [],
    messages: [],
    games: [],
    builds: [],
    studios: [],
    projects: [],
    agreements: [],
    approvals: [],
    trials: [],
    log: []
  };
}

let db = empty();
let timer = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    db = Object.assign(empty(), JSON.parse(fs.readFileSync(FILE, 'utf8')));
  }
  return db;
}

function writeNow() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    writeNow();
  }, 50);
}

function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  writeNow();
}

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

module.exports = {
  load,
  save,
  flush,
  id,
  DATA_DIR,
  get db() {
    return db;
  }
};
