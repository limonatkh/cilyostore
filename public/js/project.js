// مساحة عمل المشروع: المحادثة، الميثاق والحصص، الاتفاقات، الموافقات، التجارب والنشر، السجل، الإعدادات.
import { backend } from './backend.js';
import { state, render, h, toast, act, opButton, field, formValues, select, fmtTime, externalLink, messageBox, chip, needLogin, uploadProgress, logList, chatPanel, workspace, softRefresh } from './ui.js';
import { KIND_NAMES } from './studio.js';

const ROLE_KINDS = { production: 'إنتاج', service: 'خدمة' };
const RULES = {
  unanimous: 'بالإجماع: كل طلب بدّه موافقة كل المعنيين',
  lead: 'القائد بيحسم: إذا اختلفوا أو غاب حدا، القائد بيقرر'
};
const STATUS = { proposed: ['مقترح', ''], agreed: ['متفق عليه', 'info'], implemented: ['منفّذ', 'accent'], approved: ['معتمد', 'good'], rejected: ['مرفوض', 'bad'] };
const CLOSED = { approved: ['انقبل', 'good'], rejected: ['انرفض', 'bad'], cancelled: ['انلغى', ''] };

const fmtNum = (n) => String(Math.round(n * 100) / 100);
const charterSigned = (p) => p.participants.length === 1 || p.participants.every((u) => p.charterSignatures[u]);

// زر صغير بيفتح نموذج فيه حقل واحد (سبب أو ملاحظة)
function askForm(summary, label, button, run, { required, cls } = {}) {
  return h(
    'details',
    null,
    h('summary', { class: 'small-text', text: summary }),
    h(
      'form',
      {
        class: 'stack',
        onSubmit: act(async (ev, form) => {
          await run(formValues(form).text.trim());
          await render();
        })
      },
      field(label, h('textarea', { class: 'input', name: 'text', maxlength: '500', required: !!required })),
      h('div', { class: 'row' }, h('button', { class: 'btn small ' + (cls || ''), type: 'submit' }, button))
    )
  );
}

// ---------- الميثاق والحصص ----------
function sharesTable(p, roles) {
  const total = roles.reduce((sum, r) => sum + r.weight, 0) + (p.orphanPoints || 0);
  if (!total) return null;
  const pool = 100 - p.studioSharePct;
  const earnedSum = Object.values(p.earned).reduce((a, b) => a + b, 0);
  const rows = Object.entries(p.earned)
    .sort((a, b) => b[1] - a[1])
    .map(([uid, pts]) => h('tr', null, h('td', null, h('bdi', { text: p.names[uid] || 'مشارك سابق' })), h('td', { text: fmtNum(pts) }), h('td', { text: fmtNum((pool * pts) / total) + '%' })));
  return h(
    'section',
    { class: 'card stack' },
    h('h2', { text: 'الحصص الحالية' }),
    h('p', { class: 'muted small-text', text: 'الحصة بتنكسب لما يتسلّم الدور ويعتمده الشركاء. اللي لسا ما انكسب بيضل للمشروع.' }),
    h(
      'table',
      { class: 'layers-table' },
      h('thead', null, h('tr', null, h('th', { text: 'صاحب الحصة' }), h('th', { text: 'النقاط المكتسبة' }), h('th', { text: 'الحصة' }))),
      h(
        'tbody',
        null,
        rows,
        p.studioSharePct ? h('tr', null, h('td', { text: 'الاستوديو: ' + p.studioName }), h('td', { text: '—' }), h('td', { text: p.studioSharePct + '%' })) : null,
        h('tr', null, h('td', { class: 'muted', text: 'لسا ما انكسب' }), h('td', { class: 'muted', text: fmtNum(total - earnedSum) }), h('td', { class: 'muted', text: fmtNum((pool * (total - earnedSum)) / total) + '%' }))
      )
    ),
    h('span', { class: 'muted small-text', text: `مجموع نقاط الأدوار: ${fmtNum(total)}` })
  );
}

