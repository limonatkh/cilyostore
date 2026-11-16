// أدوات الواجهة المشتركة بين كل الشاشات.
import { backend } from './backend.js';

export const state = { user: null, profile: null, isAdmin: false, sessionError: null };

// app.js بيسجّل دالة إعادة الرسم هون، عشان باقي الملفات تناديها
let rerender = () => {};
export function setRender(fn) {
  rerender = fn;
}
export function render() {
  return rerender();
}

// بيبني عنصر HTML. النص دايمًا بينحط كنص، مش كـHTML، فما في خطر حقن.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else if (k === 'selected') el.selected = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const $toast = document.getElementById('toast');
let toastTimer = null;
export function toast(message, isError) {
  $toast.textContent = message;
  $toast.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $toast.className = 'toast';
  }, 4500);
}

// بيشغّل عملية، بيعطّل الزر لحد ما تخلص، وبيعرض الخطأ إذا صار
export function act(fn) {
  return async (ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    const target = ev && ev.currentTarget;
    const btn = (ev && ev.submitter) || (target && target.tagName === 'BUTTON' ? target : null);
    if (btn) btn.disabled = true;
    try {
      await fn(ev, target);
    } catch (err) {
      toast((err && err.message) || 'صار خطأ', true);
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  };
}

// زر بينفّذ عملية سيرفر وبعدين بيعيد رسم الشاشة
export function opButton(label, cls, run, { confirm, done } = {}) {
  return h(
    'button',
    {
      class: 'btn small ' + (cls || ''),
      type: 'button',
      onClick: act(async () => {
        if (confirm && !window.confirm(confirm)) return;
        await run();
        if (done) toast(done);
        await render();
      })
    },
    label
  );
}

const timeFmt = new Intl.DateTimeFormat('ar', { dateStyle: 'short', timeStyle: 'short' });
export const fmtTime = (t) => (t ? timeFmt.format(new Date(t)) : '');

let fieldCount = 0;
export function field(label, input) {
  input.id = input.id || 'f' + ++fieldCount;
  return h('div', { class: 'field' }, h('label', { for: input.id, text: label }), input);
}

export function formValues(form) {
  const out = {};
  new FormData(form).forEach((v, k) => {
    if (typeof v === 'string') out[k] = v;
  });
  return out;
}

export function select(name, options, current, extra) {
  return h(
    'select',
    { class: 'input', name, ...(extra || {}) },
    options.map(([value, label]) => h('option', { value, selected: value === current, text: label }))
  );
}

export function hashNum(s) {
  let n = 0;
  for (const ch of s) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return n;
}

export function externalLink(url, text, cls) {
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: cls || null, text });
}

export function messageBox(text, ...extra) {
  return h('div', { class: 'empty' }, text, ' ', ...extra);
}

export function chip(text, kind) {
  return h('span', { class: 'chip ' + (kind || ''), text });
}

export function needLogin(message) {
  sessionStorage.setItem('cilyo.next', location.hash || '#/');
  return {
    el: h(
      'div',
      { class: 'card stack narrow' },
      h('h2', { text: 'لازم تسجّل دخول' }),
      h('p', { class: 'muted', text: message || 'سجّل دخول أو اعمل حساب عشان تكمل.' }),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/login', text: 'دخول أو حساب جديد' }))
    )
  };
}

// شريط تقدم الرفع
export function uploadProgress() {
  const bar = h('progress', { class: 'bar', max: '100', value: '0' });
  const label = h('span', { class: 'muted small-text', role: 'status' });
  const el = h('div', { class: 'stack tight', hidden: true }, bar, label);
  return {
    el,
    // بتنحط كـonProgress للرفع
    track(fraction) {
      el.hidden = false;
      if (fraction >= 1) {
        bar.removeAttribute('value');
        label.textContent = 'بنفحص الملف وبنجهّزه… ممكن ياخد دقيقة.';
      } else {
        bar.value = Math.round(fraction * 100);
        label.textContent = `برفع الملف… ${Math.round(fraction * 100)}%`;
      }
    },
    hide() {
      el.hidden = true;
    }
  };
}

// سجل (مين عمل شو ومتى)
export function logList(entries) {
  if (!entries.length) return h('div', { class: 'empty', text: 'السجل فاضي.' });
  return h(
    'div',
    { class: 'list' },
    entries.map((l) =>
      h(
        'div',
        { class: 'item' },
        h('div', { class: 'row between' }, h('strong', null, h('bdi', { text: l.who })), h('span', { class: 'muted small-text', text: fmtTime(l.at) })),
        h('span', { text: l.text })
      )
    )
  );
}

