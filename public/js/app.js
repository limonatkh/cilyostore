// واجهة Cilyo: صفحة وحدة بتتنقل بين الشاشات بالـ# بالرابط.
// هاد الملف: التنقل، والحساب، والمتجر، وصفحة العمل، والرفع، وأعمالي، والإعدادات.
import { backend } from './backend.js';
import { state, setRender, h, toast, act, opButton, field, formValues, fmtTime, hashNum, externalLink, messageBox, chip, needLogin, uploadProgress, chatPanel } from './ui.js';
import { viewStudios, viewStudioSpace } from './studio.js';
import { viewProject } from './project.js';
import { viewBoard } from './board.js';

const $app = document.getElementById('app');
const $account = document.getElementById('account');
const $nav = document.getElementById('nav');
let currentView = null;
let renderSeq = 0;

// قنوات سيرفر كل عمل. لازم تطابق القائمة اللي بـ firestore.rules
const CHANNELS = [
  { id: 'general', name: 'عام' },
  { id: 'news', name: 'أخبار', teamOnly: true },
  { id: 'bugs', name: 'بلاغات-أخطاء' },
  { id: 'devlog', name: 'يوميات-التطوير', teamOnly: true }
];
const TYPE_NAMES = { game: 'لعبة', app: 'برنامج', video: 'عمل مرئي' };

const isTeamOf = (work) => !!state.user && work.teamUids.includes(state.user.uid);

// ---------- الحساب والقائمة ----------
function applySession(s) {
  state.user = s.user;
  state.profile = s.profile;
  state.isAdmin = s.isAdmin;
  state.sessionError = s.error || null;
  renderAccount();
  renderNav();
}

let activeNav = null;
function renderNav(active) {
  if (active !== undefined) activeNav = active;
  const links = [
    ['store', '#/', 'المتجر'],
    ['board', '#/board', 'الفرص'],
    ['studios', '#/studios', 'استوديوهاتي'],
    ['mine', '#/mine', 'أعمالي'],
    ['upload', '#/upload', 'ارفع عمل']
  ];
  if (state.isAdmin) links.push(['admin', '#/admin', 'البلاغات']);
  $nav.replaceChildren(...links.map(([key, href, text]) => h('a', { href, class: key === activeNav ? 'active' : null, text })));
}

function renderAccount() {
  $account.replaceChildren();
  if (!state.user) {
    $account.append(h('a', { class: 'btn small', href: '#/login', text: 'دخول' }));
    return;
  }
  const name = state.profile ? state.profile.username : state.user.email || '';
  $account.append(
    h('a', { class: 'muted small-text', href: '#/settings' }, 'أهلًا، ', h('strong', null, h('bdi', { text: name }))),
    h(
      'button',
      {
        class: 'btn ghost small',
        type: 'button',
        onClick: act(async () => {
          await backend.signOut();
          location.hash = '#/';
        })
      },
      'خروج'
    )
  );
}

// ---------- المتجر ----------
export function workCard(w) {
  return h(
    'a',
    { class: 'game-card', href: '#/work/' + w.id },
    h('div', { class: 'cover c' + (hashNum(w.id) % 5), 'aria-hidden': 'true', text: w.title.charAt(0) }),
    h(
      'div',
      { class: 'stack tight' },
      h('strong', { text: w.title }),
      h('span', { class: 'muted small-text', text: 'من: ' + w.studioName }),
      h('div', { class: 'row' }, chip(TYPE_NAMES[w.type] || 'عمل'), chip('مجاني', 'accent'), w.status === 'hidden' ? chip('مخفي', 'bad') : null)
    )
  );
}

