// استوديوهاتي، ومساحة عمل الاستوديو (المحادثة، المشاريع، العقد والأعضاء، الفرص، السجل).
import { backend } from './backend.js';
import { state, render, h, toast, act, opButton, field, formValues, select, messageBox, chip, needLogin, logList, chatPanel, workspace, softRefresh } from './ui.js';
import { studioRolesTab } from './board.js';

export const KIND_NAMES = { game: 'لعبة', app: 'برنامج', video: 'عمل مرئي' };

const STUDIO_CLAUSES = [
  'نسبة الاستوديو بتنخصم من كل عمل لصندوق التكاليف المشتركة والاسم. أدوار الاستوديو الدائمة (زي مسوّق الاستوديو) بتاخد منها.',
  'حصص كل مشروع بيحددها ميثاق المشروع نفسه، مش هاد العقد.',
  'إضافة عضو جديد وتعديل هاد العقد بدهم موافقة كل الأعضاء.',
  'اللي بيطلع من الاستوديو بتضل إله حصصه المكتسبة بالمشاريع.',
  'الشغل اللي بيجيبه كل عضو من قبل بيضل إله، وللاستوديو حق استخدامه بالمشاريع اللي دخل فيها بس.',
  'السجل بينكتب تلقائيًا وما حدا بيقدر يعدّله.',
  'المنصة ما بتملك إشي من شغل الاستوديو.',
  'هلأ كل الأعمال مجانية. توزيع الأرباح حسب الحصص بيتفعّل لما تنضاف المدفوعات.'
];

function statusChip(studio) {
  if (studio.kind === 'personal') return chip('شخصي');
  return studio.status === 'active' ? chip('مفتوح', 'good') : chip('بيستنى توقيع العقد', 'accent');
}

function projectCard(p) {
  const me = state.user.uid;
  const signed = p.participants.length === 1 || p.participants.every((u) => p.charterSignatures[u]);
  return h(
    'a',
    { class: 'game-card', href: '#/p/' + p.id },
    h('div', { class: 'row between' }, h('strong', { text: p.name }), chip(KIND_NAMES[p.kind])),
    h('span', { class: 'muted small-text', text: 'الاستوديو: ' + p.studioName }),
    h('span', { class: 'muted small-text', text: 'المشاركون: ' + p.participants.map((u) => p.names[u]).join('، ') }),
    h('div', { class: 'row' }, p.leadUid === me ? chip('إنت القائد', 'accent') : null, signed ? null : chip('الميثاق بدّه توقيع', 'bad'), p.workId ? chip('منشور', 'good') : null)
  );
}

function projectForm(studio) {
  return h(
    'form',
    {
      class: 'card stack',
      onSubmit: act(async (ev, form) => {
        const v = formValues(form);
        const r = await backend.op('createProject', {
          studioId: studio.id,
          name: v.name,
          kind: v.kind,
          repoUrl: v.repoUrl,
          includeMembers: form.elements.includeMembers ? form.elements.includeMembers.checked : true
        });
        location.hash = '#/p/' + r.projectId + '/charter';
      })
    },
    h('h2', { text: 'مشروع جديد' }),
    h('div', { class: 'row' }, field('اسم المشروع', h('input', { class: 'input', name: 'name', maxlength: '80', required: true })), field('النوع', select('kind', Object.entries(KIND_NAMES), 'game'))),
    field('رابط مستودع الكود على GitHub (اختياري)', h('input', { class: 'input', name: 'repoUrl', dir: 'ltr', placeholder: 'https://github.com/...' })),
    studio.kind === 'shared'
      ? h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'includeMembers', checked: true }), 'دخّل كل أعضاء الاستوديو بالمشروع')
      : h('p', { class: 'muted small-text', text: 'بعد الإنشاء بتقدر تعزم مشاركين للمشروع باسم المستخدم، حتى لو مش أعضاء باستوديو.' }),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'أنشئ المشروع'))
  );
}