function roleItem(p, r) {
  const me = state.user.uid;
  const mine = r.holderUid === me;
  const done = r.periodsEarned >= r.periods;
  const progressText = r.kind === 'service' ? `الفترات: ${r.periodsEarned} من ${r.periods}` : done ? 'تسلّم وانعتمد' : 'لسا ما تسلّم';
  const actions = [];
  if (mine && !done) {
    actions.push(
      r.openEarnId
        ? h('span', { class: 'muted small-text', text: 'طلب الاعتماد بيستنى الشركاء.' })
        : askForm(r.kind === 'service' ? 'اطلب اعتماد الفترة' : 'اطلب اعتماد التسليم', 'شو سلّمت؟ (بيشوفه الشركاء قبل ما يعتمدوا)', 'ابعت للاعتماد', (text) => backend.op('requestEarning', { projectId: p.id, roleId: r.id, note: text }))
    );
  }
  if (mine) actions.push(opButton('تنازل عن الدور', 'ghost', () => backend.op('requestRemoval', { projectId: p.id, roleId: r.id, reason: 'تنازل' }), { confirm: 'تتنازل عن الدور؟ اللي كسبته منه بيضل إلك.' }));
  else if (r.holderUid) {
    actions.push(askForm('اطلب سحب الدور', 'السبب (مثلًا: غاب، أو ما التزم)', 'ابعت الطلب للشركاء', (text) => backend.op('requestRemoval', { projectId: p.id, roleId: r.id, reason: text }), { required: true, cls: 'bad' }));
  }
  return h(
    'article',
    { class: 'item' },
    h(
      'div',
      { class: 'row between' },
      h('div', { class: 'row' }, h('strong', { text: r.name }), chip(ROLE_KINDS[r.kind], 'info'), done ? chip('مكتسب', 'good') : null),
      h('span', { class: 'small-text' }, 'صاحب الدور: ', r.holderUid ? h('bdi', { text: p.names[r.holderUid] }) : h('span', { class: 'muted', text: 'فاضي' }))
    ),
    r.note ? h('p', { class: 'msg-text muted', text: r.note }) : null,
    h('span', { class: 'muted small-text', text: `الوزن: ${r.weight} نقطة · انكسب: ${fmtNum(r.earnedPoints)} · ${progressText}` }),
    h('div', { class: 'row' }, actions)
  );
}

// محرر الميثاق (للقائد)
function charterEditor(p, roles) {
  const rowsHost = h('div', { class: 'list' });
  const holderOptions = [['', 'فاضي'], ...p.participants.map((u) => [u, p.names[u]])];
  function addRow(r) {
    const periods = field('عدد الفترات', h('input', { class: 'input', type: 'number', 'data-f': 'periods', min: '1', max: '60', value: String(r.periods || 6) }));
    const kind = select('', Object.entries(ROLE_KINDS), r.kind || 'production', {
      'data-f': 'kind',
      onChange: (ev) => {
        periods.hidden = ev.target.value !== 'service';
      }
    });
    periods.hidden = (r.kind || 'production') !== 'service';
    const row = h(
      'div',
      { class: 'item', 'data-id': r.id || '' },
      h(
        'div',
        { class: 'row' },
        field('اسم الدور', h('input', { class: 'input', 'data-f': 'name', maxlength: '60', value: r.name || '', placeholder: 'مثلًا: البرمجة، الرسم، التسويق' })),
        field('النوع', kind),
        field('صاحب الدور', select('', holderOptions, r.holderUid || '', { 'data-f': 'holderUid' }))
      ),
      h('div', { class: 'row' }, field('الوزن (نقاط)', h('input', { class: 'input', type: 'number', 'data-f': 'weight', min: '1', max: '1000', value: String(r.weight || 10) })), periods),
      field('وصف الدور والتزامه (شو المطلوب بالضبط)', h('input', { class: 'input', 'data-f': 'note', maxlength: '300', value: r.note || '' })),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn bad small',
            type: 'button',
            onClick: () => {
              if (r.earnedPoints && !window.confirm('هاد الدور انكسب منه نقاط. إذا انحذف، النقاط بتضل لأصحابها. نكمل؟')) return;
              row.remove();
            }
          },
          'احذف الدور'
        )
      )
    );
    rowsHost.append(row);
  }
  roles.forEach(addRow);
  if (!roles.length) addRow({});
  const ruleBox = h(
    'div',
    { class: 'choice-group', role: 'radiogroup', 'aria-label': 'قاعدة القرار' },
    Object.entries(RULES).map(([key, label]) => h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'rule', value: key, checked: key === p.decisionRule }), label))
  );
  return h(
    'form',
    {
      class: 'card stack',
      onSubmit: act(async (ev, form) => {
        const list = Array.from(rowsHost.children).map((row) => {
          const f = (name) => row.querySelector(`[data-f="${name}"]`).value;
          const out = { name: f('name'), kind: f('kind'), holderUid: f('holderUid') || null, weight: Number(f('weight')), periods: Number(f('periods')), note: f('note') };
          if (row.dataset.id) out.id = row.dataset.id;
          return out;
        });
        if (p.charterVersion > 0 && p.participants.length > 1 && !window.confirm('حفظ الميثاق بيرجّع التواقيع من الأول، والشغل بيوقف لحد ما يوقّع الكل. نكمل؟')) return;
        await backend.op('saveCharter', { projectId: p.id, decisionRule: formValues(form).rule, roles: list });
        toast('انحفظ الميثاق');
        await render();
      })
    },
    h('h2', { text: 'عدّل الميثاق (للقائد)' }),
    h('p', { class: 'muted small-text', text: 'وزّع الأدوار حسب التخصصات: أدوار إنتاج (برمجة، رسم، سيناريو) بتنكسب بالتسليم، وأدوار خدمة (تسويق، إدارة مجتمع) بتنكسب على فترات. الوزن هو حصة الدور من النقاط.' }),
    rowsHost,
    h('div', { class: 'row' }, h('button', { class: 'btn ghost small', type: 'button', onClick: () => addRow({}) }, 'أضف دور')),
    h('span', { class: 'label', text: 'قاعدة القرار' }),
    ruleBox,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'احفظ الميثاق'))
  );
}

