// 端到端测试：仿后台界面（日期弹窗 / 成员弹窗 / 网格 / 预览 / 下载 / 缓存清理）
import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const APP = url.pathToFileURL(path.join(DIR, '..', 'extension', 'app.html')).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-test-'));

const T = 1794738886000; // 2026-11-15 18:34:46 +08

const ITEMS = [
  { seq: 111, userNickname: '张伟', userID: 'u1', time: T, mediaType: 0, largeURL: 'https://cdn/a.jpg', videoURL: '', smallURL: 'https://cdn/a.jpg?w=300', temporaryPhotoThaw: { isRestricted: false }, isLimitViewByPhotoCount: false },
  { seq: 112, userNickname: '王芳', userID: 'u2', time: T + 60000, mediaType: 1, largeURL: 'https://cdn/b.mp4', videoURL: 'https://cdn/b.mp4', smallURL: '', temporaryPhotoThaw: { isRestricted: false }, isLimitViewByPhotoCount: false },
  { seq: 113, userNickname: '李四', userID: 'u3', time: T + 120000, mediaType: 0, largeURL: 'https://cdn/c.jpg', videoURL: '', smallURL: '', temporaryPhotoThaw: { isRestricted: true }, isLimitViewByPhotoCount: false },
  { seq: 114, userNickname: '张伟', userID: 'u1', time: T + 180000, mediaType: 0, largeURL: 'https://cdn/d.jpg', videoURL: '', smallURL: '', temporaryPhotoThaw: { isRestricted: false }, isLimitViewByPhotoCount: false },
];

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  viewport: { width: 1280, height: 1000 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

await page.addInitScript(
  ({ ITEMS }) => {
    window.__written = [];
    window.__fs = new Map();

    const GROUP = {
      group_name: '测试团队',
      vip_info: { expire_time: Math.floor(Date.now() / 1000) + 5 * 86400 },
      user_list: [
        { user_id: 'u1', nickname: '张伟', user_status: 1 },
        { user_id: 'u2', nickname: '王芳', user_status: 1 },
        { user_id: 'u3', nickname: '李四', user_status: 1 },
      ],
    };
    const WM_DEFS = [
      { name: '打卡水印', group_watermark_id: 'G_A', watermark_base_id: '21', type: 1 },
      { name: '索赔照片', group_watermark_id: 'G_B', watermark_base_id: '21', type: 1 },
    ];

    const impl = {
      ipContext: () => ({ loggedIn: true, groupID: 'g', group: GROUP }),
      ipMe: () => ({ userID: 'me-123', nickname: '王强' }),
      ipDept: (a) => {
        if (String(a.deptID) === '0') return { department: [{ id: '3537', name: '技术', num: 2 }], member: [{ user_id: 'u3' }] };
        if (String(a.deptID) === '3537') return { department: [], member: [{ user_id: 'u1' }, { user_id: 'u2' }] };
        return { department: [], member: [] };
      },
      ipWatermarks: () => WM_DEFS,
      ipList: (a) => {
        let list = ITEMS;
        if (a.userIDs && a.userIDs.length) list = list.filter((x) => a.userIDs.includes(x.userID));
        const wm = (a.watermarks || [])[0];
        if (wm) {
          list = wm.groupWatermarkID === 'G_A' ? list.filter((x) => [111, 112, 114].includes(x.seq)) : list.filter((x) => x.seq === 113);
        }
        const idx = a.cursor ? Number(a.cursor) : 0;
        const slice = list.slice(idx, idx + 3);
        return { total: list.length, lastPageCond: idx + 3 < list.length ? String(idx + 3) : '', photos: slice };
      },
    };

    window.chrome = window.chrome || {};
    window.__calls = { created: [] };
    window.chrome.tabs = {
      query: async () => [{ id: 7, url: 'https://www.5181688.com/photo/all', status: 'complete' }],
      get: async () => ({ id: 7, status: 'complete' }),
      create: async (o) => {
        window.__calls.created.push(o);
        return { id: 7 };
      },
    };
    const kvStore = JSON.parse(new URLSearchParams(location.search).get('seed') || '{}');
    window.chrome.storage = {
      local: {
        get: async (k) => ({ [k]: kvStore[k] }),
        set: async (o) => Object.assign(kvStore, o),
      },
    };
    window.chrome.scripting = {
      executeScript: async ({ func, args }) => [{ result: impl[func.name]((args && args[0]) || {}) }],
    };

    const mkDir = (p) => ({
      name: p.split('/').pop(),
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getDirectoryHandle: async (n) => mkDir(`${p}/${n}`),
      getFileHandle: async (n) => {
        const full = `${p}/${n}`;
        return {
          createWritable: async () => ({
            write: async (buf) => {
              window.__fs.set(full, buf.byteLength);
              window.__written.push({ path: full, bytes: buf.byteLength });
            },
            close: async () => {},
          }),
          getFile: async () => ({ size: window.__fs.get(full) || 0 }),
        };
      },
    });
    window.showDirectoryPicker = async () => mkDir('OUT');
    // 直连通道：扩展页 fetch 到 webapi，按路径返回真实形状的 JSON
    window.fetch = async (url, opts) => {
      const u = String(url);
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      const json = (payload) => ({ ok: true, status: 200, json: async () => payload });
      if (u.includes('webapi.5181688.com')) {
        if (u.includes('/web/workgroup/v2/currentuser')) {
          return json({ data: { user_id: 'me-123', nickname: '王强', groups: [{ group_id: 'g', group_name: '测试团队' }] } });
        }
        if (u.includes('/web/workgroup/v3/query/group')) return json({ data: GROUP });
        if (u.includes('/web/department/v2/tree')) return json({ data: impl.ipDept({ deptID: String((body.departmentIDList || [0])[0]) }) });
        if (u.includes('/v4/workgroup/watermarks')) return json({ data: { payload: WM_DEFS } });
        if (u.includes('/v5/workgroup/photos/notvip/count')) return json({ status: 0, isVip: 1, photoCount: 0 });
        if (u.includes('/v5/workgroup/photos')) {
          const p = impl.ipList({ userIDs: body.filter.userIDList, cursor: body.lastPageCond, watermarks: body.filter.watermarks });
          return json({ status: 0, payload: p });
        }
        return json({ data: null });
      }
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(4096).buffer };
    };
  },
  { ITEMS },
);

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => d.accept());

