// لوحة الفرص: أدوار مفتوحة بتنشرها الاستوديوهات، والناس بتتقدم إلها.
import { backend } from './backend.js';
import { state, render, h, toast, act, opButton, field, formValues, select, chip, fmtTime } from './ui.js';

const ROLE_KINDS = { production: 'إنتاج', service: 'خدمة' };

function roleHead(r) {
  return h(
    'div',
    { class: 'row between' },
    h('div', { class: 'row' }, h('strong', { text: r.title }), chip(ROLE_KINDS[r.kind] || '', 'info')),
    h('span', { class: 'muted small-text', text: fmtTime(r.createdAt) })
  );
}

// ---------- اللوحة العامة ----------
export async function viewBoard() {
  const roles = await backend.listOpenRoles();
  const me = state.user ? state.user.uid : null;
  const cards = await Promise.all(
    roles.map(async (r) => {
      const mine = me ? await backend.myApplication(r.id) : null;
      let action;
      if (!me) action = h('a', { class: 'btn small', href: '#/login', text: 'سجّل دخول عشان تتقدم' });
      else if (mine) action = h('span', { class: 'muted small-text', text: 'تقدّمت لهاد الدور. إذا اختاروك، بتوصلك دعوة بصفحة «استوديوهاتي».' });
      else {
        action = h(
          'details',
          null,
          h('summary', { class: 'small-text', text: 'تقدّم للدور' }),
          h(
            'form',
            {
              class: 'stack',
              onSubmit: act(async (ev, form) => {
                await backend.op('applyToRole', { roleId: r.id, message: formValues(form).message });
                toast('وصل طلبك للاستوديو');
                await render();
              })
            },
            field('رسالة قصيرة: خبرتك، وأعمال سابقة، وليش مناسب', h('textarea', { class: 'input', name: 'message', maxlength: '600', required: true })),
            h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'ابعت'))
          )
        );
      }
      return h(
        'article',
        { class: 'item' },
        roleHead(r),
        h('a', { class: 'small-text', href: '#/studio/' + r.studioId, text: 'الاستوديو: ' + r.studioName }),
        h('p', { class: 'msg-text', text: r.description }),
        action
      );
    })
  );
  const el = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'hero' },
      h(
        'div',
        { class: 'stack tight' },
        h('h1', { text: 'الفرص' }),
        h('p', { class: 'muted', text: 'استوديوهات بتدوّر على شركاء: مبرمجين، رسامين، كتّاب، مسوّقين. تقدّم بتخصصك، وادخل مشروع بدور وحصة.' })
      ),
      h('div', { class: 'row' }, h('a', { class: 'btn ghost', href: '#/studios', text: 'انشر دور من استوديوك' }))
    ),
    cards.length ? h('div', { class: 'list' }, cards) : h('div', { class: 'empty', text: 'ما في أدوار مفتوحة هلأ.' })
  );
  return { el, nav: 'board' };
}

// ---------- قسم «الفرص» بمساحة عمل الاستوديو ----------
export async function studioRolesTab(studio) {
  const roles = (await backend.listOpenRoles()).filter((r) => r.studioId === studio.id);
  const items = await Promise.all(
    roles.map(async (r) => {
      const apps = await backend.listApplications(r.id);
      const people = await Promise.all(
        apps.map(async (a) => {
          const user = await backend.getUser(a.uid);
          return h(
            'div',
            { class: 'item' },
            h('div', { class: 'row between' }, h('strong', null, h('bdi', { text: a.username })), h('span', { class: 'muted small-text', text: fmtTime(a.at) })),
            user && (user.specialties || []).length ? h('div', { class: 'row' }, user.specialties.map((s) => chip(s))) : null,
            h('p', { class: 'msg-text', text: a.message }),
            h('span', { class: 'muted small-text' }, 'عجبك؟ اعزمه لمشروع أو للاستوديو باسم المستخدم: ', h('bdi', { text: a.username }))
          );
        })
      );
      return h(
        'article',
        { class: 'item' },
        roleHead(r),
        h('p', { class: 'msg-text', text: r.description }),
        h('span', { class: 'label', text: `المتقدمين (${apps.length})` }),
        people.length ? h('div', { class: 'list' }, people) : h('span', { class: 'muted small-text', text: 'ما حدا تقدّم لسا.' }),
        h('div', { class: 'row' }, opButton('سكّر الدور', 'ghost', () => backend.op('closeOpenRole', { roleId: r.id }), { confirm: 'تسكّر الدور؟ ما بيضل ظاهر باللوحة.' }))
      );
    })
  );
  return h(
    'div',
    { class: 'stack' },
    h(
      'form',
      {
        class: 'card stack',
        onSubmit: act(async (ev, form) => {
          await backend.op('postOpenRole', { studioId: studio.id, ...formValues(form) });
          toast('انتشر الدور على لوحة الفرص');
          await render();
        })
      },
      h('h2', { text: 'انشر دور مفتوح' }),
      h(
        'div',
        { class: 'row' },
        field('عنوان الدور', h('input', { class: 'input', name: 'title', maxlength: '80', required: true, placeholder: 'مثلًا: مطلوب مصمم شخصيات' })),
        field('النوع', select('kind', Object.entries(ROLE_KINDS), 'production'))
      ),
      field('الوصف: المشروع، والمطلوب، والالتزام، والحصة المتوقعة', h('textarea', { class: 'input', name: 'description', maxlength: '1000', required: true })),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'انشر'))
    ),
    items.length ? h('div', { class: 'list' }, items) : h('div', { class: 'empty', text: 'ما في أدوار مفتوحة لهاد الاستوديو.' })
  );
}