function charterTab(p, roles, earnings) {
  const me = state.user.uid;
  const solo = p.participants.length === 1;
  const signed = charterSigned(p);
  const status = solo
    ? h('p', { class: 'notice', text: 'إنت المشارك الوحيد، فما في حاجة لميثاق. لما تعزم مشاركين، اكتبوا الأدوار ووقّعوا.' })
    : h(
        'section',
        { class: 'card stack' },
        h('div', { class: 'row between' }, h('h2', { text: `ميثاق المشروع (نسخة ${p.charterVersion})` }), signed ? chip('موقّع من الكل', 'good') : chip('بيستنى تواقيع', 'bad')),
        h('div', { class: 'decisions' }, p.participants.map((u) => chip(p.names[u] + (p.charterSignatures[u] ? ': وقّع' : ': لسا'), p.charterSignatures[u] ? 'good' : ''))),
        h('span', { class: 'small-text' }, 'قاعدة القرار: ', h('strong', { text: RULES[p.decisionRule] })),
        h('span', { class: 'muted small-text', text: `نسبة الاستوديو من العمل: ${p.studioSharePct}%. الباقي بيتوزع حسب النقاط المكتسبة.` }),
        p.charterVersion === 0
          ? h('p', { class: 'notice', text: p.leadUid === me ? 'اكتب الأدوار تحت واحفظ الميثاق، وبعدها بيوقّع الكل.' : 'القائد لسا ما كتب الميثاق.' })
          : !p.charterSignatures[me]
            ? h('div', { class: 'row' }, opButton('أوافق على الميثاق وأوقّع', '', () => backend.op('signCharter', { projectId: p.id }), { done: 'وقّعت الميثاق' }))
            : null,
        signed ? null : h('p', { class: 'muted small-text', text: 'الاتفاقات والتسليم والنشر بتشتغل بس بعد ما يوقّع كل المشاركين.' })
      );
  return h(
    'div',
    { class: 'stack' },
    status,
    sharesTable(p, roles),
    roles.length ? h('section', { class: 'stack' }, h('h2', { text: 'الأدوار' }), h('div', { class: 'list' }, roles.map((r) => roleItem(p, r)))) : null,
    p.leadUid === me ? charterEditor(p, roles) : null,
    earnings.length
      ? h(
          'details',
          { class: 'card' },
          h('summary', { text: `سجل الكسب (${earnings.length})` }),
          h('div', { class: 'list' }, earnings.map((e) => h('div', { class: 'item' }, h('span', null, h('bdi', { text: e.username }), ` كسب ${fmtNum(e.points)} نقطة من «${e.roleName}»`), e.note ? h('span', { class: 'muted small-text', text: e.note }) : null, h('span', { class: 'muted small-text', text: fmtTime(e.at) }))))
        )
      : null
  );
}

