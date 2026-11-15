// 第一步：登录
// 打开一个真实 Chrome 窗口，由你自己完成登录（微信扫码或账号密码）。
// 登录成功后，会话（cookie + localStorage）留在 .browser-profile/ 里，
// 后续的探测和导出都复用它 —— 不做任何模拟登录/伪造令牌。
import { launch, PHOTO_PAGE, looksLoggedOut, loginHint } from './browser.mjs';

const TIMEOUT_MS = 15 * 60 * 1000;

async function stillOnLoginUi(page) {
  const u = page.url();
  if (looksLoggedOut(u)) return true;
  try {
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000));
    // 页面上还挂着登录引导 = 没登录成功
    if (/扫码登录|微信登录|登录后可|请先登录|立即登录/.test(text)) return true;
  } catch {
    /* 页面跳转中，忽略 */
  }
  return false;
}

export async function login({ headless = false } = {}) {
  const ctx = await launch({ headless });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  console.log('\n============================================================');
  console.log('  浏览器已打开。请在弹出的 Chrome 窗口里完成登录：');
  console.log('  · 微信扫码 或 账号密码登录，和你平时登录的方式一样');
  console.log('  · 看到「照片」列表页即为成功，脚本会自动继续');
  console.log('  · 请勿关闭该窗口；最多等待 15 分钟');
  console.log('============================================================\n');

  await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const started = Date.now();
  let ok = false;
  while (Date.now() - started < TIMEOUT_MS) {
    await page.waitForTimeout(2500);
    if (page.isClosed()) {
      console.log('窗口被关闭，登录中止。');
      await ctx.close().catch(() => {});
      process.exit(1);
    }
    if (!(await stillOnLoginUi(page))) {
      ok = true;
      break;
    }
    const left = Math.ceil((TIMEOUT_MS - (Date.now() - started)) / 1000);
    process.stdout.write(`\r等待登录中… 剩余 ${left}s   `);
  }
  process.stdout.write('\n');

  const hint = await loginHint(page);
  console.log('当前页面：', hint.url);
  console.log('会话 cookie 数量：', hint.cookies.length, '| localStorage 键：', hint.localStorageKeys);

  if (!ok) {
    console.log('\n没有检测到登录成功。可以重试：npm run login');
    await ctx.close().catch(() => {});
    process.exit(2);
  }

  // 稳定一下，确保令牌已落盘
  await page.waitForTimeout(2000);
  console.log('\n✅ 登录信息已保存到 .browser-profile/');
  console.log('   ⚠️ 这个目录等同于你的登录态，不要发给别人、不要提交到 git。');
  console.log('\n下一步：npm run probe\n');
  await ctx.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  login({ headless: process.argv.includes('--headless') }).catch((e) => {
    console.error('登录流程出错：', e.message);
    process.exit(1);
  });
}
