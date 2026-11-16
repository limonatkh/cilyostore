# جولة كاملة على الواجهة بثلاث مستخدمين، على السيرفر التجريبي (tests/ui/serve.js).
# التشغيل: node tests/ui/serve.js &   ثم   python3 tests/ui/walk.py [مجلد الصور]
import asyncio, io, json, os, sys, urllib.request, zipfile
from playwright.async_api import async_playwright

B = os.environ.get('CILYO_URL', 'http://localhost:4600')
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/cilyo-shots'
os.makedirs(OUT, exist_ok=True)
errors = []
steps = []
pages = {}


def game_zip(name, body):
    p = os.path.join(OUT, name)
    with zipfile.ZipFile(p, 'w') as z:
        z.writestr('index.html', f'<!doctype html><body style="background:#234;color:#fff;font:32px sans-serif"><h1>{body}</h1></body>')
        z.writestr('js/main.js', 'console.log("game")')
    return p


def ok(label):
    steps.append(label)
    print('OK  ', label)


async def new_user(browser, name, mobile=False):
    ctx = await browser.new_context(viewport={'width': 390, 'height': 844} if mobile else {'width': 1366, 'height': 900}, locale='ar')
    page = await ctx.new_page()
    pages[name] = page

    def on_console(m):
        if m.type == 'error' and 'youtube' not in m.text and 'ERR_' not in m.text:
            errors.append(f'{name}: {m.text}')
    page.on('console', on_console)
    page.on('pageerror', lambda e: errors.append(f'{name} pageerror: {e}'))
    page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
    await page.goto(B + '/#/login')
    form = page.locator('form:has(h2:text-is("حساب جديد"))')
    await form.locator('input[name=email]').fill(f'{name}@test.com')
    await form.locator('input[name=password]').fill('secret1')
    await form.locator('button[type=submit]').click()
    await page.wait_for_selector('text=اختار اسم مستخدم')
    await page.fill('input[name=username]', name)
    await page.click('button:has-text("كمّل")')
    await page.wait_for_selector('#account strong')
    pages[name] = page
    return ctx, page


async def go(page, hash_, wait):
    target = B + '/' + hash_
    if page.url == target:
        await page.reload()  # نفس الرابط: المتصفح ما بيعيد التحميل لحاله
    else:
        await page.goto(target)
    await page.wait_for_selector(wait)


async def shot(page, name):
    await page.wait_for_timeout(350)
    await page.screenshot(path=f'{OUT}/{name}.png', full_page=True)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/google-chrome')
        try:
            await walk(browser)
        except Exception:
            # عند الفشل: صورة لكل صفحة مع آخر رسالة ظاهرة
            for name, page in pages.items():
                try:
                    await page.screenshot(path=f'{OUT}/fail-{name}.png', full_page=True)
                    print(f'FAIL {name}: url={page.url} toast={await page.locator("#toast").inner_text()!r}')
                except Exception as e:
                    print('could not capture', name, e)
            print('CONSOLE ERRORS:', errors)
            raise
        await browser.close()
    print(f'\n{len(steps)} steps passed')
    print('CONSOLE ERRORS:', errors if errors else 'none')
    if errors:
        sys.exit(1)