// ---------- الاتفاقات ----------
function agreementsTab(p, roles, agreements) {
  const me = state.user.uid;
  if (!roles.length) return h('div', { class: 'empty' }, 'الاتفاقات بتكون بين الأدوار. ', h('a', { href: `#/p/${p.id}/charter`, text: 'اكتبوا الأدوار بالميثاق أول' }));
  const roleOptions = [['', 'اختار دور'], ...roles.map((r) => [r.id, r.name + (r.holderUid ? ` (${p.names[r.holderUid]})` : '')])];
  const holderOf = (roleId) => {
    const r = roles.find((x) => x.id === roleId);
    return r ? r.holderUid : null;
  };
  const form = h(
    'form',
    {
      class: 'card stack',
      onSubmit: act(async (ev, formEl) => {
        const r = await backend.op('proposeAgreement', { projectId: p.id, ...formValues(formEl) });
        toast(r.status === 'proposed' ? 'انقترح الاتفاق، وانبعت للموافقة' : 'انضاف الاتفاق');
        await render();
      })
    },
    h('h2', { text: 'اقترح اتفاق' }),
    h('p', { class: 'muted small-text', text: 'إشي دور بيقدّمه ودور ثاني بيعتمد عليه: حدث، دالة، شكل ملف، موعد تسليم، أو قاعدة زي «اللاعب بيقفز مترين» أو «السيناريو نسخة 3 مقفول».' }),
    field('العنوان', h('input', { class: 'input', name: 'title', maxlength: '120', required: true })),
    field('التفاصيل', h('textarea', { class: 'input', name: 'description', maxlength: '2000' })),
    h('div', { class: 'row' }, field('الدور اللي بيقدّمه', select('fromRoleId', roleOptions, '', { required: true })), field('الدور اللي بيعتمد عليه', select('toRoleId', roleOptions, '', { required: true }))),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'اقترح'))
  );
  const items = agreements.map((g) => {
    const fromHolder = holderOf(g.fromRoleId);
    const toHolder = holderOf(g.toRoleId);
    const setStatus = (status) => () => backend.op('setAgreementStatus', { projectId: p.id, agreementId: g.id, status });
    return h(
      'article',
      { class: 'item' },
      h('div', { class: 'row between' }, h('strong', { text: g.title }), chip(STATUS[g.status][0], STATUS[g.status][1])),
      h('span', { class: 'muted small-text', text: `${g.fromRoleName} ← ${g.toRoleName} · اقترحه ${g.createdByName}` }),
      g.description ? h('p', { class: 'msg-text', text: g.description }) : null,
      g.status === 'proposed' ? h('span', { class: 'muted small-text' }, 'بيستنى موافقة. ', h('a', { href: `#/p/${p.id}/approvals`, text: 'شوف الموافقات' })) : null,
      h(
        'div',
        { class: 'row' },
        g.status === 'agreed' && (!fromHolder || fromHolder === me) ? opButton('علّمه منفّذ', '', setStatus('implemented')) : null,
        g.status === 'implemented' && (!toHolder || toHolder === me) ? opButton('جرّبته، اعتمده', 'good', setStatus('approved')) : null,
        h(
          'details',
          null,
          h('summary', { class: 'small-text', text: 'عدّل (بيرجع للموافقة)' }),
          h(
            'form',
            {
              class: 'stack',
              onSubmit: act(async (ev, formEl) => {
                await backend.op('editAgreement', { projectId: p.id, agreementId: g.id, ...formValues(formEl) });
                toast('تعدّل الاتفاق ورجع للموافقة');
                await render();
              })
            },
            field('العنوان', h('input', { class: 'input', name: 'title', maxlength: '120', required: true, value: g.title })),
            field('التفاصيل', h('textarea', { class: 'input', name: 'description', maxlength: '2000', value: g.description })),
            h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'احفظ التعديل'))
          )
        )
      )
    );
  });
  return h(
    'div',
    { class: 'stack' },
    charterSigned(p) ? form : h('p', { class: 'notice', text: 'الميثاق لازم يتوقّع من الكل قبل اقتراح اتفاقات.' }),
    agreements.length ? h('div', { class: 'list' }, items) : h('div', { class: 'empty', text: 'ما في اتفاقات لسا.' })
  );
}