async function viewStore() {
  const works = await backend.listWorks();
  let filter = 'all';
  const grid = h('div');
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'نوع العمل' });
  function draw() {
    tabs.replaceChildren(
      ...[
        ['all', 'الكل'],
        ['game', 'ألعاب'],
        ['app', 'برامج'],
        ['video', 'المعرض المرئي']
      ].map(([key, text]) =>
        h(
          'button',
          {
            class: 'tab' + (filter === key ? ' active' : ''),
            type: 'button',
            'aria-pressed': filter === key ? 'true' : 'false',
            onClick: () => {
              filter = key;
              draw();
            }
          },
          text
        )
      )
    );
    const shown = works.filter((w) => filter === 'all' || w.type === filter);
    grid.replaceChildren(
      shown.length
        ? h('div', { class: 'games-grid' }, shown.map(workCard))
        : h('div', { class: 'empty', text: works.length ? 'ما في أعمال من هالنوع لسا.' : 'لسا ما في أعمال. كون أول واحد بيرفع!' })
    );
  }
  draw();
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
        h('p', { class: 'muted', text: 'ألعاب وبرامج بتشتغل بالمتصفح، ومعرض للأفلام والمسلسلات والأنمي. كله مجاني، ولكل عمل سيرفر محادثة.' })
      ),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/upload', text: 'ارفع عملك' }), h('a', { class: 'btn ghost', href: '#/studios', text: 'اشتغل مع شركاء' }))
    ),
    tabs,
    grid
  );
  return { el, nav: 'store' };
}

// ---------- صفحة العمل ----------
function videoPlayer(work) {
  const frame = h('iframe', {
    class: 'game-frame',
    title: work.title,
    allow: 'fullscreen; picture-in-picture; encrypted-media',
    allowfullscreen: true,
    referrerpolicy: 'strict-origin-when-cross-origin'
  });
  const list = h('div', { class: 'tabs', role: 'group', 'aria-label': 'الحلقات' });
  function play(index) {
    const url = backend.embedUrl(work.episodes[index]);
    if (url) frame.src = url;
    list.replaceChildren(
      ...work.episodes.map((e, i) =>
        h('button', { class: 'tab' + (i === index ? ' active' : ''), type: 'button', 'aria-pressed': i === index ? 'true' : 'false', onClick: () => play(i) }, e.title)
      )
    );
  }
  if (work.episodes.length) play(0);
  return { frame, list: work.episodes.length > 1 ? list : null };
}

