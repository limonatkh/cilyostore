'use strict';
// واجهة Cilyo: صفحة وحدة بتتنقل بين الشاشات بالـ# بالرابط.
(function () {
  const $app = document.getElementById('app');
  const $account = document.getElementById('account');
  const $toast = document.getElementById('toast');

  const state = { me: null, hasToken: false, config: { gamesOrigin: '' }, view: null };
  let renderSeq = 0;

  // ---------- مساعدات ----------
  function h(tag, props, ...kids) {
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

  async function api(method, path, body) {
    const opts = { method, headers: { 'x-cilyo': '1' }, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'صار خطأ، جرّب كمان مرة');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer = null;
  function toast(message, isError) {
    $toast.textContent = message;
    $toast.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      $toast.className = 'toast';
    }, 3500);
  }

  // بيشغّل دالة وبيعرض الخطأ إذا صار
  function act(fn) {
    return async (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      const btn = ev && ev.submitter ? ev.submitter : ev && ev.currentTarget && ev.currentTarget.tagName === 'BUTTON' ? ev.currentTarget : null;
      if (btn) btn.disabled = true;
      try {
        await fn(ev);
      } catch (err) {
        toast(err.message, true);
      } finally {
        if (btn && btn.isConnected) btn.disabled = false;
      }
    };
  }

  const timeFmt = new Intl.DateTimeFormat('ar', { dateStyle: 'short', timeStyle: 'short' });
  const fmtTime = (t) => timeFmt.format(new Date(t));

  function field(label, input) {
    const id = 'f_' + Math.random().toString(36).slice(2, 9);
    input.id = id;
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input);
  }

  function formValues(form) {
    const out = {};
    new FormData(form).forEach((v, k) => {
      if (typeof v === 'string') out[k] = v;
    });
    return out;
  }

  function hashNum(s) {
    let n = 0;
    for (const ch of s) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return n;
  }

  function externalLink(url, text, cls) {
    return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: cls || null, text });
  }

  // ---------- الاتصال اللحظي ----------
  let ws = null;
  function connectWS() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onmessage = (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      if (state.view && state.view.onEvent) state.view.onEvent(ev);
    };
    ws.onclose = () => setTimeout(connectWS, 1500);
  }
  function reconnectWS() {
    if (ws) ws.close();
  }

  // ---------- الحساب ----------
  async function loadMe() {
    const data = await api('GET', '/api/me');
    state.me = data.user;
    state.hasToken = data.hasConnectorToken;
    renderAccount();
  }

  function renderAccount() {
    $account.replaceChildren();
    if (state.me) {
      $account.append(
        h('span', { class: 'muted small-text' }, 'أهلًا، ', h('strong', { text: state.me.username })),
        h(
          'button',
          {
            class: 'btn ghost small',
            type: 'button',
            onClick: act(async () => {
              await api('POST', '/api/logout');
              state.me = null;
              state.hasToken = false;
              renderAccount();
              reconnectWS();
              location.hash = '#/';
              render();
            })
          },
          'خروج'
        )
      );
    } else {
      $account.append(h('a', { class: 'btn small', href: '#/login', text: 'دخول' }));
    }
  }

  function needLogin(message) {
    sessionStorage.setItem('cilyo.next', location.hash || '#/');
    return {
      el: h(
        'div',
        { class: 'card stack' },
        h('h2', { text: 'لازم تسجّل دخول' }),
        h('p', { class: 'muted', text: message || 'سجّل دخول أو اعمل حساب عشان تكمل.' }),
        h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/login', text: 'دخول أو حساب جديد' }))
      )
    };
  }

  // ---------- الرسائل (مستخدمة بسيرفر اللعبة وسيرفر الاستوديو) ----------
  function messageEl(m) {
    const kind = m.system ? 'sys' : m.viaAI ? 'ai' : '';
    const initial = m.system ? 'C' : m.viaAI ? 'AI' : (m.author || '?').charAt(0);
    return h(
      'div',
      { class: 'msg' },
      h('span', { class: 'avatar ' + kind, 'aria-hidden': 'true', text: initial }),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'msg-author ' + kind }, h('bdi', { text: m.author }), h('bdi', { class: 'msg-time', text: fmtTime(m.createdAt) })),
        h('div', { class: 'msg-text', text: m.text })
      )
    );
  }

  function chatPanel(serverId, channel) {
    const seen = new Set();
    const list = h('div', { class: 'messages', 'aria-live': 'polite' });
    let composer;
    if (!state.me) {
      composer = h('div', { class: 'composer' }, h('a', { href: '#/login', text: 'سجّل دخول عشان تكتب' }));
    } else if (!channel.canPost) {
      composer = h('div', { class: 'composer muted small-text', text: 'بس فريق اللعبة بيكتب بهاي القناة.' });
    } else {
      const input = h('input', { class: 'input', name: 'text', maxlength: '2000', autocomplete: 'off', placeholder: 'اكتب رسالة في #' + channel.name });
      composer = h(
        'form',
        {
          class: 'composer',
          onSubmit: act(async () => {
            const text = input.value.trim();
            if (!text) return;
            const m = await api('POST', `/api/servers/${serverId}/messages`, { channel: channel.id, text });
            input.value = '';
            add(m);
            input.focus();
          })
        },
        h('label', { class: 'sr-only', text: 'اكتب رسالة' }),
        input,
        h('button', { class: 'btn', type: 'submit' }, 'إرسال')
      );
      composer.querySelector('label').setAttribute('for', (input.id = 'msg_' + serverId));
    }
    function add(m) {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      const empty = list.querySelector('.empty');
      if (empty) empty.remove();
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.append(messageEl(m));
      if (nearBottom) list.scrollTop = list.scrollHeight;
    }
    async function load() {
      const msgs = await api('GET', `/api/servers/${serverId}/messages?channel=${encodeURIComponent(channel.id)}`);
      list.replaceChildren();
      if (!msgs.length) list.append(h('div', { class: 'empty small-text', text: 'لسا ما في رسائل هون.' }));
      msgs.forEach(add);
      list.scrollTop = list.scrollHeight;
    }
    const el = h(
      'div',
      { class: 'chat' },
      h('div', { class: 'chat-head' }, h('strong', { text: '# ' + channel.name })),
      list,
      composer
    );
    return {
      el,
      load,
      onMessage(m) {
        if (m.serverId === serverId && m.channelId === channel.id) add(m);
      }
    };
  }

  // ---------- المتجر ----------
  function gameCard(g) {
    const n = hashNum(g.id) % 5;
    return h(
      'a',
      { class: 'game-card', href: '#/game/' + g.id },
      h('div', { class: 'cover c' + n, 'aria-hidden': 'true', text: g.title.charAt(0) }),
      h(
        'div',
        { class: 'stack tight' },
        h('strong', { text: g.title }),
        h('span', { class: 'muted small-text', text: (g.maker.type === 'studio' ? 'استوديو: ' : 'من: ') + g.maker.name }),
        h('div', { class: 'row' }, h('span', { class: 'chip accent', text: 'مجانية' }), h('span', { class: 'chip', text: 'إلها سيرفر' }))
      )
    );
  }

  async function viewStore() {
    const games = await api('GET', '/api/games');
    const el = h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'hero' },
        h(
          'div',
          { class: 'stack tight' },
          h('h1', { text: 'متجر Cilyo' }),
          h('p', { class: 'muted', text: 'ألعاب ويب مجانية بتنلعب بالمتصفح، ولكل لعبة سيرفر محادثة خاص فيها.' })
        ),
        h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/upload', text: 'ارفع لعبتك' }), h('a', { class: 'btn ghost', href: '#/studios', text: 'اعمل لعبة مع صحابك' }))
      ),
      games.length
        ? h('div', { class: 'games-grid' }, games.map(gameCard))
        : h('div', { class: 'empty', text: 'لسا ما في ألعاب. كون أول واحد بيرفع لعبة!' })
    );
    return { el, onEvent: (ev) => ev.type === 'games' && render() };
  }

  // ---------- صفحة اللعبة ----------
  async function viewGame(id) {
    const { game, server } = await api('GET', '/api/games/' + id);
    let chat = null;
    const frame = h('iframe', {
      class: 'game-frame',
      src: game.playUrl,
      title: game.title,
      sandbox: 'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-modals',
      allow: 'fullscreen; gamepad; autoplay',
      allowfullscreen: true
    });
    const chatHost = h('div', { class: 'chat' });
    const channelsEl = h('nav', { class: 'channels', 'aria-label': 'قنوات السيرفر' });

    function selectChannel(chId) {
      const ch = server.channels.find((c) => c.id === chId);
      channelsEl.querySelectorAll('.channel-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === chId));
      chat = chatPanel(server.id, ch);
      chatHost.replaceChildren(chat.el);
      chat.load().catch((e) => toast(e.message, true));
    }

    channelsEl.append(
      h('strong', { class: 'group', text: 'سيرفر ' + game.title }),
      ...server.channels.map((c) =>
        h('button', { class: 'channel-btn', type: 'button', 'data-id': c.id, onClick: () => selectChannel(c.id) }, '# ' + c.name)
      )
    );

    let versionForm = null;
    if (game.isTeam && game.maker.type === 'user') {
      versionForm = h(
        'details',
        { class: 'card' },
        h('summary', { text: 'ارفع نسخة جديدة من اللعبة' }),
        h(
          'form',
          {
            class: 'stack',
            onSubmit: act(async (ev) => {
              const fd = new FormData(ev.target);
              await api('POST', `/api/games/${game.id}/version`, fd);
              toast('نزلت النسخة الجديدة');
              render();
            })
          },
          field('ملف zip فيه index.html', h('input', { class: 'input', type: 'file', name: 'file', accept: '.zip', required: true })),
          h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'ارفع'))
        )
      );
    }

    const el = h(
      'div',
      { class: 'game-layout' },
      h(
        'section',
        { class: 'game-main', 'aria-labelledby': 'game-title' },
        frame,
        h(
          'div',
          { class: 'row between' },
          h('div', { class: 'row' }, h('h1', { id: 'game-title', text: game.title }), h('span', { class: 'chip accent', text: 'مجانية' })),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn ghost small', type: 'button', onClick: () => frame.requestFullscreen && frame.requestFullscreen() }, 'ملء الشاشة'),
            externalLink(game.playUrl, 'افتح لحالها', 'btn ghost small')
          )
        ),
        game.description ? h('p', { class: 'msg-text', text: game.description }) : null,
        h(
          'div',
          { class: 'row' },
          game.controls ? h('div', { class: 'card grow stack tight' }, h('span', { class: 'muted small-text', text: 'طريقة اللعب' }), h('span', { class: 'msg-text', text: game.controls })) : null,
          h(
            'div',
            { class: 'card grow stack tight' },
            h('span', { class: 'muted small-text', text: game.maker.type === 'studio' ? 'من صنع استوديو' : 'من صنع' }),
            h('strong', { text: game.maker.name }),
            game.maker.members ? h('span', { class: 'muted small-text', text: 'الأعضاء: ' + game.maker.members.join('، ') }) : null
          )
        ),
        versionForm
      ),
      h('section', { class: 'server-panel', 'aria-label': 'سيرفر اللعبة' }, channelsEl, chatHost)
    );
    selectChannel('general');
    return {
      el,
      onEvent(ev) {
        if (ev.type === 'message' && chat) chat.onMessage(ev.message);
      }
    };
  }

  // ---------- رفع لعبة فردية ----------
  async function viewUpload() {
    if (!state.me) return needLogin('لازم يكون عندك حساب عشان ترفع لعبة.');
    const el = h(
      'div',
      { class: 'stack' },
      h('h1', { text: 'ارفع لعبتك' }),
      h('p', { class: 'muted', text: 'اللعبة لازم تكون لعبة ويب: ملف zip فيه index.html. بعد الرفع بتنعرض بالمتجر فورًا وبينعملها سيرفر محادثة. (إذا بتشتغل مع شريك، استخدم الاستوديو.)' }),
      h(
        'form',
        {
          class: 'card stack',
          onSubmit: act(async (ev) => {
            const fd = new FormData(ev.target);
            const g = await api('POST', '/api/games', fd);
            toast('انتشرت لعبتك');
            location.hash = '#/game/' + g.id;
          })
        },
        field('اسم اللعبة', h('input', { class: 'input', name: 'title', maxlength: '80', required: true })),
        field('وصف قصير', h('textarea', { class: 'input', name: 'description', maxlength: '2000' })),
        field('طريقة اللعب والتحكم', h('input', { class: 'input', name: 'controls', maxlength: '500', placeholder: 'مثلًا: الأسهم للحركة، المسافة للقفز' })),
        field('ملف اللعبة (zip، لحد 100 ميغا)', h('input', { class: 'input', type: 'file', name: 'file', accept: '.zip', required: true })),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'ارفع وانشر'))
      )
    );
    return { el };
  }

  // ---------- الدخول ----------
  async function viewLogin() {
    async function done(user) {
      state.me = user;
      await loadMe();
      reconnectWS();
      const next = sessionStorage.getItem('cilyo.next') || '#/';
      sessionStorage.removeItem('cilyo.next');
      location.hash = next === '#/login' ? '#/' : next;
      render();
    }
    const el = h(
      'div',
      { class: 'auth-grid' },
      h(
        'form',
        {
          class: 'card stack',
          onSubmit: act(async (ev) => {
            const v = formValues(ev.target);
            const r = await api('POST', '/api/login', v);
            await done(r.user);
          })
        },
        h('h2', { text: 'دخول' }),
        field('اسم المستخدم', h('input', { class: 'input', name: 'username', autocomplete: 'username', required: true })),
        field('كلمة السر', h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'current-password', required: true })),
        h('button', { class: 'btn', type: 'submit' }, 'دخول')
      ),
      h(
        'form',
        {
          class: 'card stack',
          onSubmit: act(async (ev) => {
            const v = formValues(ev.target);
            const r = await api('POST', '/api/register', v);
            await done(r.user);
          })
        },
        h('h2', { text: 'حساب جديد' }),
        field('اسم المستخدم (3 لـ24 حرف، بدون مسافات)', h('input', { class: 'input', name: 'username', autocomplete: 'username', required: true, minlength: '3', maxlength: '24' })),
        field('كلمة السر (6 أحرف أو أكثر)', h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'new-password', required: true, minlength: '6' })),
        h('button', { class: 'btn', type: 'submit' }, 'اعمل حساب')
      )
    );
    return { el };
  }

  // ---------- قائمة الاستوديوهات ----------
  async function viewStudios() {
    if (!state.me) return needLogin('الاستوديوهات بدها حساب.');
    const { studios, invites } = await api('GET', '/api/studios');
    const statusChip = (s) =>
      s.status === 'active' ? h('span', { class: 'chip good', text: 'مفتوح' }) : h('span', { class: 'chip accent', text: 'بيستنى توقيع العقد' });
    const el = h(
      'div',
      { class: 'stack' },
      h('h1', { text: 'استوديوهاتي' }),
      invites.length
        ? h(
            'section',
            { class: 'stack' },
            h('h2', { text: 'دعوات إلك' }),
            invites.map((s) =>
              h(
                'div',
                { class: 'item' },
                h('div', { class: 'row between' }, h('strong', { text: s.name }), statusChip(s)),
                h('span', { class: 'muted small-text', text: 'الأعضاء: ' + s.members.join('، ') }),
                h(
                  'div',
                  { class: 'row' },
                  h('a', { class: 'btn small', href: '#/studio/' + s.id, text: 'شوف العقد' }),
                  h(
                    'button',
                    {
                      class: 'btn bad small',
                      type: 'button',
                      onClick: act(async () => {
                        await api('POST', `/api/studios/${s.id}/decline`);
                        render();
                      })
                    },
                    'ارفض الدعوة'
                  )
                )
              )
            )
          )
        : null,
      h(
        'section',
        { class: 'stack' },
        h('h2', { text: 'استوديوهاتك' }),
        studios.length
          ? h(
              'div',
              { class: 'games-grid' },
              studios.map((s) =>
                h(
                  'a',
                  { class: 'game-card', href: '#/studio/' + s.id },
                  h('div', { class: 'row between' }, h('strong', { text: s.name }), statusChip(s)),
                  h('span', { class: 'muted small-text', text: 'الأعضاء: ' + s.members.join('، ') }),
                  h('span', { class: 'muted small-text', text: s.projects.length ? 'المشاريع: ' + s.projects.map((p) => p.name).join('، ') : 'ما في مشاريع لسا' })
                )
              )
            )
          : h('div', { class: 'empty', text: 'ما عندك استوديوهات لسا.' })
      ),
      h(
        'form',
        {
          class: 'card stack',
          onSubmit: act(async (ev) => {
            const v = formValues(ev.target);
            const st = await api('POST', '/api/studios', v);
            location.hash = '#/studio/' + st.id;
          })
        },
        h('h2', { text: 'أنشئ استوديو' }),
        h('p', { class: 'muted small-text', text: 'بعد الإنشاء بتعزم شريكك، بتتفقوا على العقد، وبيوقّع الكل. الاستوديو وسيرفره بيفتحوا بعد آخر توقيع.' }),
        h('div', { class: 'row' }, field('اسم الاستوديو', h('input', { class: 'input', name: 'name', maxlength: '60', required: true }))),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'أنشئ'))
      )
    );
    return { el, onEvent: (ev) => (ev.type === 'studio' || ev.type === 'invites') && render() };
  }

  // ---------- الاستوديو ----------
  async function viewStudio(id, channelId) {
    if (!state.me) return needLogin();
    const st = await api('GET', '/api/studios/' + id);
    const onStudio = (ev) => ev.type === 'studio' && ev.studioId === st.id;
    if (!st.isMember) return { el: invitedView(st), onEvent: (ev) => onStudio(ev) && render() };
    if (st.status !== 'active') return { el: contractPage(st), onEvent: (ev) => onStudio(ev) && render() };
    return activeStudio(st, channelId || 'general');
  }

  function contractSummary(st) {
    const c = st.contract;
    return h(
      'div',
      { class: 'stack' },
      h('div', { class: 'stack tight' }, h('span', { class: 'label', text: 'ملكية المشاريع' }), h('strong', { text: c.ownershipText })),
      h('div', { class: 'stack tight' }, h('span', { class: 'label', text: 'إذا عضو طلع من الاستوديو' }), h('strong', { text: c.exitText })),
      h('div', { class: 'stack tight' }, h('span', { class: 'label', text: 'بنود ثابتة بكل عقد' }), h('ul', { class: 'clauses' }, c.clauses.map((t) => h('li', { text: t }))))
    );
  }

  function invitedView(st) {
    return h(
      'div',
      { class: 'stack' },
      h('h1', { text: 'دعوة لاستوديو ' + st.name }),
      h('p', { class: 'muted', text: 'الأعضاء: ' + st.members.map((m) => m.username).join('، ') }),
      h('div', { class: 'card stack' }, h('h2', { text: 'العقد' }), contractSummary(st)),
      h('p', { class: 'notice', text: 'لما تقبل، التواقيع بترجع من الأول وبتقدروا تعدّلوا العقد مع بعض قبل ما توقّعوا.' }),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: act(async () => {
              await api('POST', `/api/studios/${st.id}/accept`);
              render();
            })
          },
          'اقبل وانضم'
        ),
        h(
          'button',
          {
            class: 'btn bad',
            type: 'button',
            onClick: act(async () => {
              await api('POST', `/api/studios/${st.id}/decline`);
              location.hash = '#/studios';
            })
          },
          'ارفض'
        )
      )
    );
  }

  function contractPage(st) {
    const c = st.contract;
    const me = state.me.id;
    const mySig = c.signatures.find((s) => s.userId === me);
    const radios = (name, options, current) =>
      h(
        'div',
        { class: 'choice-group', role: 'radiogroup' },
        Object.entries(options).map(([key, label]) =>
          h(
            'label',
            { class: 'choice' },
            h('input', {
              type: 'radio',
              name,
              value: key,
              checked: key === current,
              onChange: act(async () => {
                await api('PUT', `/api/studios/${st.id}/contract`, { [name]: key });
                toast('تعدّل العقد، والتواقيع رجعت من الأول');
                render();
              })
            }),
            label
          )
        )
      );
    return h(
      'div',
      { class: 'stack' },
      h('h1', { text: 'استوديو ' + st.name }),
      h('p', { class: 'muted', text: 'الاستوديو ما بيفتح قبل ما كل الأعضاء يوقّعوا العقد. أي تعديل على العقد أو عضو جديد بيرجّع التواقيع من الأول.' }),
      h(
        'section',
        { class: 'card stack' },
        h('h2', { text: '١. الأعضاء' }),
        h('div', { class: 'row' }, st.members.map((m) => h('span', { class: 'chip', text: m.username })), st.invites.map((m) => h('span', { class: 'chip accent', text: m.username + ' (معزوم)' }))),
        h(
          'form',
          {
            class: 'row',
            onSubmit: act(async (ev) => {
              const v = formValues(ev.target);
              await api('POST', `/api/studios/${st.id}/invite`, v);
              toast('انبعتت الدعوة');
              render();
            })
          },
          field('اعزم شريك باسم المستخدم تبعه', h('input', { class: 'input', name: 'username', required: true })),
          h('button', { class: 'btn ghost', type: 'submit' }, 'اعزم')
        ),
        h('p', { class: 'muted small-text', text: 'شريكك لازم يعمل حساب بـCilyo أول، وبعدين بيلاقي الدعوة بصفحة «استوديوهاتي».' })
      ),
      h(
        'section',
        { class: 'card stack' },
        h('h2', { text: '٢. العقد' }),
        h('span', { class: 'label', text: 'ملكية المشاريع' }),
        radios('ownership', c.ownershipOptions, c.ownership),
        h('span', { class: 'label', text: 'إذا عضو طلع من الاستوديو' }),
        radios('exit', c.exitOptions, c.exit),
        h('span', { class: 'label', text: 'بنود ثابتة بكل عقد' }),
        h('ul', { class: 'clauses' }, c.clauses.map((t) => h('li', { text: t }))),
        h('p', { class: 'muted small-text', text: 'هاد قالب للتجربة. عشان يكون ملزم قانونيًا لازم يراجعه محامي حسب البلد.' })
      ),
      h(
        'section',
        { class: 'card stack' },
        h('h2', { text: '٣. التوقيع (نسخة العقد ' + c.version + ')' }),
        h(
          'div',
          { class: 'list' },
          c.signatures.map((s) =>
            h(
              'div',
              { class: 'item' },
              h(
                'div',
                { class: 'row between' },
                h('strong', { text: s.username }),
                s.signed ? h('span', { class: 'chip good', text: 'وقّع' }) : h('span', { class: 'chip', text: 'لسا ما وقّع' })
              )
            )
          )
        ),
        st.members.length < 2 ? h('p', { class: 'notice', text: 'لازم يكون بالاستوديو عضوين على الأقل عشان يفتح. اعزم شريكك.' }) : null,
        mySig && !mySig.signed
          ? h(
              'div',
              { class: 'row' },
              h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onClick: act(async () => {
                    const r = await api('POST', `/api/studios/${st.id}/sign`);
                    toast(r.status === 'active' ? 'انفتح الاستوديو وسيرفره!' : 'وقّعت. بنستنى الباقين.');
                    render();
                  })
                },
                'أوافق على العقد وأوقّع'
              )
            )
          : h('p', { class: 'muted small-text', text: 'وقّعت على هالنسخة.' })
      )
    );
  }

  const STATUS_CLASS = { proposed: '', agreed: 'info', implemented: 'accent', approved: 'good', rejected: 'bad' };
  const CHANNEL_HINT = {
    project: 'المشروع ورابط الكود والطبقات ومسؤول كل طبقة',
    agreements: 'شو كل طبقة بتوعد فيه الطبقات الثانية. «متفق عليه» ما بيعني «جاهز».',
    approvals: 'تغييرات بتمس شغل غيرك وبدها موافقته، وطلبات النشر',
    trials: 'نسخ اللعبة للتجربة، ومنها بتطلبوا النشر بالمتجر',
    log: 'مين عمل شو ومتى. بينكتب تلقائيًا وما حدا بيعدّله.'
  };

  function activeStudio(st, channelId) {
    const me = state.me.id;
    const server = st.server;
    const channel = server.channels.find((c) => c.id === channelId) || server.channels[0];
    const storeKey = 'cilyo.project.' + st.id;
    let project = st.projects.find((p) => p.id === localStorage.getItem(storeKey)) || st.projects[0] || null;
    let chat = null;

    const side = h(
      'nav',
      { class: 'studio-side', 'aria-label': 'قنوات الاستوديو' },
      h('strong', { text: st.name }),
      h('span', { class: 'muted small-text', text: 'سيرفر خاص بالأعضاء' }),
      st.projects.length
        ? h(
            'div',
            { class: 'field' },
            h('label', { for: 'proj-select', class: 'label', text: 'المشروع' }),
            h(
              'select',
              {
                id: 'proj-select',
                class: 'input',
                onChange: (ev) => {
                  localStorage.setItem(storeKey, ev.target.value);
                  render();
                }
              },
              st.projects.map((p) => h('option', { value: p.id, selected: project && p.id === project.id, text: p.name }))
            )
          )
        : null,
      ['عام', 'الطبقات', 'التنسيق'].map((g) => [
        h('span', { class: 'group', text: g }),
        server.channels
          .filter((c) => c.group === g)
          .map((c) =>
            h('a', { class: 'channel-btn' + (c.id === channel.id ? ' active' : ''), href: `#/studio/${st.id}/${c.id}`, 'aria-current': c.id === channel.id ? 'page' : null }, '# ' + c.name, badgeFor(c))
          )
      ]),
      h('span', { class: 'group', text: 'الأعضاء' }),
      st.members.map((m) => h('div', { class: 'member' }, h('span', { class: 'avatar', 'aria-hidden': 'true', text: m.username.charAt(0) }), m.username))
    );

    function badgeFor(c) {
      if (c.type !== 'approvals') return null;
      const n = st.approvals.filter((a) => a.status === 'open' && a.required.some((r) => r.userId === me && !r.decision)).length;
      return n ? h('span', { class: 'badge', text: String(n) }) : null;
    }

    let body;
    if (channel.type === 'chat') {
      chat = chatPanel(server.id, channel);
      chat.load().catch((e) => toast(e.message, true));
      body = chat.el;
    } else {
      body = h(
        'div',
        { class: 'chat' },
        h('div', { class: 'studio-head' }, h('h1', { text: '# ' + channel.name }), h('p', { class: 'muted small-text', text: CHANNEL_HINT[channel.type] || '' })),
        h('div', { class: 'studio-body' }, boardFor(channel.type))
      );
    }

    function boardFor(type) {
      if (type === 'log') return logBoard(st);
      if (type === 'project') return projectBoard(st, project);
      if (!project) {
        return h('div', { class: 'empty' }, 'ما في مشروع لسا. ', h('a', { href: `#/studio/${st.id}/project`, text: 'أنشئ مشروع من قناة #المشروع' }));
      }
      if (type === 'agreements') return agreementsBoard(st, project);
      if (type === 'approvals') return approvalsBoard(st, project);
      if (type === 'trials') return trialsBoard(st, project);
      return h('div');
    }

    const el = h('div', { class: 'studio-layout' }, side, h('div', { class: 'studio-main' }, body));
    return {
      el,
      onEvent(ev) {
        if (ev.type === 'message' && chat) chat.onMessage(ev.message);
        if (ev.type === 'studio' && ev.studioId === st.id && channel.type !== 'chat') render();
      }
    };
  }

  function projectForm(st, p) {
    return h(
      'form',
      {
        class: 'stack',
        onSubmit: act(async (ev) => {
          const v = formValues(ev.target);
          if (p) {
            await api('PUT', `/api/projects/${p.id}`, v);
            toast('انحفظ');
          } else {
            const np = await api('POST', `/api/studios/${st.id}/projects`, v);
            localStorage.setItem('cilyo.project.' + st.id, np.id);
            toast('انعمل المشروع');
          }
          render();
        })
      },
      h(
        'div',
        { class: 'row' },
        field('اسم المشروع', h('input', { class: 'input', name: 'name', maxlength: '80', required: true, value: p ? p.name : '' })),
        field('رابط مستودع الكود على GitHub (اختياري)', h('input', { class: 'input', name: 'repoUrl', dir: 'ltr', placeholder: 'https://github.com/...', value: p ? p.repoUrl : '' }))
      ),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, p ? 'احفظ' : 'أنشئ المشروع'))
    );
  }

  function projectBoard(st, p) {
    if (!p) {
      return h(
        'div',
        { class: 'card stack' },
        h('h2', { text: 'أول مشروع' }),
        h('p', { class: 'muted small-text', text: 'كل مشروع إله خمس طبقات جاهزة. اعمل مستودع على GitHub للعبة وحط رابطه هون، عشان كل واحد يفتحه بـVS Code.' }),
        projectForm(st, null)
      );
    }
    const me = state.me.id;
    const rows = p.layers.map((l) => {
      const locked = l.ownerId && l.ownerId !== me;
      return h(
        'tr',
        null,
        h('td', null, h('strong', { text: l.name })),
        h(
          'td',
          null,
          h(
            'select',
            {
              class: 'input',
              'aria-label': 'مسؤول طبقة ' + l.name,
              disabled: locked,
              onChange: act(async (ev) => {
                await api('PUT', `/api/projects/${p.id}/layers/${l.id}`, { ownerId: ev.target.value || null });
                toast('انحفظ');
              })
            },
            h('option', { value: '', text: 'بدون مسؤول', selected: !l.ownerId }),
            st.members.map((m) => h('option', { value: m.id, text: m.username, selected: l.ownerId === m.id }))
          )
        ),
        h('td', { class: 'muted small-text', text: l.id })
      );
    });
    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card stack' },
        h('div', { class: 'row between' }, h('h2', { text: p.name }), p.gameId ? h('a', { class: 'btn ghost small', href: '#/game/' + p.gameId, text: 'صفحتها بالمتجر' }) : h('span', { class: 'chip', text: 'لسا ما انتشرت' })),
        p.repoUrl
          ? h(
              'div',
              { class: 'row' },
              h('a', { class: 'btn', href: 'vscode://vscode.git/clone?url=' + encodeURIComponent(p.repoUrl), text: 'افتح بـVS Code' }),
              externalLink(p.repoUrl, 'المستودع على GitHub', 'btn ghost')
            )
          : h('p', { class: 'notice', text: 'حط رابط مستودع GitHub تحت، عشان يظهر زر «افتح بـVS Code».' }),
        h('p', { class: 'muted small-text' }, 'لربط مساعدك بالاستوديو: ', h('a', { href: '#/settings', text: 'ربط المساعد' }))
      ),
      h(
        'div',
        { class: 'card stack' },
        h('h2', { text: 'الطبقات ومسؤوليها' }),
        h('p', { class: 'muted small-text', text: 'الطبقة بدون مسؤول بياخدها أي عضو. اللي إلها مسؤول، هو بس بينقلها لغيره.' }),
        h('table', { class: 'layers-table' }, h('thead', null, h('tr', null, h('th', { text: 'الطبقة' }), h('th', { text: 'المسؤول' }), h('th', { text: 'الرمز' }))), h('tbody', null, rows))
      ),
      h('details', { class: 'card' }, h('summary', { text: 'عدّل بيانات المشروع' }), projectForm(st, p)),
      h('details', { class: 'card' }, h('summary', { text: 'مشروع جديد' }), projectForm(st, null))
    );
  }

  function layerSelect(name, label, p) {
    return field(
      label,
      h(
        'select',
        { class: 'input', name, required: true },
        h('option', { value: '', text: 'اختار طبقة' }),
        p.layers.map((l) => h('option', { value: l.id, text: l.name + (l.owner ? ' (' + l.owner + ')' : '') }))
      )
    );
  }

  function agreementsBoard(st, p) {
    const me = state.me.id;
    const list = st.agreements.filter((a) => a.projectId === p.id).sort((a, b) => b.updatedAt - a.updatedAt);
    const proposeForm = h(
      'form',
      {
        class: 'card stack',
        onSubmit: act(async (ev) => {
          const v = formValues(ev.target);
          const a = await api('POST', `/api/projects/${p.id}/agreements`, v);
          toast(a.status === 'proposed' ? 'انقترح الاتفاق، وانبعت للموافقة' : 'انضاف الاتفاق');
          render();
        })
      },
      h('h2', { text: 'اقترح اتفاق' }),
      h('p', { class: 'muted small-text', text: 'إشي طبقة بتقدّمه وطبقة ثانية بتعتمد عليه: حدث، دالة، شكل بيانات، أو قاعدة لعب زي «اللاعب بيقفز مترين».' }),
      h('div', { class: 'row' }, field('العنوان', h('input', { class: 'input', name: 'title', maxlength: '120', required: true }))),
      h('div', { class: 'row' }, field('التفاصيل: الأسماء والبيانات والشروط', h('textarea', { class: 'input', name: 'description', maxlength: '2000' }))),
      h('div', { class: 'row' }, layerSelect('fromLayer', 'الطبقة اللي بتقدّمه', p), layerSelect('toLayer', 'الطبقة اللي بتعتمد عليه', p)),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'اقترح'))
    );
    const items = list.map((a) => {
      const canImplement = a.status === 'agreed' && (!a.fromLayer.ownerId || a.fromLayer.ownerId === me);
      const canApprove = a.status === 'implemented' && (!a.toLayer.ownerId || a.toLayer.ownerId === me);
      const setStatus = (status) =>
        act(async () => {
          await api('POST', `/api/agreements/${a.id}/status`, { status });
          render();
        });
      return h(
        'article',
        { class: 'item' },
        h('div', { class: 'row between' }, h('strong', { text: a.title }), h('span', { class: 'chip ' + STATUS_CLASS[a.status], text: a.statusText })),
        h('span', { class: 'muted small-text', text: `${a.fromLayer.name}${a.fromLayer.owner ? ' (' + a.fromLayer.owner + ')' : ''} ← ${a.toLayer.name}${a.toLayer.owner ? ' (' + a.toLayer.owner + ')' : ''}` }),
        a.description ? h('p', { class: 'msg-text', text: a.description }) : null,
        a.status === 'proposed' ? h('span', { class: 'muted small-text' }, 'بيستنى موافقة. ', h('a', { href: `#/studio/${st.id}/approvals`, text: 'شوف الموافقات' })) : null,
        h(
          'div',
          { class: 'row' },
          canImplement ? h('button', { class: 'btn small', type: 'button', onClick: setStatus('implemented') }, 'علّمه منفّذ') : null,
          canApprove ? h('button', { class: 'btn good small', type: 'button', onClick: setStatus('approved') }, 'جرّبته، اعتمده') : null,
          h(
            'details',
            null,
            h('summary', { class: 'small-text', text: 'عدّل (بيرجع للموافقة)' }),
            h(
              'form',
              {
                class: 'stack',
                onSubmit: act(async (ev) => {
                  await api('PUT', `/api/agreements/${a.id}`, formValues(ev.target));
                  toast('تعدّل الاتفاق ورجع مقترح');
                  render();
                })
              },
              field('العنوان', h('input', { class: 'input', name: 'title', maxlength: '120', required: true, value: a.title })),
              field('التفاصيل', h('textarea', { class: 'input', name: 'description', maxlength: '2000', value: a.description })),
              h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'احفظ التعديل'))
            )
          )
        )
      );
    });
    return h('div', { class: 'stack' }, proposeForm, list.length ? h('div', { class: 'list' }, items) : h('div', { class: 'empty', text: 'ما في اتفاقات بهاد المشروع لسا.' }));
  }

  function approvalsBoard(st, p) {
    const me = state.me.id;
    const all = st.approvals.filter((a) => a.projectId === p.id);
    const open = all.filter((a) => a.status === 'open');
    const closed = all.filter((a) => a.status !== 'open').slice(0, 20);
    const decisionChip = (r) =>
      h('span', { class: 'chip ' + (r.decision === 'yes' ? 'good' : r.decision === 'no' ? 'bad' : ''), text: r.username + ': ' + (r.decision === 'yes' ? 'وافق' : r.decision === 'no' ? 'رفض' : 'بيستنى') });
    const statusText = { approved: ['good', 'انقبل'], rejected: ['bad', 'انرفض'], cancelled: ['', 'انلغى'] };
    return h(
      'div',
      { class: 'stack' },
      h('h2', { text: 'بتستنى قرار' }),
      open.length
        ? h(
            'div',
            { class: 'list' },
            open.map((a) => {
              const mine = a.required.find((r) => r.userId === me && !r.decision);
              const decide = (decision) =>
                act(async () => {
                  await api('POST', `/api/approvals/${a.id}/decide`, { decision });
                  toast(decision === 'yes' ? 'وافقت' : 'رفضت');
                  render();
                });
              return h(
                'article',
                { class: 'item' },
                h('strong', { text: a.summary }),
                a.detail ? h('p', { class: 'msg-text muted', text: a.detail }) : null,
                h('span', { class: 'muted small-text', text: 'طلبه ' + a.createdBy + ' · ' + fmtTime(a.createdAt) }),
                h('div', { class: 'decisions' }, a.required.map(decisionChip)),
                mine
                  ? h(
                      'div',
                      { class: 'row' },
                      h('button', { class: 'btn good small', type: 'button', onClick: decide('yes') }, 'موافق'),
                      h('button', { class: 'btn bad small', type: 'button', onClick: decide('no') }, 'رافض')
                    )
                  : null
              );
            })
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
                h('div', { class: 'row between' }, h('span', { text: a.summary }), h('span', { class: 'chip ' + statusText[a.status][0], text: statusText[a.status][1] })),
                h('div', { class: 'decisions' }, a.required.map(decisionChip))
              )
            )
          )
        : null
    );
  }

  function trialsBoard(st, p) {
    const list = st.trials.filter((t) => t.projectId === p.id);
    const uploadForm = h(
      'form',
      {
        class: 'card stack',
        onSubmit: act(async (ev) => {
          const fd = new FormData(ev.target);
          await api('POST', `/api/projects/${p.id}/trials`, fd);
          toast('انرفعت النسخة التجريبية');
          render();
        })
      },
      h('h2', { text: 'ارفع نسخة للتجربة' }),
      h('p', { class: 'muted small-text', text: 'ملف zip فيه index.html. النسخ المرفوعة بس هي اللي بتنتشر بالمتجر.' }),
      h(
        'div',
        { class: 'row' },
        field('الملف', h('input', { class: 'input', type: 'file', name: 'file', accept: '.zip', required: true })),
        field('شو الجديد فيها؟', h('input', { class: 'input', name: 'note', maxlength: '300' }))
      ),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'ارفع'))
    );
    const linkForm = h(
      'details',
      { class: 'card' },
      h('summary', { text: 'أو شارك رابط تجربة (مثلًا GitHub Pages)' }),
      h(
        'form',
        {
          class: 'stack',
          onSubmit: act(async (ev) => {
            await api('POST', `/api/projects/${p.id}/trial-links`, formValues(ev.target));
            toast('انضاف الرابط');
            render();
          })
        },
        h(
          'div',
          { class: 'row' },
          field('الرابط', h('input', { class: 'input', name: 'url', dir: 'ltr', required: true, placeholder: 'https://...' })),
          field('ملاحظة', h('input', { class: 'input', name: 'note', maxlength: '300' }))
        ),
        h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'أضف'))
      )
    );
    const items = list.map((t) =>
      h(
        'article',
        { class: 'item' },
        h('div', { class: 'row between' }, h('strong', { text: t.note || 'نسخة تجريبية' }), h('span', { class: 'chip ' + (t.uploaded ? 'accent' : ''), text: t.uploaded ? 'مرفوعة' : 'رابط' })),
        h('span', { class: 'muted small-text', text: t.by + ' · ' + fmtTime(t.createdAt) }),
        h(
          'div',
          { class: 'row' },
          externalLink(t.url, 'جرّب', 'btn small'),
          t.uploaded
            ? h(
                'details',
                null,
                h('summary', { class: 'small-text', text: p.gameId ? 'انشر هالنسخة كتحديث للعبة' : 'اطلب نشرها بالمتجر' }),
                h(
                  'form',
                  {
                    class: 'stack',
                    onSubmit: act(async (ev) => {
                      const v = formValues(ev.target);
                      v.trialId = t.id;
                      const ap = await api('POST', `/api/projects/${p.id}/publish`, v);
                      toast(ap.status === 'approved' ? 'انتشرت!' : 'انبعت طلب النشر للموافقات. بتنتشر لما يوافق الكل.');
                      render();
                    })
                  },
                  field(p.gameId ? 'اسم اللعبة (فاضي = بيضل نفسه)' : 'اسم اللعبة', h('input', { class: 'input', name: 'title', maxlength: '80', required: !p.gameId })),
                  field('وصف', h('textarea', { class: 'input', name: 'description', maxlength: '2000' })),
                  field('طريقة اللعب', h('input', { class: 'input', name: 'controls', maxlength: '500' })),
                  h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'اطلب النشر'))
                )
              )
            : null
        )
      )
    );
    return h('div', { class: 'stack' }, uploadForm, linkForm, list.length ? h('div', { class: 'list' }, items) : h('div', { class: 'empty', text: 'ما في نسخ تجريبية لسا.' }));
  }

  function logBoard(st) {
    if (!st.log.length) return h('div', { class: 'empty', text: 'السجل فاضي.' });
    return h(
      'div',
      { class: 'list' },
      st.log.map((l) =>
        h('div', { class: 'item' }, h('div', { class: 'row between' }, h('strong', { text: l.who }), h('span', { class: 'muted small-text', text: fmtTime(l.createdAt) })), h('span', { text: l.text }))
      )
    );
  }

  // ---------- ربط المساعد ----------
  async function viewSettings() {
    if (!state.me) return needLogin('ربط المساعد بدّه حساب.');
    const out = h('div', { class: 'stack' });
    const origin = location.origin;

    function copyBlock(label, text) {
      return h(
        'div',
        { class: 'stack tight' },
        h('div', { class: 'row between' }, h('strong', { text: label }), h('button', { class: 'btn ghost small', type: 'button', onClick: () => navigator.clipboard.writeText(text).then(() => toast('انسخ')) }, 'انسخ')),
        h('pre', { class: 'code', text })
      );
    }

    function showToken(token) {
      const claude = `claude mcp add --transport http cilyo ${origin}/mcp --header "Authorization: Bearer ${token}"`;
      const vscode = JSON.stringify({ servers: { cilyo: { type: 'http', url: origin + '/mcp', headers: { Authorization: 'Bearer ' + token } } } }, null, 2);
      out.replaceChildren(
        h('p', { class: 'notice', text: 'هاد الرمز بيظهر مرة وحدة بس. لا تشاركه مع حدا: اللي معه الرمز بيقدر يشتغل باسمك بالاستوديو.' }),
        copyBlock('Claude Code (بالتيرمنال، أو تيرمنال VS Code)', claude),
        copyBlock('VS Code مع Copilot: ملف .vscode/mcp.json', vscode)
      );
    }

    const el = h(
      'div',
      { class: 'stack' },
      h('h1', { text: 'ربط مساعدك بـCilyo' }),
      h('p', { class: 'muted', text: 'مساعدك بـVS Code (Claude Code أو Copilot أو غيرهم) بيشتغل باشتراكك العادي. الموصل بيخليه يعرف الاستوديو: المهام والطبقات والاتفاقات، وبيقدر يقترح اتفاقات ويبعت رسائل لشريكك.' }),
      h(
        'div',
        { class: 'card stack' },
        h('h2', { text: '١. اعمل رمز الموصل' }),
        state.hasToken ? h('p', { class: 'muted small-text', text: 'عندك رمز شغال. إذا عملت رمز جديد، القديم بيوقف.' }) : null,
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onClick: act(async () => {
                const r = await api('POST', '/api/connector-token');
                state.hasToken = true;
                showToken(r.token);
              })
            },
            state.hasToken ? 'اعمل رمز جديد' : 'اعمل رمز'
          )
        ),
        out
      ),
      h(
        'div',
        { class: 'card stack' },
        h('h2', { text: '٢. جرّب تحكي مع مساعدك' }),
        h(
          'ul',
          { class: 'clauses' },
          h('li', { text: '«شو الاستوديوهات والمشاريع اللي أنا فيها بـCilyo؟»' }),
          h('li', { text: '«اقرأ مشروع القلعة بـCilyo وقلي شو طبقاتي والاتفاقات اللي بتخصني»' }),
          h('li', { text: '«اقترح اتفاق: حدث التقاط المفتاح، من أنظمة اللعب للواجهة والصوت»' }),
          h('li', { text: '«احكي لشريكي بقناة عام إني خلصت الباب»' })
        ),
        h('p', { class: 'muted small-text', text: 'المساعد بيتبع نفس قواعد الموقع: ما بيقدر يوافق عن شريكك، ولا يعلّم اتفاق منفّذ إذا مش طبقتك.' })
      )
    );
    return { el };
  }

  // ---------- التنقل ----------
  const routes = [
    [/^#?\/?$/, () => viewStore(), 'store'],
    [/^#\/game\/(\w+)$/, (m) => viewGame(m[1]), 'store'],
    [/^#\/upload$/, () => viewUpload(), 'upload'],
    [/^#\/login$/, () => viewLogin(), null],
    [/^#\/studios$/, () => viewStudios(), 'studios'],
    [/^#\/studio\/(\w+)(?:\/(\w+))?$/, (m) => viewStudio(m[1], m[2]), 'studios'],
    [/^#\/settings$/, () => viewSettings(), 'settings']
  ];

  async function render() {
    const seq = ++renderSeq;
    const hash = location.hash || '#/';
    let route = routes.find(([re]) => re.test(hash));
    if (!route) route = routes[0];
    const m = hash.match(route[0]);
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === route[2]));
    try {
      const view = await route[1](m);
      if (seq !== renderSeq) return;
      if (state.view && state.view.destroy) state.view.destroy();
      state.view = view;
      $app.replaceChildren(view.el);
    } catch (err) {
      if (seq !== renderSeq) return;
      state.view = null;
      $app.replaceChildren(h('div', { class: 'empty' }, err.message, ' ', h('a', { href: '#/', text: 'رجوع للمتجر' })));
    }
  }

  window.addEventListener('hashchange', () => {
    render();
    $app.focus({ preventScroll: true });
  });

  (async function start() {
    try {
      state.config = await api('GET', '/api/config');
      await loadMe();
    } catch (e) {
      toast('ما قدرنا نوصل للسيرفر', true);
    }
    connectWS();
    render();
  })();
})();
