// Проверка прототипа в Playwright: node tools/test.js [папка-для-скриншотов]
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.argv[2] || path.join(__dirname, '..', 'shots');
const URL = 'file://' + path.join(__dirname, '..', 'index.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
let ok = true;
function check(cond, msg) { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) ok = false; }

async function open(browser, w, h, mobile) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, hasTouch: !!mobile, isMobile: !!mobile });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${w}x${h}] ${m.text()}`); });
  page.on('pageerror', e => errors.push(`[${w}x${h}] ${e.message}`));
  page.on('request', r => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) errors.push('network request: ' + r.url()); });
  await page.goto(URL);
  await sleep(500);
  return { ctx, page };
}
const st = page => page.evaluate(() => ({ state: __rc.state, caught: __rc.run.caught, lives: __rc.run.lives, demo: __rc.run.demo }));

async function screenshots(browser, w, h, name, mobile) {
  const { ctx, page } = await open(browser, w, h, mobile);
  await page.screenshot({ path: `${OUT}/${name}-menu.png` });
  await page.click('[data-act=skins]');
  await sleep(300);
  await page.screenshot({ path: `${OUT}/${name}-skins.png` });
  await page.click('#scrSkins .back');
  await page.click('#btnPlay');
  await sleep(200);
  await page.screenshot({ path: `${OUT}/${name}-levels.png` });
  await page.click('.lvl[data-level="0"]', { force: true });
  // ждём, пока появятся ракеты
  await sleep(2600);
  await page.screenshot({ path: `${OUT}/${name}-game.png` });
  const scroll = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight, innerWidth, innerHeight]);
  check(scroll[0] <= scroll[2] && scroll[1] <= scroll[3], `${name}: нет прокрутки страницы ${scroll}`);
  await ctx.close();
}

// бот: двигает мышь под ракету, которая ближе всего к земле
async function botPlay(page, maxMs, avoid) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await page.evaluate(() => {
      const r = __rc.run, L = __rc.layout;
      let best = null;
      for (const k of r.rockets) if (!best || k.t > best.t) best = k;
      if (!best && r.warns.length) best = r.warns[0];
      return { state: __rc.state, x: best ? __rc.toPx(best.x) : null, fx: best ? best.x : null, FX: L.FX, FW: L.FW, H: innerHeight };
    });
    if (s.state !== 'play' && s.state !== 'ending') return s.state;
    if (s.x != null) {
      let x = s.x;
      if (avoid) x = s.fx > 0.5 ? s.FX + 5 : s.FX + s.FW - 5; // убегаем от ракеты
      await page.mouse.move(x, s.H * 0.6);
    }
    await sleep(30);
  }
  return 'timeout';
}

(async () => {
  const browser = await chromium.launch();
  await screenshots(browser, 390, 844, 'phone-portrait', true);
  await screenshots(browser, 844, 390, 'phone-landscape', true);
  await screenshots(browser, 1280, 800, 'desktop', false);

  // прохождение уровня 1 ботом
  {
    const { ctx, page } = await open(browser, 1280, 800, false);
    await page.click('#btnPlay');
    await page.click('.lvl[data-level="0"]', { force: true });
    const t0 = Date.now();
    const end = await botPlay(page, 60000, false);
    await sleep(1600);
    const s = await st(page);
    check(s.state === 'win', `уровень 1 пройден ботом за ${((Date.now() - t0) / 1000).toFixed(1)} c (state=${s.state}, поймано ${s.caught}, жизней ${s.lives})`);
    await page.screenshot({ path: `${OUT}/desktop-win.png` });
    const sv = await page.evaluate(() => JSON.parse(localStorage.getItem('rocketCatch.v1')));
    check(sv && sv.passed >= 1 && sv.total >= 10, `сохранение: passed=${sv && sv.passed}, total=${sv && sv.total}`);
    // перезагрузка — уровень 2 открыт
    await page.reload(); await sleep(400);
    await page.click('#btnPlay');
    const open2 = await page.$('.lvl[data-level="1"]');
    check(!!open2, 'после перезагрузки уровень 2 открыт');
    const locked3 = await page.$('.lvl[data-level="2"]');
    check(!locked3, 'уровень 3 ещё закрыт');
    await page.screenshot({ path: `${OUT}/desktop-levels-after-win.png` });
    await ctx.close();
  }

  // пропуск ракеты отнимает жизнь, 0 жизней → проигрыш (телефон, тач)
  {
    const { ctx, page } = await open(browser, 390, 844, true);
    await page.tap('#btnPlay');
    await page.tap('.lvl[data-level="0"]', { force: true });
    let s = await st(page);
    check(s.lives === 3, 'в начале 3 жизни');
    // тап пальцем в левый край — игрок едет туда
    await page.touchscreen.tap(20, 500);
    await sleep(500);
    const px = await page.evaluate(() => __rc.run.player.x);
    check(px < 0.2, `тап влево двигает игрока (x=${px.toFixed(2)})`);
    // убегаем от ракет мышью нельзя на мобиле — используем клавиатуру/тапы
    let firstLossSeen = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      const r = await page.evaluate(() => {
        const r = __rc.run; let best = null;
        for (const k of r.rockets) if (!best || k.t > best.t) best = k;
        return { state: __rc.state, lives: r.lives, fx: best ? best.x : null };
      });
      if (r.lives === 2 && !firstLossSeen) { firstLossSeen = true; check(true, 'пропуск ракеты: жизней стало 2'); await page.screenshot({ path: `${OUT}/phone-portrait-miss.png` }); }
      if (r.state === 'lose' ) break;
      if (r.fx != null) await page.touchscreen.tap(r.fx > 0.5 ? 10 : 380, 500);
      await sleep(80);
    }
    await sleep(300);
    s = await st(page);
    check(firstLossSeen, 'жизнь отнимается при пропуске');
    check(s.state === 'lose' && s.lives === 0, `0 жизней → экран проигрыша (state=${s.state})`);
    const vis = await page.isVisible('#scrLose');
    check(vis, 'экран «Ой-ой!» виден');
    await page.screenshot({ path: `${OUT}/phone-portrait-lose.png` });
    await page.tap('#scrLose [data-act=restart]');
    s = await st(page);
    check(s.state === 'play' && s.lives === 3, '«Ещё раз» запускает уровень заново');
    // пауза
    await page.tap('#btnPause');
    s = await st(page);
    check(s.state === 'pause', 'кнопка паузы');
    await page.screenshot({ path: `${OUT}/phone-portrait-pause.png` });
    await ctx.close();
  }

  // клавиатура
  {
    const { ctx, page } = await open(browser, 1280, 800, false);
    await page.click('#btnPlay');
    await page.click('.lvl[data-level="0"]', { force: true });
    const x0 = await page.evaluate(() => __rc.run.player.x);
    await page.keyboard.down('ArrowLeft'); await sleep(300); await page.keyboard.up('ArrowLeft');
    const x1 = await page.evaluate(() => __rc.run.player.x);
    await page.keyboard.down('KeyD'); await sleep(500); await page.keyboard.up('KeyD');
    const x2 = await page.evaluate(() => __rc.run.player.x);
    check(x1 < x0 - 0.1 && x2 > x1 + 0.2, `стрелки/A-D двигают игрока (${x0.toFixed(2)} → ${x1.toFixed(2)} → ${x2.toFixed(2)})`);
    await page.keyboard.down('ArrowRight'); await sleep(2000); await page.keyboard.up('ArrowRight');
    const x3 = await page.evaluate(() => [__rc.run.player.x, 1 - __rc.layout.minX]);
    check(Math.abs(x3[0] - x3[1]) < 1e-6, 'игрок не уезжает за край');
    // звук
    await page.click('#btnSound');
    const muted = await page.evaluate(() => __rc.save.muted);
    check(muted === true, 'кнопка звука выключает звук');
    await page.keyboard.press('Escape');
    check((await st(page)).state === 'pause', 'Esc ставит паузу');
    await ctx.close();
  }

  await browser.close();
  check(errors.length === 0, 'ошибок в консоли нет' + (errors.length ? ':\n  ' + errors.join('\n  ') : ''));
  process.exit(ok ? 0 : 1);
})();