async function viewWork(id) {
  const work = await backend.getWork(id);
  const back = h('a', { href: '#/', text: 'رجوع للمتجر' });
  if (!work) return { el: messageBox('العمل مش موجود أو مخفي.', back), nav: 'store' };
  if (work.status === 'removed') return { el: messageBox('هاد العمل انشال من المنصة.', back), nav: 'store' };
  const team = isTeamOf(work);
  let frame;
  let extra = null;
  let playUrl = null;
  if (work.type === 'video') {
    const player = videoPlayer(work);
    frame = player.frame;
    extra = player.list;
  } else {
    playUrl = backend.playUrl(work.buildId, work.entry);
    frame = h('iframe', {
      class: 'game-frame',
      src: playUrl,
      title: work.title,
      sandbox: 'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-modals',
      allow: 'fullscreen; gamepad; autoplay',
      allowfullscreen: true
    });
  }

  let chat = null;
  const chatHost = h('div', { class: 'chat' });
  const channelsEl = h('nav', { class: 'channels', 'aria-label': 'قنوات السيرفر' });
  function selectChannel(channelId) {
    const channel = CHANNELS.find((c) => c.id === channelId);
    channelsEl.querySelectorAll('.channel-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === channelId));
    if (chat) chat.destroy();
    const canPost = !!state.profile && (team || (work.status === 'published' && !channel.teamOnly));
    chat = chatPanel('works/' + work.id, channel, {
      canPost,
      lockedText: channel.teamOnly ? 'بس فريق العمل بيكتب بهاي القناة.' : 'المحادثة مقفلة.',
      canDeleteAll: team || state.isAdmin
    });
    chatHost.replaceChildren(chat.el);
  }
  channelsEl.append(
    h('strong', { class: 'group', text: 'سيرفر ' + work.title }),
    ...CHANNELS.map((c) => h('button', { class: 'channel-btn', type: 'button', 'data-id': c.id, onClick: () => selectChannel(c.id) }, '# ' + c.name))
  );

  const report =
    !state.user || team
      ? null
      : h(
          'details',
          null,
          h('summary', { class: 'small-text', text: 'بلّغ عن هالعمل' }),
          h(
            'form',
            {
              class: 'stack',
              onSubmit: act(async (ev, form) => {
                const reason = formValues(form).reason.trim();
                if (!reason) throw new Error('اكتب سبب البلاغ');
                await backend.reportWork(work.id, reason);
                form.reset();
                toast('وصل بلاغك لمشرفي المنصة');
              })
            },
            field('شو المشكلة؟ (محتوى مسروق، ضار، مسيء…)', h('textarea', { class: 'input', name: 'reason', maxlength: '500', required: true })),
            h('div', { class: 'row' }, h('button', { class: 'btn ghost small', type: 'submit' }, 'ابعت البلاغ'))
          )
        );

  const credits = (work.credits || []).length
    ? h(
        'div',
        { class: 'card grow stack tight' },
        h('span', { class: 'muted small-text', text: 'فريق العمل' }),
        work.credits.map((c) => h('span', null, h('bdi', { text: c.username }), h('span', { class: 'muted', text: ' · ' + c.role })))
      )
    : null;

  const el = h(
    'div',
    { class: 'game-layout' },
    h(
      'section',
      { class: 'game-main', 'aria-labelledby': 'work-title' },
      frame,
      extra,
      h(
        'div',
        { class: 'row between' },
        h(
          'div',
          { class: 'row' },
          h('h1', { id: 'work-title', text: work.title }),
          chip(TYPE_NAMES[work.type] || 'عمل'),
          chip('مجاني', 'accent'),
          work.status === 'hidden' ? chip('مخفي عن المتجر', 'bad') : null
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn ghost small', type: 'button', onClick: () => frame.requestFullscreen && frame.requestFullscreen() }, 'ملء الشاشة'),
          playUrl ? externalLink(playUrl, 'افتح لحاله', 'btn ghost small') : null
        )
      ),
      work.description ? h('p', { class: 'msg-text', text: work.description }) : null,
      h(
        'div',
        { class: 'row' },
        work.controls ? h('div', { class: 'card grow stack tight' }, h('span', { class: 'muted small-text', text: 'طريقة الاستخدام' }), h('span', { class: 'msg-text', text: work.controls })) : null,
        h(
          'div',
          { class: 'card grow stack tight' },
          h('span', { class: 'muted small-text', text: 'من صنع' }),
          h('a', { href: '#/studio/' + work.studioId }, h('strong', { text: work.studioName })),
          team ? h('a', { class: 'small-text', href: work.projectId ? `#/p/${work.projectId}/trials` : '#/mine', text: 'إدارة العمل' }) : null
        ),
        credits
      ),
      report
    ),
    h('section', { class: 'server-panel', 'aria-label': 'سيرفر العمل' }, channelsEl, chatHost)
  );
  selectChannel('general');
  return { el, nav: 'store', destroy: () => chat && chat.destroy() };
}

// ---------- رفع عمل مباشر (من الاستوديو الشخصي) ----------
function typeChoice(current, onChange) {
  return h(
    'div',
    { class: 'choice-group', role: 'radiogroup', 'aria-label': 'نوع العمل' },
    Object.entries(TYPE_NAMES).map(([key, label]) =>
      h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'type', value: key, checked: key === current, required: true, onChange: () => onChange && onChange(key) }), label)
    )
  );
}