await page.goto(APP);
await page.waitForTimeout(1000);

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  → ' + extra : ''}`);
};
const logTail = async () => (await page.textContent('#log')).split('\n').slice(-2).join(' | ');
const mediaWrites = () => page.evaluate(() => window.__written.filter((w) => !w.path.includes('_manifest')).map((w) => w.path));

// ① 自动连接
check('打开即自动连接', (await page.textContent('#conn')).includes('已连接'));
check('显示团队名与会员到期', (await page.textContent('#groupName')).includes('测试团队') && /天后到期/.test(await page.textContent('#vipTip')), await page.textContent('#vipTip'));

// ①-2 打开即自动查询当天
await page.waitForTimeout(1800);
check('打开插件自动查询当天', /4 张照片/.test(await page.textContent('#countText')), await page.textContent('#countText'));
check('自动查询后网格已渲染', (await page.locator('#grid .cell').count()) === 4);
check('全程不打开任何标签页', (await page.evaluate(() => window.__calls.created.length)) === 0, JSON.stringify(await page.evaluate(() => window.__calls.created)));

// ①-3 部门来自接口
await page.click('#memberBtn');
await page.waitForTimeout(400);
check('接口部门出现在树里（技术 2 人）', (await page.textContent('#mTree')).includes('技术'), (await page.textContent('#mTree')).slice(0, 80));
await page.click('#memberDlg [data-close]');
await page.waitForTimeout(200);

// ② 日期弹窗：选「昨天」→ 确定
check('默认日期为今天', (await page.textContent('#dateBtn')).includes('今天'), await page.textContent('#dateBtn'));
await page.click('#dateBtn');
await page.waitForTimeout(200);
check('日期弹窗打开', await page.isVisible('#dateDlg'));
check('快速选择项齐全（15 个）', (await page.locator('#quickCol .q').count()) === 15, String(await page.locator('#quickCol .q').count()));
check('双月日历渲染', (await page.locator('#calendars .cal').count()) === 2);
await page.click('#quickCol [data-q="yesterday"]');
await page.waitForTimeout(200);
await page.click('#dateOk');
await page.waitForTimeout(200);
check('选择「昨天」后按钮更新', (await page.textContent('#dateBtn')).includes('昨天'), await page.textContent('#dateBtn'));