// ---------- الموافقات ----------
function approvalsTab(p, approvals) {
  const me = state.user.uid;
  const decisionChip = (a, uid) => {
    const d = a.decisions[uid];
    return chip((p.names[uid] || 'مشارك سابق') + ': ' + (d === 'yes' ? 'وافق' : d === 'no' ? 'رفض' : 'بيستنى'), d === 'yes' ? 'good' : d === 'no' ? 'bad' : '');
  };
  const open = approvals.filter((a) => a.status === 'open');
  const closed = approvals.filter((a) => a.status !== 'open').slice(0, 30);
  const canForce = (a) => p.decisionRule === 'lead' && p.leadUid === me && a.payload.subjectUid !== me;
  const decide = (a, decision, force) => () => backend.op('decideApproval', { projectId: p.id, approvalId: a.id, decision, force: !!force });
  return h(
    'div',
    { class: 'stack' },
    h('h2', { text: 'بتستنى قرار' }),
    open.length
      ? h(
          'div',
          { class: 'list' },
          open.map((a) =>
            h(
              'article',
              { class: 'item' },
              h('strong', { text: a.summary }),
              a.detail ? h('p', { class: 'msg-text muted', text: a.detail }) : null,
              h('span', { class: 'muted small-text', text: `طلبه ${a.createdByName} · ${fmtTime(a.createdAt)}` }),
              h('div', { class: 'decisions' }, a.required.map((uid) => decisionChip(a, uid))),
              a.required.includes(me) && !a.decisions[me]
                ? h('div', { class: 'row' }, opButton('موافق', 'good', decide(a, 'yes'), { done: 'وافقت' }), opButton('رافض', 'bad', decide(a, 'no'), { done: 'رفضت' }))
                : null,
              canForce(a)
                ? h(
                    'div',
                    { class: 'row' },
                    h('span', { class: 'muted small-text', text: 'كقائد، بتقدر تحسم:' }),
                    opButton('احسم بالموافقة', 'ghost', decide(a, 'yes', true), { confirm: 'تحسم الطلب بالموافقة بدون استنى الباقين؟' }),
                    opButton('احسم بالرفض', 'ghost', decide(a, 'no', true), { confirm: 'تحسم الطلب بالرفض؟' })
                  )
                : null
            )
          )
        )
      : h('div', { class: 'empty', text: 'ما في طلبات مفتوحة.' }),
    closed.length ? h('h2', { text: 'انحسمت' }) : null,
    closed.length
      ? h(
          'div',
          { class: 'list' },
          closed.map((a) =>
            h(
              'div',
              { class: 'item' },
              h('div', { class: 'row between' }, h('span', { text: a.summary }), chip(CLOSED[a.status][0] + (a.forcedBy ? ' (حسم القائد)' : ''), CLOSED[a.status][1])),
              h('div', { class: 'decisions' }, a.required.map((uid) => decisionChip(a, uid)))
            )
          )
        )
      : null
  );
}

// ---------- التجارب والنشر ----------
function publishFields(p, work) {
  return [
    field(work ? 'اسم العمل (فاضي = بيضل نفسه)' : 'اسم العمل', h('input', { class: 'input', name: 'title', maxlength: '80', required: !work })),
    field('الوصف', h('textarea', { class: 'input', name: 'description', maxlength: '2000', value: work ? work.description : '' })),
    p.kind === 'video' ? null : field('طريقة الاستخدام', h('input', { class: 'input', name: 'controls', maxlength: '500', value: work ? work.controls : '' }))
  ];
}