async function viewUpload() {
  if (!state.user) return { ...needLogin('لازم يكون عندك حساب عشان ترفع عمل.'), nav: 'upload' };
  const progress = uploadProgress();
  const fileInput = h('input', { class: 'input', type: 'file', name: 'file', accept: '.zip,application/zip', required: true });
  const videoUrl = h('input', { class: 'input', name: 'videoUrl', dir: 'ltr', placeholder: 'https://www.youtube.com/watch?v=...' });
  const episodeTitle = h('input', { class: 'input', name: 'episodeTitle', maxlength: '120', placeholder: 'مثلًا: الحلقة 1، أو الفيلم كامل' });
  const fileBox = h('div', { class: 'stack' }, field('ملف العمل (zip فيه index.html، لحد 100 ميغا)', fileInput));
  const videoBox = h('div', { class: 'stack', hidden: true }, field('رابط الفيديو (YouTube أو Vimeo)', videoUrl), field('عنوان الحلقة أو الفيلم', episodeTitle));
  const controlsField = field('طريقة الاستخدام أو التحكم', h('input', { class: 'input', name: 'controls', maxlength: '500', placeholder: 'مثلًا: الأسهم للحركة، المسافة للقفز' }));
  function setType(type) {
    const video = type === 'video';
    fileBox.hidden = video;
    videoBox.hidden = !video;
    controlsField.hidden = video;
    fileInput.required = !video;
    videoUrl.required = video;
    episodeTitle.required = video;
  }
  const el = h(
    'div',
    { class: 'stack' },
    h('h1', { text: 'ارفع عملك' }),
    h('p', { class: 'muted', text: 'بينتشر فورًا بالمتجر باسم استوديوك الشخصي، وبينعمله سيرفر محادثة. إذا بتشتغل مع شركاء، استخدم «استوديوهاتي» بدل هون.' }),
    h(
      'form',
      {
        class: 'card stack',
        onSubmit: act(async (ev, form) => {
          const v = formValues(form);
          try {
            const workId = await backend.publishWork(
              { type: v.type, title: v.title, description: v.description, controls: v.controls, videoUrl: v.videoUrl, episodeTitle: v.episodeTitle },
              fileInput.files[0],
              progress.track
            );
            toast('انتشر عملك');
            location.hash = '#/work/' + workId;
          } finally {
            progress.hide();
          }
        })
      },
      h('span', { class: 'label', text: 'نوع العمل' }),
      typeChoice('game', setType),
      field('اسم العمل', h('input', { class: 'input', name: 'title', maxlength: '80', required: true })),
      field('وصف قصير', h('textarea', { class: 'input', name: 'description', maxlength: '2000' })),
      controlsField,
      fileBox,
      videoBox,
      h('p', { class: 'muted small-text', text: 'برفعك للعمل إنت بتأكد إنه ملكك أو عندك حق تنشره. الأعمال المنسوخة أو المقتبسة من أعمال غيرك بدون إذن بتنشال.' }),
      progress.el,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'انشر'))
    )
  );
  return { el, nav: 'upload' };
}

