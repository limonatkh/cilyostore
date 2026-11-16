'use strict';
// بيرد على طلبات ملفات الأعمال المرفوعة (موقع الألعاب).

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!n) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

function makeGameHandler(core, logger) {
  return async function serveGame(req, res) {
    res.set('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD');
      res.status(405).end();
      return;
    }
    const found = await core.resolveGameFile(req.path);
    if (found.status === 301) {
      res.redirect(301, found.location);
      return;
    }
    if (found.status !== 200) {
      res
        .status(found.status)
        .type('text/plain; charset=utf-8')
        .send(found.status === 404 ? 'الملف مش موجود' : 'طلب غير صالح');
      return;
    }
    const { file, meta } = found;
    const size = Number(meta.size) || 0;
    const etag = meta.etag ? `"${meta.etag}"` : null;
    res.set('Content-Type', meta.contentType || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=600');
    res.set('Accept-Ranges', 'bytes');
    if (etag) res.set('ETag', etag);
    if (etag && req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.set('Content-Range', `bytes */${size}`);
      res.status(416).end();
      return;
    }
    let readOptions = {};
    if (range) {
      res.status(206);
      res.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.set('Content-Length', String(range.end - range.start + 1));
      readOptions = { start: range.start, end: range.end };
    } else {
      res.set('Content-Length', String(size));
    }
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    const stream = file.createReadStream(readOptions);
    stream.on('error', (err) => {
      logger.error(err);
      if (!res.headersSent) res.status(500).end();
      else res.destroy(err);
    });
    stream.pipe(res);
  };
}

module.exports = { makeGameHandler, parseRange };