// ---------- صفحة «استوديوهاتي» ----------
export async function viewStudios() {
  if (!state.user) return { ...needLogin('الاستوديوهات بدها حساب.'), nav: 'studios' };
  const [studios, mine] = await Promise.all([backend.listMyStudios(), backend.listMyProjects()]);
  const studioCard = (s) =>
    h('a', { class: 'game-card', href: '#/s/' + s.id }, h('div', { class: 'row between' }, h('strong', { text: s.name }), statusChip(s)), h('span', { class: 'muted small-text', text: `${s.members.length} عضو` }));
  const invites = [
    ...studios.invites.map((s) =>
      h('div', { class: 'item' }, h('div', { class: 'row between' }, h('strong', { text: 'دعوة لاستوديو: ' + s.name }), h('a', { class: 'btn small', href: '#/s/' + s.id, text: 'شوف العقد وقرّر' })))
    ),
    ...mine.invites.map((p) =>
      h('div', { class: 'item' }, h('div', { class: 'row between' }, h('strong', { text: 'دعوة لمشروع: ' + p.name }), h('a', { class: 'btn small', href: '#/p/' + p.id, text: 'شوف الميثاق وقرّر' })))
    )
  ];
  const el = h(
    'div',
    { class: 'stack' },
    h('h1', { text: 'استوديوهاتي' }),
    h('p', { class: 'muted', text: 'الاستوديو هو الاسم اللي بتنشر فيه. استوديوك الشخصي إلك لحالك، والاستوديو المشترك بين شركاء بعقد. والمشروع بيجمع مشاركين على عمل واحد، وكل مشروع إله ميثاق بحصصه.' }),
    invites.length ? h('section', { class: 'stack' }, h('h2', { text: 'دعوات إلك' }), h('div', { class: 'list' }, invites)) : null,
    h(
      'section',
      { class: 'stack' },
      h('h2', { text: 'الاستوديوهات' }),
      h('div', { class: 'games-grid' }, studios.personal ? studioCard(studios.personal) : null, studios.shared.map(studioCard))
    ),
    h(
      'section',
      { class: 'stack' },
      h('h2', { text: 'مشاريعي' }),
      mine.projects.length ? h('div', { class: 'games-grid' }, mine.projects.map(projectCard)) : h('div', { class: 'empty', text: 'ما عندك مشاريع لسا. افتح استوديو وأنشئ مشروع.' })
    ),
    h(
      'form',
      {
        class: 'card stack',
        onSubmit: act(async (ev, form) => {
          const v = formValues(form);
          const r = await backend.op('createStudio', { name: v.name, sharePct: Number(v.sharePct) });
          location.hash = '#/s/' + r.studioId + '/contract';
        })
      },
      h('h2', { text: 'أنشئ استوديو مشترك' }),
      h('p', { class: 'muted small-text', text: 'بعد الإنشاء بتعزم شركاءك، بتتفقوا على العقد، وبيوقّع الكل. الاستوديو بيفتح بعد آخر توقيع.' }),
      h(
        'div',
        { class: 'row' },
        field('اسم الاستوديو', h('input', { class: 'input', name: 'name', minlength: '2', maxlength: '40', required: true })),
        field('نسبة الاستوديو من كل عمل (%)', h('input', { class: 'input', type: 'number', name: 'sharePct', min: '0', max: '50', step: '1', value: '10', required: true }))
      ),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'أنشئ'))
    )
  );
  return { el, nav: 'studios' };
}

// ---------- العقد والأعضاء ----------
function contractSummary(contract) {
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'stack tight' }, h('span', { class: 'label', text: 'نسبة الاستوديو من كل عمل' }), h('strong', { text: contract.sharePct + '%' })),
    h('span', { class: 'label', text: 'بنود العقد' }),
    h('ul', { class: 'clauses' }, STUDIO_CLAUSES.map((t) => h('li', { text: t }))),
    h('p', { class: 'muted small-text', text: 'هاد قالب للتجربة. عشان يكون ملزم قانونيًا لازم يراجعه محامي حسب البلد.' })
  );
}