// ---------- أعمالي ----------
function manageWork(w) {
  const progress = uploadProgress();
  const hidden = w.status === 'hidden';
  const statusChip = w.status === 'removed' ? chip('انشال من المنصة', 'bad') : hidden ? chip('مخفي') : chip('منشور', 'good');
  const head = h(
    'div',
    { class: 'row between' },
    h('div', { class: 'row' }, h('strong', { text: w.title }), chip(TYPE_NAMES[w.type] || 'عمل'), statusChip),
    h('span', { class: 'muted small-text', text: 'آخر تحديث: ' + fmtTime(w.updatedAt) })
  );
  if (w.status === 'removed') return h('article', { class: 'item' }, head);
  if (w.projectId) {
    return h(
      'article',
      { class: 'item' },
      head,
      h('span', { class: 'muted small-text', text: 'تابع لمشروع مشترك: تعديله ونشر نسخه بيصير من المشروع بموافقة المشاركين.' }),
      h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#/work/' + w.id, text: 'افتح الصفحة' }), h('a', { class: 'btn ghost small', href: `#/p/${w.projectId}/trials`, text: 'افتح المشروع' }))
    );
  }
  const newContent =
    w.type === 'video'
      ? h(
          'details',
          null,
          h('summary', { class: 'small-text', text: 'أضف حلقة' }),
          h(
            'form',
            {
              class: 'stack',
              onSubmit: act(async (ev, form) => {
                await backend.op('addEpisode', { workId: w.id, ...formValues(form) });
                toast('نزلت الحلقة');
                await rerenderNow();
              })
            },
            field('عنوان الحلقة', h('input', { class: 'input', name: 'episodeTitle', maxlength: '120', required: true })),
            field('رابط الفيديو (YouTube أو Vimeo)', h('input', { class: 'input', name: 'videoUrl', dir: 'ltr', required: true })),
            h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'أضف'))
          )
        )
      : h(
          'details',
          null,
          h('summary', { class: 'small-text', text: 'ارفع نسخة جديدة' }),
          h(
            'form',
            {
              class: 'stack',
              onSubmit: act(async (ev, form) => {
                try {
                  await backend.updateWorkBuild(w.id, form.elements.file.files[0], progress.track);
                  toast('نزلت النسخة الجديدة');
                  await rerenderNow();
                } finally {
                  progress.hide();
                }
              })
            },
            field('ملف zip فيه index.html', h('input', { class: 'input', type: 'file', name: 'file', accept: '.zip,application/zip', required: true })),
            progress.el,
            h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'ارفع'))
          )
        );
  return h(
    'article',
    { class: 'item' },
    head,
    h(
      'div',
      { class: 'row' },
      h('a', { class: 'btn small', href: '#/work/' + w.id, text: 'افتح الصفحة' }),
      opButton(hidden ? 'رجّعه للمتجر' : 'أخفيه عن المتجر', 'ghost', () => backend.op('setWorkStatus', { workId: w.id, status: hidden ? 'published' : 'hidden' }), {
        done: hidden ? 'رجع العمل للمتجر' : 'انخفى العمل عن المتجر'
      })
    ),
    h(
      'details',
      null,
      h('summary', { class: 'small-text', text: 'عدّل البيانات' }),
      h(
        'form',
        {
          class: 'stack',
          onSubmit: act(async (ev, form) => {
            await backend.op('updateWorkInfo', { workId: w.id, ...formValues(form) });
            toast('انحفظ');
            await rerenderNow();
          })
        },
        field('اسم العمل', h('input', { class: 'input', name: 'title', maxlength: '80', required: true, value: w.title })),
        field('الوصف', h('textarea', { class: 'input', name: 'description', maxlength: '2000', value: w.description })),
        w.type === 'video' ? null : field('طريقة الاستخدام', h('input', { class: 'input', name: 'controls', maxlength: '500', value: w.controls })),
        h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'احفظ'))
      )
    ),
    newContent
  );
}

async function viewMine() {
  if (!state.user) return { ...needLogin('سجّل دخول عشان تشوف أعمالك.'), nav: 'mine' };
  const works = await backend.listMyWorks();
  const el = h(
    'div',
    { class: 'stack' },
    h('h1', { text: 'أعمالي' }),
    h('p', { class: 'muted', text: 'كل الأعمال اللي إنت من فريقها: اللي نشرتها مباشرة، واللي طلعت من مشاريع مشتركة.' }),
    works.length ? h('div', { class: 'list' }, works.map(manageWork)) : h('div', { class: 'empty' }, 'ما عندك أعمال لسا. ', h('a', { href: '#/upload', text: 'ارفع أول عمل' }))
  );
  return { el, nav: 'mine' };
}

// ---------- صفحة الاستوديو العامة ----------
async function viewStudioPublic(id) {
  const studio = await backend.getStudio(id);
  if (!studio) return { el: messageBox('الاستوديو مش موجود.', h('a', { href: '#/', text: 'رجوع للمتجر' })), nav: 'store' };
  const works = await backend.listStudioWorks(id);
  const mine = !!state.user && studio.members.includes(state.user.uid);
  const el = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'row between' },
      h('div', { class: 'row' }, h('h1', { text: studio.name }), chip(studio.kind === 'personal' ? 'استوديو شخصي' : 'استوديو مشترك')),
      mine ? h('a', { class: 'btn ghost small', href: '#/s/' + id, text: 'مساحة العمل' }) : null
    ),
    h('p', { class: 'muted' }, 'الأعضاء: ', studio.members.map((uid, i) => [i ? '، ' : '', h('bdi', { text: studio.names[uid] })])),
    works.length ? h('div', { class: 'games-grid' }, works.map(workCard)) : h('div', { class: 'empty', text: 'هاد الاستوديو ما نشر أعمال لسا.' })
  );
  return { el, nav: 'store' };
}