// ③ 成员弹窗：选「技术」部门（2 人）
await page.click('#memberBtn');
await page.waitForTimeout(300);
check('成员弹窗打开', await page.isVisible('#memberDlg'));
check('团队/部门树渲染', (await page.locator('#mTree .node.dept').count()) >= 2, String(await page.locator('#mTree .node.dept').count()));
await page.click('#mTree input[data-dept="api:3537"]');
await page.waitForTimeout(250);
check('选部门后「已选」出现 2 人', (await page.locator('#mPicked .picked-item').count()) === 2);
await page.click('#memberOk');
await page.waitForTimeout(200);
check('人员按钮显示已选人数', (await page.textContent('#memberBtn')).includes('已选 2 人'), await page.textContent('#memberBtn'));

// ④ 查询（按人过滤 → 只剩张伟 2 条）
await page.click('#btnQuery');
await page.waitForTimeout(1500);
check('查询结果符合人员筛选（张伟2+王芳1）', /3 张照片/.test(await page.textContent('#countText')), await page.textContent('#countText'));
check('网格渲染 3 个格子', (await page.locator('#grid .cell').count()) === 3);

// ⑤ 重置 + 全量查询
await page.click('#btnReset');
await page.waitForTimeout(300);
await page.click('#btnQuery');
await page.waitForTimeout(1500);
check('重置后查到全部 4 条', /4 张照片/.test(await page.textContent('#countText')), await page.textContent('#countText'));
check('平台标记项带「平台标记」角标', (await page.locator('#grid .flag').count()) === 1);
check('平台标记项仍可勾选（逐张保存）', (await page.locator('#grid input[data-sel]').count()) === 4, String(await page.locator('#grid input[data-sel]').count()));
const logTxt = await page.textContent('#log');
check('平台标记有诊断日志', /平台标记 1\/4 张/.test(logTxt) && /notvip\/count/.test(logTxt), logTxt.split('\n').slice(-3).join(' | '));

// ⑥ 预览
await page.click('#grid .thumb-wrap[data-open="111"]');
await page.waitForTimeout(500);
check('预览打开', await page.isVisible('#viewer'));
check('预览显示大图', (await page.locator('#vStage img').count()) === 1);
check('预览标题含姓名与时间', (await page.textContent('#vTitle')).includes('张伟'));
await page.click('#vNext');
await page.waitForTimeout(300);
check('可切到下一张（视频）', (await page.locator('#vStage video').count()) === 1);
await page.click('#vClose');
await page.waitForTimeout(200);
check('预览可关闭', !(await page.isVisible('#viewer')));

// ⑥-2 导出清单（CSV，只含元数据）
const dlPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
await page.click('#btnCsv');
const dl = await dlPromise;
check('可导出清单 CSV', !!dl && /照片清单.*\.csv$/.test(dl.suggestedFilename() || ''), dl ? dl.suggestedFilename() : '未触发下载');

// ⑦ 全选 → 下载设置弹窗
await page.check('#chkAll');
await page.waitForTimeout(250);
check('全选包含平台标记项（4 张）', (await page.textContent('#selText')).includes('已选择 4'), await page.textContent('#selText'));

await page.click('#btnDownload');
await page.waitForTimeout(500);
check('点下载先弹出下载设置', await page.isVisible('#downloadDlg'));
check('一级默认=拍摄人姓名', (await page.inputValue('#lv0')) === 'person', await page.inputValue('#lv0'));
check('二级默认=拍摄日期', (await page.inputValue('#lv1')) === 'date', await page.inputValue('#lv1'));
check('三级默认=不分类', (await page.inputValue('#lv2')) === '', await page.inputValue('#lv2'));
const chips = await page.$$eval('#dlChips .chip-tag', (els) => els.map((e) => e.textContent.replace('✕', '').trim()));
check('命名默认 4 个字段', chips.join('/') === '拍摄人姓名/拍摄日期/拍摄时间/水印名称', chips.join('/'));
check('预览显示一级目录', (await page.textContent('#dlPreview')).includes('张伟'), (await page.textContent('#dlPreview')).slice(0, 60));
check('示例文件名正确', /张伟 2026-11-15 18_34_46 打卡水印\.jpg/.test(await page.textContent('#dlExample')), await page.textContent('#dlExample'));
check('底部显示已选张数', (await page.textContent('#dlCount')).includes('4'), await page.textContent('#dlCount'));