async def walk(browser):
    if True:
        ca, a = await new_user(browser, 'imad')
        cb, b = await new_user(browser, 'sameer')
        cc, c = await new_user(browser, 'lina')
        ok('ثلاث حسابات مع اختيار اسم المستخدم')

        # ---- نشر مباشر: لعبة ----
        await go(a, '#/upload', 'input[name=title]')
        await a.fill('input[name=title]', 'لعبة الليمون')
        await a.fill('textarea[name=description]', 'لعبة تجريبية')
        await a.set_input_files('input[type=file]', game_zip('solo.zip', 'Solo game'))
        await a.click('button:has-text("انشر")')
        await a.wait_for_selector('.game-frame')
        work_url = a.url
        frame = a.frame_locator('.game-frame')
        await frame.locator('h1').wait_for()
        assert await frame.locator('h1').inner_text() == 'Solo game'
        ok('رفع لعبة وتشغيلها من موقع الألعاب المنفصل')
        await b.goto(work_url)
        await b.wait_for_selector('.composer input')
        await a.fill('.composer input', 'أهلًا باللاعبين')
        await a.click('.composer button')
        await b.wait_for_selector('text=أهلًا باللاعبين', timeout=5000)
        ok('رسالة بسيرفر العمل بتوصل للثاني لحظيًا')
        await b.click('button.channel-btn:has-text("أخبار")')
        await b.wait_for_selector('text=بس فريق العمل بيكتب بهاي القناة')
        await b.click('summary:has-text("بلّغ عن هالعمل")')
        await b.fill('textarea[name=reason]', 'تجربة بلاغ')
        await b.click('button:has-text("ابعت البلاغ")')
        await b.wait_for_selector('.toast.show:has-text("وصل بلاغك")')
        await shot(a, '01-work')
        ok('قناة الأخبار للفريق بس، والبلاغ بيوصل')

        # ---- نشر مباشر: عمل مرئي ----
        await go(a, '#/upload', 'input[name=title]')
        await a.click('label.choice:has-text("عمل مرئي")')
        await a.fill('input[name=title]', 'مسلسل الليمون')
        await a.fill('input[name=videoUrl]', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
        await a.fill('input[name=episodeTitle]', 'الحلقة 1')
        await a.click('button:has-text("انشر")')
        await a.wait_for_selector('.game-frame')
        src = await a.get_attribute('.game-frame', 'src')
        assert src == 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', src
        ok('نشر عمل مرئي برابط YouTube')
        await go(a, '#/mine', '.list')
        await a.locator('article.item', has_text='مسلسل الليمون').locator('summary:has-text("أضف حلقة")').click()
        await a.fill('input[name=episodeTitle]', 'الحلقة 2')
        await a.fill('input[name=videoUrl]', 'https://vimeo.com/123456789')
        await a.locator('article.item', has_text='مسلسل الليمون').locator('button:has-text("أضف")').click()
        await a.wait_for_selector('.toast.show:has-text("نزلت الحلقة")')
        await a.locator('article.item', has_text='لعبة الليمون').locator('button:has-text("أخفيه عن المتجر")').click()
        await a.wait_for_selector('button:has-text("رجّعه للمتجر")')
        await go(b, '#/', '.tabs')
        assert await b.locator('.game-card:has-text("لعبة الليمون")').count() == 0
        await a.click('button:has-text("رجّعه للمتجر")')
        await a.wait_for_selector('button:has-text("أخفيه عن المتجر")')
        await go(b, '#/', '.game-card:has-text("لعبة الليمون")')
        await b.click('button.tab:has-text("المعرض المرئي")')
        assert await b.locator('.game-card').count() == 1
        await shot(b, '02-store')
        ok('أعمالي: حلقة جديدة، وإخفاء وإرجاع، وفلتر المعرض')

        # ---- استوديو مشترك وعقده ----
        await go(a, '#/studios', 'form:has(h2:text-is("أنشئ استوديو مشترك"))')
        await a.fill('form:has(h2:text-is("أنشئ استوديو مشترك")) input[name=name]', 'استوديو القلعة')
        await a.click('form:has(h2:text-is("أنشئ استوديو مشترك")) button[type=submit]')
        await a.wait_for_selector('text=الاستوديو ما بيفتح قبل')
        studio_hash = a.url.split('#')[1].rsplit('/', 1)[0]
        await a.fill('input[name=username]', 'sameer')
        await a.click('button:has-text("اعزم")')
        await a.wait_for_selector('text=معزوم، لسا ما رد')
        await go(b, '#/studios', 'text=دعوة لاستوديو: استوديو القلعة')
        await shot(b, '03-invites')
        await b.click('text=شوف العقد وقرّر')
        await b.wait_for_selector('h1:has-text("دعوة لاستوديو")')
        await b.click('button:has-text("اقبل")')
        await b.wait_for_selector('button:has-text("أوافق على العقد وأوقّع")')
        await b.click('button:has-text("أوافق على العقد وأوقّع")')
        await b.wait_for_selector('text=وقّعت على هالنسخة')
        await a.wait_for_selector('.chip:has-text("وقّع العقد")', timeout=6000)
        await shot(a, '04-contract')
        await a.click('button:has-text("أوافق على العقد وأوقّع")')
        await a.wait_for_selector('h2:text-is("مشروع جديد")')
        ok('استوديو مشترك: دعوة، قبول، توقيع الطرفين، وانفتح')

        # ---- مشروع وميثاق ----
        await a.fill('form:has(h2:text-is("مشروع جديد")) input[name=name]', 'القلعة والمفتاح')
        await a.fill('input[name=repoUrl]', 'https://github.com/limonatkh/castle')
        await a.click('button:has-text("أنشئ المشروع")')
        await a.wait_for_selector('h2:text-is("عدّل الميثاق (للقائد)")')
        proj = a.url.split('#')[1].rsplit('/', 1)[0]
        rows = a.locator('form:has(h2:text-is("عدّل الميثاق (للقائد)")) .list > .item')
        await rows.nth(0).locator('[data-f=name]').fill('أنظمة اللعب')
        await rows.nth(0).locator('[data-f=holderUid]').select_option(label='imad')
        await rows.nth(0).locator('[data-f=weight]').fill('60')
        await a.click('button:has-text("أضف دور")')
        await rows.nth(1).locator('[data-f=name]').fill('التسويق')
        await rows.nth(1).locator('[data-f=kind]').select_option('service')
        await rows.nth(1).locator('[data-f=holderUid]').select_option(label='sameer')
        await rows.nth(1).locator('[data-f=weight]').fill('40')
        await rows.nth(1).locator('[data-f=periods]').fill('4')
        await a.click('button:has-text("احفظ الميثاق")')
        await a.wait_for_selector('h2:text-is("الأدوار")')
        await go(b, '#' + proj + '/charter', 'button:has-text("أوافق على الميثاق وأوقّع")')
        await b.click('button:has-text("أوافق على الميثاق وأوقّع")')
        await b.wait_for_selector('.chip:has-text("موقّع من الكل")')
        ok('مشروع: القائد كتب الأدوار، والشريك وقّع الميثاق')

        # ---- اتفاق وموافقة ----
        await go(a, '#' + proj + '/agreements', 'form:has(h2:text-is("اقترح اتفاق"))')
        await a.fill('input[name=title]', 'اللاعب بيقفز مترين')
        await a.select_option('select[name=fromRoleId]', index=1)
        await a.select_option('select[name=toRoleId]', index=2)
        await a.click('button:has-text("اقترح")')
        await a.wait_for_selector('article.item .chip:has-text("مقترح")')
        await go(b, '#' + proj + '/approvals', 'article.item:has-text("اتفاق جديد")')
        await shot(b, '05-approvals')
        await b.click('article.item button:has-text("موافق")')
        await b.wait_for_selector('text=ما في طلبات مفتوحة')
        await a.wait_for_selector('button:has-text("علّمه منفّذ")', timeout=6000)
        await a.click('button:has-text("علّمه منفّذ")')
        await a.wait_for_selector('.chip:has-text("منفّذ")')
        await go(b, '#' + proj + '/agreements', 'button:has-text("جرّبته، اعتمده")')
        await b.click('button:has-text("جرّبته، اعتمده")')
        await b.wait_for_selector('.chip:has-text("معتمد")')
        await shot(b, '06-agreements')
        ok('اتفاق: اقتراح، موافقة، منفّذ، معتمد (مع تحديث لحظي)')

        # ---- تسليم دور وكسب الحصة ----
        await go(a, '#' + proj + '/charter', 'summary:has-text("اطلب اعتماد التسليم")')
        await a.click('summary:has-text("اطلب اعتماد التسليم")')
        await a.fill('article.item textarea[name=text]', 'خلصت الحركة والقفز')
        await a.click('button:has-text("ابعت للاعتماد")')
        await a.wait_for_selector('text=طلب الاعتماد بيستنى الشركاء')
        await go(b, '#' + proj + '/approvals', 'article.item:has-text("اعتماد تسليم دور")')
        await b.click('article.item button:has-text("موافق")')
        await go(a, '#' + proj + '/charter', 'h2:text-is("الحصص الحالية")')
        row = a.locator('tbody tr', has_text='imad')
        assert '54%' in await row.inner_text(), await row.inner_text()
        await shot(a, '07-charter')
        ok('الحصص: imad كسب 60 نقطة = 54% (بعد 10% للاستوديو)')

        # ---- نسخة تجريبية ونشر بموافقة الكل ----
        await go(a, '#' + proj + '/trials', 'form:has(h2:text-is("ارفع نسخة للتجربة"))')
        await a.set_input_files('input[type=file]', game_zip('castle.zip', 'Castle v1'))
        await a.fill('form:has(h2:text-is("ارفع نسخة للتجربة")) input[name=note]', 'أول نسخة')
        await a.click('form:has(h2:text-is("ارفع نسخة للتجربة")) button[type=submit]')
        await a.wait_for_selector('article.item:has-text("أول نسخة")')
        await a.click('summary:has-text("اطلب نشرها بالمتجر")')
        await a.fill('article.item input[name=title]', 'القلعة والمفتاح')
        await a.click('article.item button:has-text("اطلب النشر")')
        await a.wait_for_selector('text=في طلب نشر مفتوح')
        await go(b, '#/', '.tabs')
        assert await b.locator('.game-card:has-text("القلعة والمفتاح")').count() == 0
        await go(b, '#' + proj + '/approvals', 'article.item:has-text("نشر «القلعة والمفتاح»")')
        await b.click('article.item button:has-text("موافق")')
        await b.wait_for_selector('text=ما في طلبات مفتوحة')
        await go(b, '#/', '.game-card:has-text("القلعة والمفتاح")')
        await b.click('.game-card:has-text("القلعة والمفتاح")')
        await b.wait_for_selector('text=فريق العمل')
        assert await b.frame_locator('.game-frame').locator('h1').inner_text() == 'Castle v1'
        credits = await b.locator('.card:has-text("فريق العمل")').inner_text()
        assert 'أنظمة اللعب' in credits and 'التسويق' in credits, credits
        await b.click('button.channel-btn:has-text("أخبار")')
        await b.wait_for_selector('.composer input')
        await shot(b, '08-published')
        ok('النشر: ما انتشر قبل موافقة الثاني، وبعدها نزل بالمتجر بأسماء الأدوار')

        # ---- محادثة المشروع ----
        await go(a, '#' + proj + '/chat', '.composer input')
        await go(b, '#' + proj + '/chat', '.composer input')
        await b.fill('.composer input', 'مبروك النشر')
        await b.click('.composer button')
        await a.wait_for_selector('text=مبروك النشر', timeout=5000)
        await shot(a, '09-project-chat')
        ok('محادثة المشروع الخاصة لحظية')

        # ---- لوحة الفرص ----
        await go(b, '#' + studio_hash + '/roles', 'form:has(h2:text-is("انشر دور مفتوح"))')
        await b.fill('input[name=title]', 'مطلوب مصمم شخصيات')
        await b.fill('textarea[name=description]', 'رسم شخصيات للعبة القلعة')
        await b.click('button:has-text("انشر")')
        await b.wait_for_selector('article.item:has-text("مطلوب مصمم شخصيات")')
        await go(c, '#/settings', 'input[name=specialties]')
        await c.fill('input[name=specialties]', 'رسم شخصيات، أنيميشن')
        await c.click('form:has(h2:text-is("ملفي")) button[type=submit]')
        await c.wait_for_selector('.toast.show:has-text("انحفظ ملفك")')
        await go(c, '#/board', 'article.item:has-text("مطلوب مصمم شخصيات")')
        await c.click('summary:has-text("تقدّم للدور")')
        await c.fill('textarea[name=message]', 'عندي خبرة برسم الشخصيات')
        await c.click('button:has-text("ابعت")')
        await c.wait_for_selector('text=تقدّمت لهاد الدور')
        await shot(c, '10-board')
        await go(b, '#' + studio_hash + '/roles', 'text=عندي خبرة برسم الشخصيات')
        await b.wait_for_selector('.chip:has-text("أنيميشن")')
        ok('الفرص: نشر دور، تقديم بتخصصات، والاستوديو شاف الطلب')

        # ---- ضيف بالمشروع ----
        await go(a, '#' + proj + '/settings', 'input[name=username]')
        await a.fill('input[name=username]', 'lina')
        await a.click('button:has-text("اعزم")')
        await a.wait_for_selector('text=معزوم، لسا ما رد')
        await go(c, '#/studios', 'text=دعوة لمشروع: القلعة والمفتاح')
        await c.click('text=شوف الميثاق وقرّر')
        await c.wait_for_selector('h2:text-is("الميثاق الحالي")')
        await shot(c, '11-project-invite')
        await c.click('button:has-text("اقبل وانضم")')
        await c.wait_for_selector('button:has-text("أوافق على الميثاق وأوقّع")')
        ok('ضيف من برا الاستوديو انضم للمشروع ولازم يوقّع الميثاق')

        # ---- موصل المساعد ----
        await go(a, '#/settings', 'button:has-text("اعمل رمز موصل")')
        await a.click('button:has-text("اعمل رمز موصل")')
        await a.wait_for_selector('pre.code')
        cmd = await a.locator('pre.code').first.inner_text()
        token = cmd.split('Bearer ')[1].rstrip('"')
        req = urllib.request.Request(B + '/mcp', data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'cilyo_list_projects', 'arguments': {}}}).encode(), headers={'content-type': 'application/json', 'authorization': 'Bearer ' + token})
        res = json.loads(urllib.request.urlopen(req).read())
        listed = json.loads(res['result']['content'][0]['text'])
        assert listed['projects'][0]['name'] == 'القلعة والمفتاح', listed
        await shot(a, '12-settings')
        ok('موصل المساعد: الرمز من الواجهة اشتغل مع MCP')

        # ---- مشرف المنصة ----
        uid = json.loads(await a.evaluate('sessionStorage.getItem("t.user")'))['uid']
        urllib.request.urlopen(urllib.request.Request(B + '/t/admin', data=json.dumps({'uid': uid}).encode(), headers={'content-type': 'application/json'}))
        await a.reload()
        await a.wait_for_selector('#nav a:has-text("البلاغات")')
        await go(a, '#/admin', 'article.item:has-text("تجربة بلاغ")')
        await a.click('button:has-text("سكّر البلاغ")')
        await a.wait_for_selector('text=ما في بلاغات')
        ok('المشرف شاف البلاغ وسكّره')

        # ---- السجل والصفحات العامة ----
        await go(a, '#' + proj + '/log', '.list .item')
        await shot(a, '13-log')
        await go(c, '#/studio/' + studio_hash.split('/')[2], 'h1:has-text("استوديو القلعة")')
        assert await c.locator('.game-card').count() == 1

        # ---- موبايل ----
        cm = await browser.new_context(viewport={'width': 390, 'height': 844}, locale='ar')
        m = await cm.new_page()
        m.on('pageerror', lambda e: errors.append(f'mobile pageerror: {e}'))
        await m.goto(B + '/')
        await m.evaluate(f'sessionStorage.setItem("t.user", {json.dumps(json.dumps({"uid": uid, "email": "imad@test.com"}))})')
        for h_, sel, name in [('#' + proj + '/charter', 'h2:text-is("الأدوار")', '14-mobile-charter'), ('#/', '.games-grid', '15-mobile-store'), (work_url.split('/', 3)[3], '.game-frame', '16-mobile-work')]:
            await m.goto(B + '/' + h_)
            await m.reload()
            await m.wait_for_selector(sel)
            await shot(m, name)
            width = await m.evaluate('document.documentElement.scrollWidth')
            assert width <= 392, f'{name}: horizontal scroll {width}'
        ok('الموبايل: بدون تمرير أفقي')


asyncio.run(main())
