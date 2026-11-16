'use strict';
// بيجمع كل قواعد Cilyo بمكان واحد.
const { makeCtx, AppError, fail } = require('./ctx');
const { makeWorks } = require('./works');
const { makeStudios } = require('./studios');
const { makeProjects } = require('./projects');
const { makeBoard } = require('./board');
const { makeConnector } = require('./connector');

// العمليات اللي بتفك ضغط ملف: بدها ذاكرة ووقت أكثر، فإلها دالة لحالها
const HEAVY_OPS = ['publishWork', 'updateWorkBuild', 'addTrial'];

function makeCore(deps) {
  const ctx = makeCtx(deps);
  const works = makeWorks(ctx);
  const studios = makeStudios(ctx);
  const projects = makeProjects(ctx, studios, works);
  const board = makeBoard(ctx, studios);
  const connector = makeConnector(ctx, projects);
  const api = { ...works.api, ...studios.api, ...projects.api, ...board.api, ...connector.api };

  // كل طلبات الواجهة بتمر من هون: op اسم العملية، args بياناتها
  async function call(uid, op, args, { heavy } = {}) {
    if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(api, op)) fail('invalid-argument', 'عملية غير معروفة');
    if (HEAVY_OPS.includes(op) !== !!heavy) fail('invalid-argument', 'العملية انبعتت للدالة الغلط');
    return api[op](uid, args && typeof args === 'object' ? args : {});
  }

  return { call, api, resolveGameFile: works.resolveGameFile, connector };
}

module.exports = { makeCore, AppError, HEAVY_OPS };