function contractTab(studio, contract) {
  const me = state.user.uid;
  const pending = studio.status === 'pending';
  const name = (uid) => contract.names[uid] || studio.names[uid] || 'مستخدم';
  const joinRequests = contract.joinRequests || {};
  const members = h(
    'section',
    { class: 'card stack' },
    h('h2', { text: 'الأعضاء' }),
    h(
      'div',
      { class: 'list' },
      studio.members.map((uid) =>
        h(
          'div',
          { class: 'item' },
          h('div', { class: 'row between' }, h('strong', null, h('bdi', { text: name(uid) })), contract.signatures[uid] ? chip('وقّع العقد', 'good') : chip('لسا ما وقّع'))
        )
      ),
      studio.invites.map((uid) => {
        const request = joinRequests[uid];
        return h(
          'div',
          { class: 'item' },
          h('div', { class: 'row between' }, h('strong', null, h('bdi', { text: name(uid) })), request ? chip('قبل ووقّع، بيستنى موافقة الأعضاء', 'accent') : chip('معزوم، لسا ما رد')),
          request
            ? h(
                'div',
                { class: 'row' },
                h('span', { class: 'muted small-text', text: 'وافق: ' + (studio.members.filter((m) => request.approvals[m]).map(name).join('، ') || 'ولا حدا لسا') }),
                request.approvals[me] ? null : opButton('وافق على انضمامه', 'good', () => backend.op('approveStudioMember', { studioId: studio.id, memberUid: uid, approve: true })),
                opButton('ارفض', 'bad', () => backend.op('approveStudioMember', { studioId: studio.id, memberUid: uid, approve: false }), { confirm: 'ترفض انضمامه؟' })
              )
            : null
        );
      })
    ),
    h(
      'form',
      {
        class: 'row',
        onSubmit: act(async (ev, form) => {
          await backend.op('inviteToStudio', { studioId: studio.id, username: formValues(form).username });
          toast('انبعتت الدعوة');
          await render();
        })
      },
      field('اعزم شريك باسم المستخدم تبعه', h('input', { class: 'input', name: 'username', required: true })),
      h('button', { class: 'btn ghost', type: 'submit' }, 'اعزم')
    ),
    h('p', { class: 'muted small-text', text: pending ? 'شريكك لازم يعمل حساب بـCilyo أول، وبيلاقي الدعوة بصفحة «استوديوهاتي».' : 'الاستوديو مفتوح، فالعضو الجديد بينضم بس بعد ما يوافق كل الأعضاء.' })
  );

  const proposal = contract.proposal;
  const terms = h(
    'section',
    { class: 'card stack' },
    h('h2', { text: `عقد الاستوديو (نسخة ${contract.version})` }),
    contractSummary(contract),
    h(
      'form',
      {
        class: 'row',
        onSubmit: act(async (ev, form) => {
          const r = await backend.op('setStudioContract', { studioId: studio.id, sharePct: Number(formValues(form).sharePct) });
          toast(r.status === 'proposed' ? 'انبعت التعديل للأعضاء، وبيتطبق لما يوقّع الكل' : 'تعدّل العقد، والتواقيع رجعت من الأول');
          await render();
        })
      },
      field(pending ? 'عدّل نسبة الاستوديو (%)' : 'اقترح نسبة جديدة (%)', h('input', { class: 'input', type: 'number', name: 'sharePct', min: '0', max: '50', step: '1', value: String(contract.sharePct), required: true })),
      h('button', { class: 'btn ghost', type: 'submit' }, pending ? 'عدّل' : 'اقترح')
    ),
    proposal
      ? h(
          'div',
          { class: 'item' },
          h('strong', { text: `تعديل مقترح: نسبة الاستوديو تصير ${proposal.sharePct}% (اقترحه ${name(proposal.by)})` }),
          h('span', { class: 'muted small-text', text: 'وقّع: ' + studio.members.filter((m) => proposal.signatures[m]).map(name).join('، ') }),
          h(
            'div',
            { class: 'row' },
            proposal.signatures[me] ? null : opButton('أوافق وأوقّع', 'good', () => backend.op('signStudioContract', { studioId: studio.id })),
            opButton('ارفض التعديل', 'bad', () => backend.op('signStudioContract', { studioId: studio.id, reject: true }))
          )
        )
      : null
  );

  const sign = pending
    ? h(
        'section',
        { class: 'card stack' },
        h('h2', { text: 'التوقيع' }),
        studio.members.length < 2 ? h('p', { class: 'notice', text: 'لازم يكون بالاستوديو عضوين على الأقل عشان يفتح. اعزم شريكك.' }) : null,
        contract.signatures[me]
          ? h('p', { class: 'muted', text: 'وقّعت على هالنسخة. بنستنى الباقين.' })
          : h(
              'div',
              { class: 'row' },
              h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onClick: act(async () => {
                    const r = await backend.op('signStudioContract', { studioId: studio.id });
                    toast(r.status === 'active' ? 'انفتح الاستوديو!' : 'وقّعت. بنستنى الباقين.');
                    if (r.status === 'active') location.hash = '#/s/' + studio.id + '/projects';
                    else await render();
                  })
                },
                'أوافق على العقد وأوقّع'
              )
            )
      )
    : null;

  const leave = h(
    'div',
    { class: 'row' },
    opButton('اطلع من الاستوديو', 'bad', async () => {
      await backend.op('leaveStudio', { studioId: studio.id });
      location.hash = '#/studios';
    }, { confirm: 'تطلع من الاستوديو؟ حصصك المكتسبة بالمشاريع بتضل إلك.' })
  );
  return h('div', { class: 'stack' }, pending ? h('p', { class: 'notice', text: 'الاستوديو ما بيفتح قبل ما كل الأعضاء يوقّعوا العقد. أي تعديل أو عضو جديد بيرجّع التواقيع من الأول.' }) : null, members, terms, sign, leave);
}