// ---------- الدخول ----------
async function viewLogin() {
  if (state.user) {
    location.hash = '#/';
    return { el: h('div') };
  }
  const el = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'auth-grid' },
      h(
        'form',
        {
          class: 'card stack',
          onSubmit: act(async (ev, form) => {
            const v = formValues(form);
            await backend.signIn(v.email.trim(), v.password);
          })
        },
        h('h2', { text: 'دخول' }),
        field('الإيميل', h('input', { class: 'input', type: 'email', name: 'email', autocomplete: 'email', dir: 'ltr', required: true })),
        field('كلمة السر', h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'current-password', dir: 'ltr', required: true })),
        h('button', { class: 'btn', type: 'submit' }, 'دخول'),
        h(
          'button',
          {
            class: 'link-btn small-text',
            type: 'button',
            onClick: act(async (ev, button) => {
              const email = button.form.elements.email.value.trim();
              if (!email) throw new Error('اكتب إيميلك فوق أول');
              await backend.resetPassword(email);
              toast('إذا في حساب بهاد الإيميل، بيوصلك رابط لتغيير كلمة السر');
            })
          },
          'نسيت كلمة السر؟'
        )
      ),
      h(
        'form',
        {
          class: 'card stack',
          onSubmit: act(async (ev, form) => {
            const v = formValues(form);
            await backend.signUp(v.email.trim(), v.password);
          })
        },
        h('h2', { text: 'حساب جديد' }),
        field('الإيميل', h('input', { class: 'input', type: 'email', name: 'email', autocomplete: 'email', dir: 'ltr', required: true })),
        field('كلمة السر (6 أحرف أو أكثر)', h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'new-password', dir: 'ltr', required: true, minlength: '6' })),
        h('button', { class: 'btn', type: 'submit' }, 'اعمل حساب')
      )
    ),
    h('div', { class: 'divider narrow', text: 'أو' }),
    h('div', { class: 'row narrow' }, h('button', { class: 'btn ghost grow', type: 'button', onClick: act(() => backend.signInGoogle()) }, 'كمّل بحساب Google'))
  );
  return { el };
}

// أول دخول: اختيار اسم المستخدم، وبينعمل معه الاستوديو الشخصي
function viewOnboarding() {
  const el = h(
    'form',
    {
      class: 'card stack narrow',
      onSubmit: act(async (ev, form) => {
        await backend.op('createProfile', { username: formValues(form).username });
        applySession(await backend.refreshSession());
        toast('أهلًا فيك بـCilyo');
        await rerenderNow();
      })
    },
    h('h1', { text: 'اختار اسم مستخدم' }),
    h('p', { class: 'muted', text: 'هاد اسمك بالمحادثات، وفيه بيعزموك شركاؤك. وبينعمل فيه استوديوك الشخصي اللي بتنشر منه. اسم الاستوديو بتقدر تغيّره بعدين، أما اسم المستخدم فثابت.' }),
    field('اسم المستخدم (3 لـ24 حرف أو رقم، بدون مسافات)', h('input', { class: 'input', name: 'username', minlength: '3', maxlength: '24', autocomplete: 'username', required: true })),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'كمّل'))
  );
  return { el };
}