function trialsTab(p, trials, work) {
  const me = state.user.uid;
  const video = p.kind === 'video';
  const progress = uploadProgress();
  const signed = charterSigned(p);
  const afterPublish = (r) => toast(r.status === 'approved' ? 'انتشر بالمتجر!' : 'انبعت طلب النشر. بينتشر لما يوافق كل المشاركين.');
  const published = work
    ? h('div', { class: 'card row between' }, h('span', null, 'منشور بالمتجر: ', h('strong', { text: work.title })), h('a', { class: 'btn ghost small', href: '#/work/' + work.id, text: 'افتح صفحته وسيرفره' }))
    : null;
  const openNote = p.openPublishId ? h('p', { class: 'notice' }, 'في طلب نشر مفتوح. ', h('a', { href: `#/p/${p.id}/approvals`, text: 'شوف الموافقات' })) : null;
  const uploadForm = video
    ? null
    : h(
        'form',
        {
          class: 'card stack',
          onSubmit: act(async (ev, form) => {
            try {
              await backend.addTrial(p.id, form.elements.file.files[0], formValues(form).note, progress.track);
              toast('انرفعت النسخة التجريبية');
              await render();
            } finally {
              progress.hide();
            }
          })
        },
        h('h2', { text: 'ارفع نسخة للتجربة' }),
        h('p', { class: 'muted small-text', text: 'ملف zip فيه index.html. النسخ المرفوعة بس هي اللي بتنتشر بالمتجر.' }),
        h('div', { class: 'row' }, field('الملف', h('input', { class: 'input', type: 'file', name: 'file', accept: '.zip,application/zip', required: true })), field('شو الجديد فيها؟', h('input', { class: 'input', name: 'note', maxlength: '300' }))),
        progress.el,
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'ارفع'))
      );
  const linkForm = h(
    'details',
    { class: 'card' },
    h('summary', { text: video ? 'شارك رابط معاينة للفريق' : 'أو شارك رابط تجربة (مثلًا GitHub Pages)' }),
    h(
      'form',
      {
        class: 'stack',
        onSubmit: act(async (ev, form) => {
          await backend.op('addTrialLink', { projectId: p.id, ...formValues(form) });
          toast('انضاف الرابط');
          await render();
        })
      },
      h('div', { class: 'row' }, field('الرابط', h('input', { class: 'input', name: 'url', dir: 'ltr', required: true, placeholder: 'https://...' })), field('ملاحظة', h('input', { class: 'input', name: 'note', maxlength: '300' }))),
      h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'أضف'))
    )
  );
  const videoPublish =
    video && signed && !p.openPublishId
      ? h(
          'form',
          {
            class: 'card stack',
            onSubmit: act(async (ev, form) => {
              afterPublish(await backend.op('requestPublish', { projectId: p.id, ...formValues(form) }));
              await render();
            })
          },
          h('h2', { text: work ? 'انشر حلقة جديدة' : 'انشر العمل بالمعرض' }),
          h('p', { class: 'muted small-text', text: 'الفيديو بينحط على YouTube أو Vimeo، وهون بتحطوا رابطه. النشر بدّه موافقة كل المشاركين.' }),
          publishFields(p, work),
          field('عنوان الحلقة أو الفيلم', h('input', { class: 'input', name: 'episodeTitle', maxlength: '120', required: true })),
          field('رابط الفيديو (YouTube أو Vimeo)', h('input', { class: 'input', name: 'videoUrl', dir: 'ltr', required: true })),
          h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'اطلب النشر'))
        )
      : null;
  const items = trials.map((t) => {
    const url = t.buildId ? backend.playUrl(t.buildId, t.entry) : t.url;
    const live = work && t.buildId && work.buildId === t.buildId;
    return h(
      'article',
      { class: 'item' },
      h('div', { class: 'row between' }, h('strong', { text: t.note || 'نسخة تجريبية' }), h('div', { class: 'row' }, live ? chip('المنشورة هلأ', 'good') : null, chip(t.buildId ? 'مرفوعة' : 'رابط', t.buildId ? 'accent' : ''))),
      h('span', { class: 'muted small-text', text: `${t.byName} · ${fmtTime(t.at)}` }),
      h(
        'div',
        { class: 'row' },
        externalLink(url, 'جرّب', 'btn small'),
        t.buildId && signed && !p.openPublishId && !live
          ? h(
              'details',
              null,
              h('summary', { class: 'small-text', text: work ? 'انشرها كتحديث' : 'اطلب نشرها بالمتجر' }),
              h(
                'form',
                {
                  class: 'stack',
                  onSubmit: act(async (ev, form) => {
                    afterPublish(await backend.op('requestPublish', { projectId: p.id, trialId: t.id, ...formValues(form) }));
                    await render();
                  })
                },
                publishFields(p, work),
                h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'اطلب النشر'))
              )
            )
          : null,
        (t.by === me || p.leadUid === me) && !live ? opButton('احذف', 'ghost', () => backend.op('deleteTrial', { projectId: p.id, trialId: t.id }), { confirm: 'تحذف هالنسخة؟' }) : null
      )
    );
  });
  return h(
    'div',
    { class: 'stack' },
    published,
    openNote,
    signed ? null : h('p', { class: 'notice', text: 'النشر بدّه ميثاق موقّع من كل المشاركين.' }),
    videoPublish,
    uploadForm,
    linkForm,
    trials.length ? h('div', { class: 'list' }, items) : h('div', { class: 'empty', text: 'ما في نسخ تجريبية لسا.' })
  );
}