// المعزوم بيشوف العقد قبل ما يقرر
function invitedView(studio, contract) {
  const waiting = contract && contract.joinRequests && contract.joinRequests[state.user.uid];
  const respond = (accept) => async () => {
    const r = await backend.op('respondStudioInvite', { studioId: studio.id, accept });
    if (!accept) location.hash = '#/studios';
    else toast(r.status === 'waiting' ? 'قبلت ووقّعت. بتنضم لما يوافق كل الأعضاء.' : 'انضميت للاستوديو');
  };
  return h(
    'div',
    { class: 'stack' },
    h('h1', { text: 'دعوة لاستوديو ' + studio.name }),
    h('p', { class: 'muted' }, 'الأعضاء: ', studio.members.map((uid) => studio.names[uid]).join('، ')),
    contract ? h('div', { class: 'card stack' }, h('h2', { text: 'العقد' }), contractSummary(contract)) : null,
    waiting
      ? h('p', { class: 'notice', text: 'قبلت الدعوة ووقّعت العقد. بتنضم لما يوافق كل الأعضاء.' })
      : h(
          'div',
          { class: 'stack' },
          h('p', { class: 'notice', text: studio.status === 'pending' ? 'لما تقبل بتنضم، وبعدها بتوقّعوا العقد مع بعض.' : 'الاستوديو مفتوح: قبولك يعني توقيعك على هاد العقد، وبتنضم بعد موافقة كل الأعضاء.' }),
          h('div', { class: 'row' }, opButton('اقبل', '', respond(true)), opButton('ارفض الدعوة', 'bad', respond(false), { confirm: 'ترفض الدعوة؟' }))
        )
  );
}

