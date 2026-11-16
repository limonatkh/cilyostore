'use strict';
// قراءة ملف zip تبع لعبة أو برنامج ويب، مع حدود أمان.
const AdmZip = require('adm-zip');

const MB = 1024 * 1024;
const LIMITS = {
  zipBytes: 100 * MB, // حجم الملف المضغوط
  totalBytes: 300 * MB, // الحجم بعد فك الضغط
  fileBytes: 30 * MB, // أكبر ملف واحد جوّا الـzip
  files: 5000,
  pathBytes: 400
};

class ZipError extends Error {}

// بيرجّع مسار نظيف، أو null إذا الملف لازم ينتجاهل
function cleanPath(name) {
  const parts = String(name)
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.');
  if (!parts.length) return null;
  if (parts.some((p) => p === '..')) return null;
  if (parts[0] === '__MACOSX') return null;
  // eslint-disable-next-line no-control-regex
  if (parts.some((p) => /[\u0000-\u001f\u007f]/.test(p))) return null;
  const last = parts[parts.length - 1];
  if (last === '.DS_Store' || last === 'Thumbs.db') return null;
  const path = parts.join('/');
  if (Buffer.byteLength(path) > LIMITS.pathBytes) return null;
  return path;
}

// بيفحص الـzip بدون ما يفك ضغط الملفات، وبيرجّع خطة: الملفات وملف البداية.
// كل ملف إله read() بتفك ضغطه لما نحتاجه.
function planGameZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ZipError('الملف فاضي');
  if (buffer.length > LIMITS.zipBytes) throw new ZipError('الملف المضغوط أكبر من 100 ميغا');
  let entries;
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch (e) {
    throw new ZipError('الملف مش zip صالح');
  }
  if (entries.length > LIMITS.files) throw new ZipError('الملف فيه ملفات كثير كثير (الحد 5000)');

  const chosen = new Map();
  let total = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    const path = cleanPath(e.entryName);
    if (!path || chosen.has(path)) continue;
    const size = Number(e.header.size) || 0;
    if (size > LIMITS.fileBytes) throw new ZipError(`الملف «${path}» أكبر من 30 ميغا`);
    total += size;
    if (total > LIMITS.totalBytes) throw new ZipError('العمل بعد فك الضغط أكبر من 300 ميغا');
    chosen.set(path, e);
  }
  if (chosen.size === 0) throw new ZipError('الملف المضغوط فاضي');

  // ملف البداية: أقرب index.html للجذر
  let entry = null;
  let entryDepth = Infinity;
  for (const path of chosen.keys()) {
    const parts = path.split('/');
    if (parts[parts.length - 1].toLowerCase() !== 'index.html') continue;
    if (parts.length < entryDepth || (parts.length === entryDepth && path < entry)) {
      entry = path;
      entryDepth = parts.length;
    }
  }
  if (!entry) throw new ZipError('ما لقينا ملف index.html جوّا الملف المضغوط');

  const files = Array.from(chosen, ([path, e]) => ({
    path,
    size: Number(e.header.size) || 0,
    read() {
      let data;
      try {
        data = e.getData();
      } catch (err) {
        throw new ZipError(`الملف «${path}» جوّا الـzip خربان`);
      }
      if (data.length > LIMITS.fileBytes) throw new ZipError(`الملف «${path}» أكبر من 30 ميغا`);
      return data;
    }
  }));
  return { files, entry, total };
}

module.exports = { planGameZip, cleanPath, ZipError, LIMITS };