// ---------- الإعدادات والمشاركون ----------
function settingsTab(p) {
  const me = state.user.uid;
  const lead = p.leadUid === me;
  const others = p.participants.filter((u) => u !== me);
  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card stack' },
      h('h2', { text: 'الكود' }),
      p.repoUrl
        ? h('div', { class: 'row' }, h('a', { class: 'btn', href: 'vscode://vscode.git/clone?url=' + encodeURIComponent(p.repoUrl), text: 'افتح بـVS Code' }), externalLink(p.repoUrl, 'المستودع على GitHub', 'btn ghost'))
        : h('p', { class: 'muted small-text', text: 'ما في رابط مستودع. القائد بيقدر يضيفه تحت.' }),
      h('p', { class: 'muted small-text' }, 'لربط مساعد الـAI تبعك بالمشروع: ', h('a', { href: '#/settings', text: 'الإعدادات ← ربط المساعد' })),
      lead
        ? h(
            'form',
            {
              class: 'stack',
              onSubmit: act(async (ev, form) => {
                await backend.op('updateProject', { projectId: p.id, ...formValues(form) });
                toast('انحفظ');
                await render();
              })
            },
            h('div', { class: 'row' }, field('اسم المشروع', h('input', { class: 'input', name: 'name', maxlength: '80', required: true, value: p.name })), field('رابط المستودع على GitHub', h('input', { class: 'input', name: 'repoUrl', dir: 'ltr', value: p.repoUrl, placeholder: 'https://github.com/...' }))),
            h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'احفظ'))
          )
        : null
    ),
    h(
      'section',
      { class: 'card stack' },
      h('h2', { text: 'المشاركون' }),
      h(
        'div',
        { class: 'list' },
        p.participants.map((u) =>
          h(
            'div',
            { class: 'item' },
            h('div', { class: 'row between' }, h('strong', null, h('bdi', { text: p.names[u] })), h('div', { class: 'row' }, u === p.leadUid ? chip('القائد', 'accent') : null, u === me ? chip('إنت') : null)),
            u !== me && u !== p.leadUid
              ? h(
                  'div',
                  { class: 'row' },
                  lead ? opButton('انقله القيادة', 'ghost', () => backend.op('transferLead', { projectId: p.id, toUid: u }), { confirm: `تنقل قيادة المشروع لـ${p.names[u]}؟` }) : null,
                  askForm('اطلب شيله من المشروع', 'السبب', 'ابعت الطلب للشركاء', (text) => backend.op('requestRemoval', { projectId: p.id, targetUid: u, reason: text }), { required: true, cls: 'bad' })
                )
              : null
          )
        ),
        p.invites.map((u) => h('div', { class: 'item' }, h('div', { class: 'row between' }, h('strong', null, h('bdi', { text: p.names[u] })), chip('معزوم، لسا ما رد'))))
      ),
      lead
        ? h(
            'form',
            {
              class: 'row',
              onSubmit: act(async (ev, form) => {
                await backend.op('inviteToProject', { projectId: p.id, username: formValues(form).username });
                toast('انبعتت الدعوة');
                await render();
              })
            },
            field('اعزم مشارك باسم المستخدم (حتى لو مش عضو بالاستوديو)', h('input', { class: 'input', name: 'username', required: true })),
            h('button', { class: 'btn ghost', type: 'submit' }, 'اعزم')
          )
        : h('p', { class: 'muted small-text', text: 'القائد هو اللي بيعزم مشاركين جدد.' })
    ),
    others.length
      ? h(
          'div',
          { class: 'row' },
          opButton('اطلع من المشروع', 'bad', async () => {
            await backend.op('leaveProject', { projectId: p.id });
            location.hash = '#/studios';
          }, { confirm: 'تطلع من المشروع؟ أدوارك بتفضى، وحصصك المكتسبة بتضل إلك.' })
        )
      : null
  );
}

// المعزوم بيشوف الميثاق قبل ما يقرر
function invitedView(p, roles) {
  const respond = (accept) => async () => {
    await backend.op('respondProjectInvite', { projectId: p.id, accept });
    if (accept) location.hash = `#/p/${p.id}/charter`;
    else location.hash = '#/studios';
  };
  return h(
    'div',
    { class: 'stack' },
    h('h1', { text: 'دعوة لمشروع ' + p.name }),
    h('p', { class: 'muted', text: `${KIND_NAMES[p.kind]} · الاستوديو: ${p.studioName} · القائد: ${p.names[p.leadUid]}` }),
    h('p', { class: 'muted', text: 'المشاركون: ' + p.participants.map((u) => p.names[u]).join('، ') }),
    h(
      'section',
      { class: 'card stack' },
      h('h2', { text: 'الميثاق الحالي' }),
      h('span', { class: 'small-text' }, 'قاعدة القرار: ', h('strong', { text: RULES[p.decisionRule] })),
      h('span', { class: 'muted small-text', text: `نسبة الاستوديو: ${p.studioSharePct}%` }),
      roles.length
        ? h(
            'table',
            { class: 'layers-table' },
            h('thead', null, h('tr', null, h('th', { text: 'الدور' }), h('th', { text: 'صاحبه' }), h('th', { text: 'الوزن' }))),
            h('tbody', null, roles.map((r) => h('tr', null, h('td', { text: `${r.name} (${ROLE_KINDS[r.kind]})` }), h('td', { text: r.holderUid ? p.names[r.holderUid] : 'فاضي' }), h('td', { text: String(r.weight) }))))
          )
        : h('p', { class: 'muted small-text', text: 'لسا ما في أدوار مكتوبة.' })
    ),
    h('p', { class: 'notice', text: 'بعد ما تقبل، القائد بيحدد دورك بالميثاق، وبتوقّعوه كلكم.' }),
    h('div', { class: 'row' }, opButton('اقبل وانضم', '', respond(true)), opButton('ارفض الدعوة', 'bad', respond(false), { confirm: 'ترفض الدعوة؟' }))
  );
}