// 改一级为「拍摄日期」→ 预览跟着变
await page.selectOption('#lv0', 'date');
await page.waitForTimeout(300);
check('改一级后预览变日期目录', (await page.textContent('#dlPreview')).includes('2026-11-15'), (await page.textContent('#dlPreview')).slice(0, 60));
await page.selectOption('#lv0', 'person');
await page.waitForTimeout(300);

// 确认下载
await page.click('#dlGo');
await page.waitForTimeout(1800);
const w1 = await mediaWrites();
check('下载 4 个文件（含平台标记那张）', w1.length === 4, w1.join(' | '));
check(
  '默认布局：姓名/日期 + 姓名 日期 时间 水印',
  w1.includes('OUT/张伟/2026-11-15/张伟 2026-11-15 18_34_46 打卡水印.jpg'),
  w1.join(' | '),
);
check('不再生成 manifest', !(await page.evaluate(() => window.__written.some((w) => w.path.includes('_manifest')))));
check('下载后清理缓存', (await page.locator('#grid .cell').count()) === 0 && !(await page.isVisible('#resultCard')), await logTail());

// ⑧ 自定义布局 + 自定义命名，再下载一次（同时验证覆盖）
await page.click('#btnQuery');
await page.waitForTimeout(1500);
await page.check('#chkAll');
await page.click('#btnDownload');
await page.waitForTimeout(500);
await page.selectOption('#lv0', 'date');
await page.selectOption('#lv1', '');
await page.click('#dlChips [data-rm="wm"]');
await page.waitForTimeout(300);
await page.click('#dlGo');
await page.waitForTimeout(1800);
const w2 = await mediaWrites();
check(
  '自定义布局生效：日期/姓名 日期 时间.jpg',
  w2.includes('OUT/2026-11-15/张伟 2026-11-15 18_34_46.jpg'),
  w2.slice(3).join(' | '),
);
check('重复下载照样写入（覆盖）', w2.length === 8, String(w2.length));
check('覆盖后无失败', /完成：下载 4 张/.test(await page.textContent('#log')) && !/被平台拒绝/.test(await page.textContent('#log')), await logTail());

// ⑨ 手动分组：建部门 + 归类成员 + 持久化 + 清缓存不影响
await page.click('#groupBtn');
await page.waitForTimeout(400);
check('分组弹窗打开', await page.isVisible('#groupDlg'));
await page.fill('#gName', '索赔组');
await page.click('#gAdd');
await page.waitForTimeout(250);
const gnames = await page.$$eval('#gList input.gname', (els) => els.map((e) => e.value));
check('新增部门出现在列表', gnames.includes('索赔组'), gnames.join(','));
await page.selectOption('#gAssign select[data-assign="u1"]', { label: '索赔组' });
await page.waitForTimeout(150);
await page.click('#gSave');
await page.waitForTimeout(600);
await page.click('#memberBtn');
await page.waitForTimeout(400);
const treeText = await page.textContent('#mTree');
check('成员按自定义部门归类', treeText.includes('索赔组') && /索赔组[\s\S]{0,40}张伟/.test(treeText), treeText.replace(/\s+/g, ' ').slice(0, 120));
await page.click('#memberDlg [data-close]');
await page.waitForTimeout(200);

await page.click('#btnQuery');      // 先有结果，清理按钮才可见
await page.waitForTimeout(1200);
await page.click('#btnClean');
await page.waitForTimeout(400);
await page.click('#memberBtn');
await page.waitForTimeout(400);
check('清理缓存后分组仍在', (await page.textContent('#mTree')).includes('索赔组'));
await page.click('#memberDlg [data-close]');
await page.waitForTimeout(200);

// 重开页面（模拟下一次打开）：把已写入的存储通过 seed 带回，验证从存储恢复
const stored = await page.evaluate(() => window.chrome.storage.local.get('wmc-groups-v1'));
check('分组已写入独立存储（chrome.storage.local）', JSON.stringify(stored).includes('索赔组'));
await page.goto(APP + '?seed=' + encodeURIComponent(JSON.stringify(stored)));
await page.waitForTimeout(2400);
await page.click('#memberBtn');
await page.waitForTimeout(500);
check('重新打开插件后分组仍在', (await page.textContent('#mTree')).includes('索赔组'));
await page.click('#memberDlg [data-close]');

check('无 JS 运行时报错', errors.length === 0, errors.join(' | '));

await ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
