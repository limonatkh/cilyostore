'use strict';
// دوال Cilyo على Firebase. المنطق كله بمجلد lib، وهون بس الربط.
//
//   api        كل عمليات الواجهة (الحساب، الاستوديو، المشروع، الموافقات…)
//   apiHeavy   العمليات اللي بتفك ضغط ملف مرفوع
//   serveGame  بيشغّل ملفات الأعمال على موقع الألعاب المنفصل
//   mcp        موصل مساعد الـAI
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { makeCore, AppError } = require('./lib/core');
const { makeGameHandler } = require('./lib/serve');
const { makeMcpHandler } = require('./lib/mcp');

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const core = makeCore({
  db: getFirestore(),
  getBucket: () => getStorage().bucket(),
  serverTimestamp: () => FieldValue.serverTimestamp(),
  logger
});

function callable(options, heavy) {
  return onCall(options, async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'لازم تسجّل دخول');
    const data = request.data || {};
    try {
      return (await core.call(request.auth.uid, data.op, data.args, { heavy })) || {};
    } catch (err) {
      if (err instanceof AppError) throw new HttpsError(err.code, err.message);
      logger.error(err);
      throw new HttpsError('internal', 'صار خطأ بالسيرفر، جرّب كمان مرة');
    }
  });
}

exports.api = callable({}, false);
exports.apiHeavy = callable({ memory: '1GiB', timeoutSeconds: 540 }, true);
exports.serveGame = onRequest({ memory: '256MiB', maxInstances: 20 }, makeGameHandler(core, logger));
exports.mcp = onRequest({}, makeMcpHandler(core.connector, logger));