// ---------- مساحة عمل المشروع ----------
export async function viewProject(id, tabArg) {
  if (!state.user) return { ...needLogin(), nav: 'studios' };
  const p = await backend.getProject(id);
  if (!p) return { el: messageBox('المشروع مش موجود، أو إنت مش مشارك فيه.', h('a', { href: '#/studios', text: 'رجوع' })), nav: 'studios' };
  const me = state.user.uid;
  if (!p.participants.includes(me)) return { el: invitedView(p, await backend.listRoles(id)), nav: 'studios' };

  const approvals = await backend.listApprovals(id);
  const waiting = approvals.filter((a) => a.status === 'open' && a.required.includes(me) && !a.decisions[me]).length;
  const needSign = p.participants.length > 1 && p.charterVersion > 0 && !p.charterSignatures[me];
  const tabs = [
    { id: 'chat', label: '# المحادثة' },
    { id: 'charter', label: 'الميثاق والحصص', badge: needSign ? 1 : 0 },
    { id: 'agreements', label: 'الاتفاقات' },
    { id: 'approvals', label: 'الموافقات', badge: waiting },
    { id: 'trials', label: 'التجارب والنشر' },
    { id: 'log', label: 'السجل' },
    { id: 'settings', label: 'المشاركون والإعدادات' }
  ];
  const tab = tabs.find((t) => t.id === tabArg) ? tabArg : 'chat';
  let chat = null;
  let body;
  let headTitle = tabs.find((t) => t.id === tab).label;
  let headHint = '';
  if (tab === 'chat') {
    chat = chatPanel('projects/' + id, { id: 'general', name: 'محادثة المشروع' }, { canPost: true });
    body = chat.el;
    headTitle = null;
  } else if (tab === 'charter') {
    headHint = 'مين مسؤول عن شو، وكم وزن كل دور، وكيف بتنكسب الحصة، ومين بيحسم.';
    const [roles, earnings] = await Promise.all([backend.listRoles(id), backend.listEarnings(id)]);
    body = charterTab(p, roles, earnings);
  } else if (tab === 'agreements') {
    headHint = 'شو كل دور بيوعد فيه الأدوار الثانية. «متفق عليه» ما بيعني «جاهز».';
    const [roles, agreements] = await Promise.all([backend.listRoles(id), backend.listAgreements(id)]);
    body = agreementsTab(p, roles, agreements);
  } else if (tab === 'approvals') {
    headHint = 'اتفاقات جديدة، وتسليم أدوار، وطلبات نشر، وسحب أدوار.';
    body = approvalsTab(p, approvals);
  } else if (tab === 'trials') {
    headHint = 'نسخ للتجربة بين الفريق، ومنها بتطلبوا النشر بالمتجر.';
    const [trials, work] = await Promise.all([backend.listTrials(id), p.workId ? backend.getWork(p.workId) : null]);
    body = trialsTab(p, trials, work);
  } else if (tab === 'log') {
    headHint = 'مين عمل شو ومتى. بينكتب تلقائيًا وما حدا بيعدّله.';
    body = logList(await backend.listProjectLog(id));
  } else {
    body = settingsTab(p);
  }
  const sideExtra = [
    h('span', { class: 'group', text: 'المشاركون' }),
    p.participants.map((u) => h('div', { class: 'member' }, h('span', { class: 'avatar', 'aria-hidden': 'true', text: p.names[u].charAt(0) }), h('bdi', { text: p.names[u] }), u === p.leadUid ? chip('قائد', 'accent') : null)),
    h('a', { class: 'channel-btn', href: '#/s/' + p.studioId, text: 'الاستوديو: ' + p.studioName })
  ];
  const el = workspace({
    title: p.name,
    subtitle: KIND_NAMES[p.kind] + ' · مشروع خاص بالمشاركين',
    baseHash: '#/p/' + id,
    tabs,
    active: tab,
    sideExtra,
    body,
    headTitle,
    headHint
  });
  // الشات بيتحدث لحاله؛ باقي الأقسام بتتحدث لما يتغيّر إشي عند الشركاء
  const stopWatch = backend.watchProject(id, tab === 'chat' ? () => {} : softRefresh);
  return {
    el,
    nav: 'studios',
    destroy() {
      stopWatch();
      if (chat) chat.destroy();
    }
  };
}