// ---------- المحادثة ----------
// base: 'works/ID' أو 'studios/ID' أو 'projects/ID'
// options: { canPost, lockedText, canDeleteAll }
export function chatPanel(base, channel, options) {
  const list = h('div', { class: 'messages', 'aria-live': 'polite' });
  const canDelete = (m) => !!state.user && (m.uid === state.user.uid || options.canDeleteAll);

  function messageEl(m) {
    const kind = m.system ? 'sys' : m.viaAI ? 'ai' : '';
    return h(
      'div',
      { class: 'msg' },
      h('span', { class: 'avatar ' + kind, 'aria-hidden': 'true', text: m.system ? 'C' : m.viaAI ? 'AI' : (m.author || '?').charAt(0) }),
      h(
        'div',
        { class: 'grow' },
        h(
          'div',
          { class: 'msg-author ' + kind },
          h('bdi', { text: m.author }),
          h('bdi', { class: 'msg-time', text: fmtTime(m.createdAt) }),
          canDelete(m)
            ? h(
                'button',
                {
                  class: 'msg-delete',
                  type: 'button',
                  'aria-label': 'احذف الرسالة',
                  onClick: act(async () => {
                    if (!window.confirm('تحذف هالرسالة؟')) return;
                    await backend.deleteMessage(base, channel.id, m.id);
                  })
                },
                'حذف'
              )
            : null
        ),
        h('div', { class: 'msg-text', text: m.text })
      )
    );
  }

  let composer;
  if (!state.user) {
    composer = h('div', { class: 'composer' }, h('a', { href: '#/login', text: 'سجّل دخول عشان تكتب' }));
  } else if (!options.canPost) {
    composer = h('div', { class: 'composer muted small-text', text: options.lockedText || 'المحادثة مقفلة.' });
  } else {
    const input = h('input', { class: 'input', id: 'chat-input', maxlength: '2000', autocomplete: 'off', placeholder: 'اكتب رسالة في #' + channel.name });
    composer = h(
      'form',
      {
        class: 'composer',
        onSubmit: act(async () => {
          const text = input.value.trim();
          if (!text) return;
          input.value = '';
          try {
            await backend.sendMessage(base, channel.id, text);
          } catch (err) {
            input.value = text;
            throw err;
          }
          input.focus();
        })
      },
      h('label', { class: 'sr-only', for: 'chat-input', text: 'اكتب رسالة' }),
      input,
      h('button', { class: 'btn', type: 'submit' }, 'إرسال')
    );
  }

  let first = true;
  const stop = backend.subscribeMessages(
    base,
    channel.id,
    (messages) => {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.replaceChildren(...(messages.length ? messages.map(messageEl) : [h('div', { class: 'empty small-text', text: 'لسا ما في رسائل هون.' })]));
      if (first || nearBottom) list.scrollTop = list.scrollHeight;
      first = false;
    },
    (err) => list.replaceChildren(h('div', { class: 'empty small-text', text: err.message }))
  );
  const el = h('div', { class: 'chat' }, h('div', { class: 'chat-head' }, h('strong', { text: '# ' + channel.name })), list, composer);
  return { el, destroy: stop };
}

// ---------- مساحة عمل (استوديو أو مشروع): قائمة جانبية + محتوى ----------
// tabs: [{ id, label, badge }]. بيرجّع العنصر.
export function workspace({ title, subtitle, baseHash, tabs, active, sideExtra, body, headTitle, headHint }) {
  const side = h(
    'nav',
    { class: 'studio-side', 'aria-label': title },
    h('strong', { text: title }),
    subtitle ? h('span', { class: 'muted small-text', text: subtitle }) : null,
    h('span', { class: 'group', text: 'الأقسام' }),
    tabs.map((t) =>
      h(
        'a',
        { class: 'channel-btn' + (t.id === active ? ' active' : ''), href: `${baseHash}/${t.id}`, 'aria-current': t.id === active ? 'page' : null },
        t.label,
        t.badge ? h('span', { class: 'badge', text: String(t.badge) }) : null
      )
    ),
    sideExtra || null
  );
  const main = headTitle
    ? h(
        'div',
        { class: 'chat' },
        h('div', { class: 'studio-head' }, h('h1', { text: headTitle }), headHint ? h('p', { class: 'muted small-text', text: headHint }) : null),
        h('div', { class: 'studio-body' }, body)
      )
    : body;
  return h('div', { class: 'studio-layout' }, side, h('div', { class: 'studio-main' }, main));
}

// لما توصل تحديثات من شريك: إذا المستخدم بيكتب بنموذج ما بنمسحه، بنعرض شريط «حدّث»
export function softRefresh() {
  const active = document.activeElement;
  const typing = active && active.closest && active.closest('form') && !active.closest('.composer');
  const openDetails = document.querySelector('#app details[open]');
  if (!typing && !openDetails) {
    render();
    return;
  }
  if (document.getElementById('refresh-bar')) return;
  const bar = h(
    'div',
    { class: 'notice row between', id: 'refresh-bar', role: 'status' },
    'في تحديثات جديدة من شركائك.',
    h('button', { class: 'btn small', type: 'button', onClick: () => render() }, 'حدّث الصفحة')
  );
  const host = document.querySelector('#app .studio-body') || document.getElementById('app');
  host.prepend(bar);
}