// ---------- الإعدادات: الملف الشخصي وربط المساعد ----------
async function viewSettings() {
  if (!state.user) return needLogin();
  const tokenOut = h('div', { class: 'stack' });
  const url = backend.mcpUrl();
  function copyBlock(label, text) {
    return h(
      'div',
      { class: 'stack tight' },
      h('div', { class: 'row between' }, h('strong', { text: label }), h('button', { class: 'btn ghost small', type: 'button', onClick: () => navigator.clipboard.writeText(text).then(() => toast('انسخ')) }, 'انسخ')),
      h('pre', { class: 'code', text })
    );
  }
  function showToken(token) {
    tokenOut.replaceChildren(
      h('p', { class: 'notice', text: 'هاد الرمز بيظهر مرة وحدة بس. لا تشاركه مع حدا: اللي معه الرمز بيقدر يشتغل باسمك بمشاريعك.' }),
      copyBlock('Claude Code (بالتيرمنال، أو تيرمنال VS Code)', `claude mcp add --transport http cilyo ${url} --header "Authorization: Bearer ${token}"`),
      copyBlock('VS Code مع Copilot: ملف .vscode/mcp.json', JSON.stringify({ servers: { cilyo: { type: 'http', url, headers: { Authorization: 'Bearer ' + token } } } }, null, 2))
    );
  }
  const p = state.profile;
  const el = h(
    'div',
    { class: 'stack' },
    h('h1', { text: 'الإعدادات' }),
    h(
      'form',
      {
        class: 'card stack',
        onSubmit: act(async (ev, form) => {
          const v = formValues(form);
          await backend.op('updateProfile', { bio: v.bio, specialties: v.specialties.split(/[,،]/) });
          applySession(await backend.refreshSession());
          toast('انحفظ ملفك');
        })
      },
      h('h2', { text: 'ملفي' }),
      h('p', { class: 'muted small-text' }, 'اسم المستخدم: ', h('strong', null, h('bdi', { text: p.username })), '. تخصصاتك بتظهر للاستوديوهات لما تتقدم لدور.'),
      field('تخصصاتك (افصل بينها بفاصلة، لحد 8)', h('input', { class: 'input', name: 'specialties', maxlength: '300', placeholder: 'برمجة ألعاب، رسم شخصيات، تسويق', value: (p.specialties || []).join('، ') })),
      field('نبذة قصيرة', h('textarea', { class: 'input', name: 'bio', maxlength: '300', value: p.bio || '' })),
      h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit' }, 'احفظ'))
    ),
    h(
      'section',
      { class: 'card stack' },
      h('h2', { text: 'ربط مساعد الـAI' }),
      h('p', { class: 'muted', text: 'مساعدك بـVS Code (Claude Code أو Copilot أو غيرهم) بيشتغل باشتراكك العادي. الموصل بيخليه يعرف مشاريعك بـCilyo: الأدوار والاتفاقات والموافقات، وبيقدر يقترح اتفاقات ويبعت رسائل لشركائك.' }),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: act(async () => {
              if (!window.confirm('إذا عندك رمز قديم رح يوقف. نكمل؟')) return;
              showToken((await backend.op('createConnectorToken', {})).token);
            })
          },
          'اعمل رمز موصل'
        )
      ),
      tokenOut,
      h('span', { class: 'label', text: 'جرّب تحكي مع مساعدك:' }),
      h(
        'ul',
        { class: 'clauses' },
        h('li', { text: '«شو المشاريع اللي أنا فيها بـCilyo؟»' }),
        h('li', { text: '«اقرأ مشروع القلعة بـCilyo وقلي شو أدواري والاتفاقات اللي بتخصني»' }),
        h('li', { text: '«اقترح اتفاق: حدث التقاط المفتاح، من دور أنظمة اللعب لدور الواجهة»' }),
        h('li', { text: '«احكي لشركائي بمحادثة المشروع إني خلصت الباب»' })
      ),
      h('p', { class: 'muted small-text', text: 'المساعد بيتبع نفس قواعد الموقع: ما بيقدر يوافق عن شريكك، ولا يعلّم اتفاق منفّذ إذا مش دورك.' })
    )
  );
  return { el };
}