// ---------- مساحة عمل الاستوديو ----------
export async function viewStudioSpace(id, tabArg) {
  if (!state.user) return { ...needLogin(), nav: 'studios' };
  const studio = await backend.getStudio(id);
  if (!studio) return { el: messageBox('الاستوديو مش موجود.', h('a', { href: '#/studios', text: 'رجوع' })), nav: 'studios' };
  const me = state.user.uid;
  const member = studio.members.includes(me);
  const invited = studio.invites.includes(me);
  if (!member && !invited) return { el: messageBox('هاي المساحة لأعضاء الاستوديو بس.', h('a', { href: '#/studio/' + id, text: 'صفحة الاستوديو العامة' })), nav: 'studios' };
  const shared = studio.kind === 'shared';
  const contract = shared ? await backend.getStudioContract(id) : null;
  const stopWatch = backend.watchStudio(id, shared, softRefresh);
  if (!member) return { el: invitedView(studio, contract), nav: 'studios', destroy: stopWatch };

  const active = studio.status === 'active';
  let tabs;
  if (!shared) tabs = [{ id: 'projects', label: 'المشاريع' }, { id: 'roles', label: 'الفرص' }, { id: 'about', label: 'الاسم' }];
  else if (!active) tabs = [{ id: 'contract', label: 'العقد والأعضاء' }, { id: 'log', label: 'السجل' }];
  else {
    const waiting = Object.keys(contract.joinRequests || {}).filter((uid) => !contract.joinRequests[uid].approvals[me]).length + (contract.proposal && !contract.proposal.signatures[me] ? 1 : 0);
    tabs = [
      { id: 'chat', label: '# المحادثة' },
      { id: 'projects', label: 'المشاريع' },
      { id: 'contract', label: 'العقد والأعضاء', badge: waiting },
      { id: 'roles', label: 'الفرص' },
      { id: 'log', label: 'السجل' }
    ];
  }
  const tab = tabs.find((t) => t.id === tabArg) ? tabArg : tabs[0].id;
  let chat = null;
  let body;
  let headTitle = tabs.find((t) => t.id === tab).label;
  let headHint = '';
  if (tab === 'chat') {
    chat = chatPanel('studios/' + id, { id: 'general', name: 'عام' }, { canPost: true });
    body = chat.el;
    headTitle = null;
  } else if (tab === 'contract') {
    body = contractTab(studio, contract);
    headHint = 'مين الأعضاء، ونسبة الاستوديو، والتوقيع. حصص كل مشروع بميثاقه.';
  } else if (tab === 'projects') {
    const all = (await backend.listMyProjects()).projects.filter((p) => p.studioId === id);
    headHint = 'المشاريع اللي إنت مشارك فيها بهاد الاستوديو.';
    body = h('div', { class: 'stack' }, all.length ? h('div', { class: 'games-grid' }, all.map(projectCard)) : h('div', { class: 'empty', text: 'ما في مشاريع لسا.' }), projectForm(studio));
  } else if (tab === 'roles') {
    headHint = 'انشر دور مفتوح على لوحة الفرص، وشوف مين تقدّم.';
    body = await studioRolesTab(studio);
  } else if (tab === 'log') {
    headHint = 'مين عمل شو ومتى. بينكتب تلقائيًا وما حدا بيعدّله.';
    body = logList(await backend.listStudioLog(id));
  } else {
    headHint = 'الاسم اللي بتنتشر فيه أعمالك.';
    body = h(
      'form',
      {
        class: 'card row',
        onSubmit: act(async (ev, form) => {
          await backend.op('renameStudio', { studioId: id, name: formValues(form).name });
          toast('تغيّر اسم الاستوديو');
          await render();
        })
      },
      field('اسم الاستوديو', h('input', { class: 'input', name: 'name', minlength: '2', maxlength: '40', required: true, value: studio.name })),
      h('button', { class: 'btn', type: 'submit' }, 'احفظ')
    );
  }
  const sideExtra = [
    h('span', { class: 'group', text: 'الأعضاء' }),
    studio.members.map((uid) => h('div', { class: 'member' }, h('span', { class: 'avatar', 'aria-hidden': 'true', text: studio.names[uid].charAt(0) }), h('bdi', { text: studio.names[uid] }))),
    h('a', { class: 'channel-btn', href: '#/studio/' + id, text: 'الصفحة العامة' })
  ];
  const el = workspace({
    title: studio.name,
    subtitle: shared ? (active ? 'استوديو مشترك' : 'بيستنى توقيع العقد') : 'استوديوك الشخصي',
    baseHash: '#/s/' + id,
    tabs,
    active: tab,
    sideExtra,
    body,
    headTitle,
    headHint
  });
  return {
    el,
    nav: 'studios',
    destroy() {
      stopWatch();
      if (chat) chat.destroy();
    }
  };
}