// ---------- البلاغات (لمشرفي المنصة) ----------
async function viewAdmin() {
  if (!state.isAdmin) return { el: messageBox('هاي الصفحة لمشرفي المنصة بس.', h('a', { href: '#/', text: 'رجوع للمتجر' })) };
  const reports = await backend.listReports();
  const el = h(
    'div',
    { class: 'stack' },
    h('h1', { text: 'البلاغات' }),
    reports.length
      ? h(
          'div',
          { class: 'list' },
          reports.map((r) =>
            h(
              'article',
              { class: 'item' },
              h('p', { class: 'msg-text', text: r.reason }),
              h('span', { class: 'muted small-text', text: fmtTime(r.createdAt) }),
              h(
                'div',
                { class: 'row' },
                h('a', { class: 'btn ghost small', href: '#/work/' + r.workId, text: 'افتح العمل' }),
                opButton(
                  'شيل العمل',
                  'bad',
                  async () => {
                    await backend.op('adminRemoveWork', { workId: r.workId });
                    await backend.resolveReport(r.id);
                  },
                  { confirm: 'تشيل العمل من المنصة؟ ملفاته بتنحذف وما بترجع.', done: 'انشال العمل' }
                ),
                opButton('سكّر البلاغ', 'ghost', () => backend.resolveReport(r.id))
              )
            )
          )
        )
      : h('div', { class: 'empty', text: 'ما في بلاغات.' })
  );
  return { el, nav: 'admin' };
}

// ---------- التنقل ----------
const routes = [
  [/^#?\/?$/, () => viewStore()],
  [/^#\/work\/([A-Za-z0-9]+)$/, (m) => viewWork(m[1])],
  [/^#\/studio\/([A-Za-z0-9]+)$/, (m) => viewStudioPublic(m[1])],
  [/^#\/upload$/, () => viewUpload()],
  [/^#\/mine$/, () => viewMine()],
  [/^#\/board$/, () => viewBoard()],
  [/^#\/studios$/, () => viewStudios()],
  [/^#\/s\/([A-Za-z0-9]+)(?:\/([a-z]+))?$/, (m) => viewStudioSpace(m[1], m[2])],
  [/^#\/p\/([A-Za-z0-9]+)(?:\/([a-z]+))?$/, (m) => viewProject(m[1], m[2])],
  [/^#\/settings$/, () => viewSettings()],
  [/^#\/login$/, () => viewLogin()],
  [/^#\/admin$/, () => viewAdmin()]
];

async function resolveView() {
  if (state.sessionError) {
    return { el: messageBox(state.sessionError.message, h('button', { class: 'link-btn', type: 'button', onClick: () => location.reload() }, 'حمّل الصفحة من جديد')) };
  }
  // مسجّل دخول بس لسا ما اختار اسم مستخدم
  if (state.user && !state.profile) return viewOnboarding();
  const hash = location.hash || '#/';
  const route = routes.find(([re]) => re.test(hash)) || routes[0];
  return route[1](hash.match(route[0]) || []);
}

async function rerenderNow() {
  const seq = ++renderSeq;
  let view;
  try {
    view = await resolveView();
  } catch (err) {
    view = { el: messageBox((err && err.message) || 'صار خطأ', h('a', { href: '#/', text: 'رجوع للمتجر' })) };
  }
  if (seq !== renderSeq) {
    if (view.destroy) view.destroy();
    return;
  }
  if (currentView && currentView.destroy) currentView.destroy();
  currentView = view;
  renderNav(view.nav || null);
  $app.replaceChildren(view.el);
}
setRender(rerenderNow);

window.addEventListener('hashchange', () => {
  rerenderNow();
  $app.focus({ preventScroll: true });
});

(async function start() {
  try {
    await backend.init();
  } catch (err) {
    $app.replaceChildren(messageBox((err && err.message) || 'ما قدرنا نشغّل المنصة'));
    return;
  }
  backend.onSession((session) => {
    const wasLoggedOut = !state.user;
    applySession(session);
    // بعد الدخول: ارجع للصفحة اللي كان بدّه إياها
    if (wasLoggedOut && session.user && (location.hash === '#/login' || sessionStorage.getItem('cilyo.next'))) {
      const next = sessionStorage.getItem('cilyo.next') || '#/';
      sessionStorage.removeItem('cilyo.next');
      const target = next === '#/login' ? '#/' : next;
      if (location.hash !== target) {
        location.hash = target;
        return;
      }
    }
    rerenderNow();
  });
})();
