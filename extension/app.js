// 团队照片归档：仿后台的「筛选 → 查询 → 勾选 → 下载」流程。
// 接口请求通过 chrome.scripting.executeScript 注入到 5181688 页面执行，
// 自动带页面登录态，且不依赖 content script（装完/重载插件都不用刷新）。
//
// 设计取舍（按需求定的）：
//  · 不记录"已下载"，不写 manifest；同名文件按系统逻辑直接覆盖
//  · 查询结果、选择状态只存在内存里；下载完成后自动清理
//  · 每次下载都弹目录选择框，不持久化目录授权
const SITE = 'https://www.5181688.com/photo/all';
const TZ = 'Asia/Shanghai';
const PAGE_SIZE = 100;
const DAY = 86400000;

// ============ 注入页面执行的函数 ============
async function ipContext() {
  const groupID = localStorage.getItem('group_id') || '';
  if (!groupID) return { loggedIn: false, groupID: '' };
  const res = await fetch('https://webapi.5181688.com/web/workgroup/v3/query/group', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id: groupID, only_in_group: 0 }),
  });
  const j = await res.json();
  return { loggedIn: true, groupID, group: j.data || null };
}

async function ipMe() {
  const res = await fetch('https://webapi.5181688.com/web/workgroup/v2/currentuser', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const j = await res.json();
  const d = j.data || {};
  return { userID: d.user_id || '', nickname: d.nickname || '' };
}

async function ipDept(args) {
  const res = await fetch('https://webapi.5181688.com/web/department/v2/tree', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groupID: args.groupID,
      userID: args.userID || '',
      enableQuitUser: false,
      departmentIDList: [Number(args.deptID)],
    }),
  });
  const j = await res.json();
  return j.data || null;
}

async function ipList(args) {
  const userIDs = args.userIDs || [];
  const filter = {
    searchKeywords: [],
    mediaType: args.mediaType === undefined ? null : args.mediaType,
    sourceType: null,
    times: [{ start: `${args.from} 00:00:00`, end: `${args.to} 23:59:59` }],
    userIDList: userIDs,
    excludeUserIDList: [],
    // ['0'] = 全部部门，会盖掉人员筛选；按人筛时必须传空数组
    departmentIDList: userIDs.length ? [] : ['0'],
    watermarks: args.watermarks || [],
    locations: [],
    useSegment: true,
    useSynonym: false,
    useSuggestedSearch: true,
    suggestedSearchWords: [],
    locationRecommend: {},
    excludeKeywords: [],
    existWatermark: 0,
    labelIDs: [],
    labelMatchAll: false,
    untaggedOnly: false,
  };
  const res = await fetch('https://webapi.5181688.com/v5/workgroup/photos', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter,
      isPreciseSearch: false,
      isAscSort: false,
      groupID: args.groupID,
      lastPageCond: args.cursor || '',
    }),
  });
  const j = await res.json();
  if (j.status !== 0) throw new Error(`接口返回 status=${j.status} ${j.msg || ''}`);
  return j.payload;
}

async function ipWatermarks(args) {
  const res = await fetch(
    'https://webapi.5181688.com/v4/workgroup/watermarks?group_id=' + encodeURIComponent(args.groupID),
    { credentials: 'include' },
  );
  const j = await res.json();
  return (j.data && j.data.payload) || [];
}

// ============ 工具 ============
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const fmtDate = (ms) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ms),
  );
const fmtTime = (ms) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(ms));
const fmtShort = (iso) => `${+iso.slice(5, 7)}.${+iso.slice(8, 10)}`;
const safeName = (s) =>
  String(s || '未命名').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名';
const extOf = (it) => {
  const u = it.url || '';
  const m = u.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/);
  return m ? m[1].toLowerCase() : 'jpg';
};
const toDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);

// ============ 状态 ============
const S = {
  tabId: null, loggedIn: false, groupID: '', group: null, me: null, accountKey: '',
  depts: [], persons: [], memberDept: new Map(),
  from: '', to: '', rangeLabel: '',
  userSel: new Set(), wmSel: new Set(), wmDefs: [],
  manual: { depts: [], assign: {} }, baseAssign: new Map(), gTemp: null,
  items: [], selected: new Set(), page: 0, busy: false,
  // 弹窗临时状态
  dMode: 'range', dBase: startOfMonth(new Date()), dFrom: null, dTo: null, dQuick: '',
  mTemp: new Set(), mExpanded: new Set(),
  wmTemp: new Set(),
  viewList: [], viewIndex: -1,
  dl: { levels: ['person', 'date', ''], tokens: ['person', 'date', 'time', 'wm'] },
  pending: [],
};

// ============ 日志 ============
function log(msg, cls = '') {
  const el = $('log');
  if (!el) return;
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  el.appendChild(line);
  while (el.childElementCount > 300) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
const setBar = (pct) => ($('barFill').style.width = `${Math.max(0, Math.min(100, pct))}%`);

// ============ 与页面交互 ============
async function findTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.5181688.com/*' });
  if (!tabs.length) return null;
  return tabs.find((t) => (t.url || '').includes('/photo')) || tabs[0];
}
async function waitLoaded(tabId, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return true;
    } catch { return false; }
    await sleep(300);
  }
  return false;
}
async function runInPage(fn, args, { background = false } = {}) {
  let tab = await findTab();
  if (!tab) {
    tab = await chrome.tabs.create({ url: SITE, active: !background });
    await waitLoaded(tab.id);
    await sleep(background ? 2500 : 1500);
  }
  S.tabId = tab.id;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fn, args: [args || {}] });
    if (!res) throw new Error('页面没有返回结果');
    return res.result;
  } catch (e) {
    throw new Error(`无法在该页面执行（${e.message}），请确认 5181688 已打开并登录`);
  }
}

// ============ 数据通道 ============
// 首选：扩展页直接请求 webapi（登录 cookie 是 SameSite=None，且 host_permissions 让扩展页
// 不受 CORS 限制）—— 这样完全不需要开任何标签页。
// 回退：万一直连被浏览器策略拦（第三方 cookie / CORS），再把请求注入到一个站点标签页里发。
const API_ROOT = 'https://webapi.5181688.com';

async function directPost(path, body) {
  const res = await fetch(API_ROOT + path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function directGet(path) {
  const res = await fetch(API_ROOT + path, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function directApi(kind, args = {}) {
  if (kind === 'context') {
    const me = (await directPost('/web/workgroup/v2/currentuser')).data || {};
    const groups = me.groups || [];
    if (!groups.length) return { loggedIn: false };
    const g = groups[0];
    const grp = (await directPost('/web/workgroup/v3/query/group', { group_id: g.group_id, only_in_group: 0 })).data || {};
    return { loggedIn: true, groupID: g.group_id, group: grp, me };
  }
  if (kind === 'dept') {
    const j = await directPost('/web/department/v2/tree', {
      groupID: args.groupID,
      userID: args.userID || '',
      enableQuitUser: false,
      departmentIDList: [Number(args.deptID)],
    });
    return j.data || null;
  }
  if (kind === 'watermarks') {
    const j = await directGet(`/v4/workgroup/watermarks?group_id=${encodeURIComponent(args.groupID)}`);
    return (j.data && j.data.payload) || [];
  }
  if (kind === 'list') return directList(args);
  if (kind === 'notvip') return directNotvip(args);
  throw new Error('未知请求：' + kind);
}

async function directNotvip(args) {
  // 平台自己的「非会员受限」口径：返回 isVip 与受限张数
  const j = await directPost('/v5/workgroup/photos/notvip/count', {
    filter: buildFilter(args),
    isPreciseSearch: false,
    isAscSort: false,
    groupID: args.groupID,
    lastPageCond: '',
  });
  return j || {};
}

function buildFilter(args) {
  const userIDs = args.userIDs || [];
  return {
    searchKeywords: [],
    mediaType: args.mediaType === undefined ? null : args.mediaType,
    sourceType: null,
    times: [{ start: `${args.from} 00:00:00`, end: `${args.to} 23:59:59` }],
    userIDList: userIDs,
    excludeUserIDList: [],
    departmentIDList: userIDs.length ? [] : ['0'],
    watermarks: args.watermarks || [],
    locations: [],
    useSegment: true,
    useSynonym: false,
    useSuggestedSearch: true,
    suggestedSearchWords: [],
    locationRecommend: {},
    excludeKeywords: [],
    existWatermark: 0,
    labelIDs: [],
    labelMatchAll: false,
    untaggedOnly: false,
  };
}

async function directList(args) {
  const filter = buildFilter(args);
  const j = await directPost('/v5/workgroup/photos', {
    filter,
    isPreciseSearch: false,
    isAscSort: false,
    groupID: args.groupID,
    lastPageCond: args.cursor || '',
  });
  if (j.status !== 0) throw new Error(`接口返回 status=${j.status} ${j.msg || ''}`);
  return j.payload;
}

const PAGE_FN = { context: ipContext, dept: ipDept, watermarks: ipWatermarks, list: ipList, notvip: ipList };

/** 统一入口：先直连，失败则回退到页面通道（会开后台标签页）。 */
async function api(kind, args = {}) {
  if (S.channel !== 'page') {
    try {
      const r = await directApi(kind, args);
      S.channel = 'direct';
      return r;
    } catch (e) {
      const msg = String(e && e.message || e);
      // 接口本身报错（业务错误）不算通道问题，直接抛
      if (/^接口返回 status=/.test(msg)) throw e;
      if (S.channel !== 'page') {
        S.channel = 'page';
        log('扩展页直连接口不可用，改用页面通道（需保留一个后台标签页）', 'err');
      }
    }
  }
  return runInPage(PAGE_FN[kind], args, { background: true });
}

// ============ 插件内登录 ============
// 为什么用 iframe 而不是纯 fetch：登录态是站点域上的 cookie，登录流程（滑块验证码、
// 微信公众号扫码）都必须在站点自己的页面里渲染。扩展页是另一个源，只能把站点页面嵌进来，
// 视觉上不离开插件，但握手仍在站点域完成 —— 不伪造、不代填、不绕过验证码。
let loginTimer = null;
let loginTicks = 0;

function stopLoginPoll() {
  if (loginTimer) {
    clearInterval(loginTimer);
    loginTimer = null;
  }
  loginTicks = 0;
}

async function openLoginDlg() {
  $('loginDlg').hidden = false;
  $('loginFrame').src = `${SITE}?relogin=${Date.now()}`;
  log('请在弹窗里用手机号或微信扫码登录（和官网登录完全一样）');
  stopLoginPoll();
  loginTimer = setInterval(async () => {
    if ($('loginDlg').hidden) return stopLoginPoll();
    loginTicks += 1;
    try {
      // 登录在 iframe 里完成 → cookie 落到站点域 → 这里直接查登录态
      const ctx = await api('context', {});
      if (ctx?.loggedIn) {
        stopLoginPoll();
        $('loginDlg').hidden = true;
        $('loginFrame').src = 'about:blank';
        log('登录成功，正在连接…', 'ok');
        await afterLogin();
        return;
      }
    } catch {
      /* 轮询期间页面可能正在跳转，忽略 */
    }
  }, 2500);
}

async function afterLogin() {
  if (!(await connect({ silent: true }))) {
    log('已登录但连接失败，请稍后重试', 'err');
    return false;
  }
  try {
    await loadAccountSettings();
    await loadOrg();
    refreshFilterLabels();
  } catch (e) {
    log('读取组织架构失败：' + e.message, 'err');
  }
  await query();
  return true;
}

async function loginInPopup() {
  try {
    await chrome.windows.create({ url: SITE, type: 'popup', width: 520, height: 800 });
    log('已用独立窗口打开登录页；登录完成后会让插件自动连接');
    if (!loginTimer) openLoginDlg().catch(() => {});
  } catch (e) {
    log('打开登录窗口失败：' + e.message, 'err');
  }
}

// ============ 账号级配置（按账号分别保存，清理照片缓存不影响） ============
const SETTINGS_KEY = 'wmc-settings-v2';

async function loadAccountSettings() {
  let all = {};
  try {
    all = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  } catch {
    all = {};
  }
  const s = all[S.accountKey] || {};
  S.dl = {
    levels: Array.isArray(s.levels) && s.levels.length === 3 ? s.levels : ['person', 'date', ''],
    tokens: Array.isArray(s.tokens) && s.tokens.length ? s.tokens : ['person', 'date', 'time', 'wm'],
  };
  S.wmSel = new Set(s.wmSel || []);
  S.userSel = new Set(s.userSel || []);
  refreshFilterLabels();
}

async function saveAccountSettings() {
  try {
    const all = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
    all[S.accountKey] = {
      levels: S.dl.levels,
      tokens: S.dl.tokens,
      wmSel: [...S.wmSel],
      userSel: [...S.userSel],
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: all });
  } catch (e) {
    log(`保存配置失败：${e.message}`, 'err');
  }
}

function refreshFilterLabels() {
  $('memberBtn').textContent = `筛选人员 · ${S.userSel.size ? `已选 ${S.userSel.size} 人` : '全部成员'} ▾`;
  $('wmBtn').textContent = `筛选水印 · ${S.wmSel.size ? `已选 ${S.wmSel.size} 个` : '全部'} ▾`;
}

// ============ 退出 / 切换账号 ============
// 登录态是 5181688 域上的 cookie；清掉它们等价于在浏览器里"退出登录"。
// 不依赖平台的 logout 接口（各版本不一定有），清 cookie 最可靠。
async function signOut({ thenLogin = true } = {}) {
  let removed = 0;
  try {
    const cookies = await chrome.cookies.getAll({ domain: '5181688.com' });
    for (const c of cookies) {
      const host = String(c.domain || '').replace(/^\./, '');
      const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
      try {
        await chrome.cookies.remove({ url, name: c.name });
        removed++;
      } catch {
        /* 单个失败不影响整体 */
      }
    }
  } catch (e) {
    log(`清理登录态失败：${e.message}`, 'err');
  }

  // 内存状态复位
  S.loggedIn = false;
  S.groupID = '';
  S.group = null;
  S.me = null;
  S.depts = [];
  S.persons = [];
  S.memberDept = new Map();
  S.baseAssign = new Map();
  S.manual = { depts: [], assign: {} }; // 内存清空；存储按账号保留，重新登录后恢复
  S.userSel = new Set();
  S.wmSel = new Set();
  S.dl = { levels: ['person', 'date', ''], tokens: ['person', 'date', 'time', 'wm'] };
  clearCache({ silent: true });

  $('conn').className = 'pill pill-warn';
  $('conn').textContent = '未登录';
  $('groupName').textContent = '';
  $('accountName').textContent = '';
  $('vipTip').textContent = '';
  $('vipBanner').hidden = true;
  $('accountBtn').textContent = '登录';

  log(`已退出登录（清理 ${removed} 个 cookie）`, 'ok');
  if (thenLogin) await openLoginDlg();
}

// ============ 连接 + 组织架构 ============
async function connect({ silent = false } = {}) {
  try {
    const ctx = await api('context', {});
    S.loggedIn = !!ctx?.loggedIn;
    S.groupID = ctx?.groupID || '';
    S.group = ctx?.group || null;
    S.me = ctx?.me || null;
    S.accountKey = S.me?.user_id || S.groupID || '';
    if (S.loggedIn) {
      $('conn').className = 'pill pill-ok';
      $('conn').textContent = '已连接';
      $('groupName').textContent = S.group?.group_name || '';
      $('accountName').textContent = S.me?.nickname ? `账号：${S.me.nickname}` : '';
      $('accountBtn').textContent = '切换账号';
      const exp = S.group?.vip_info?.expire_time;
      $('vipTip').textContent = exp ? `会员 ${Math.max(0, Math.ceil((exp * 1000 - Date.now()) / DAY))} 天后到期` : '';
      renderVipBanner();
      if (!silent) log(`已连接「${S.group?.group_name || ''}」`, 'ok');
      return true;
    }
    $('conn').className = 'pill pill-warn';
    $('conn').textContent = '未登录';
    if (!silent) log('站点页面未登录，请先登录后刷新本页', 'err');
    return false;
  } catch (e) {
    $('conn').className = 'pill pill-err';
    $('conn').textContent = '未连接';
    if (!silent) log(e.message, 'err');
    return false;
  }
}

function renderVipBanner() {
  const el = $('vipBanner');
  const vip = S.group?.vip_info;
  const exp = vip?.expire_time ? vip.expire_time * 1000 : 0;
  const isVip = S.group?.is_vip !== false && (!exp || exp > Date.now());
  S.isVip = isVip;
  if (!isVip) {
    el.className = 'banner banner--err';
    el.innerHTML =
      '<b>当前账号不是有效会员</b>：平台会禁用后台的「批量下载」按钮，但照片仍可浏览、单张也能保存。' +
      '本工具做的是<b>逐张保存的自动化</b>（等效于你把每张右键另存），没有调用会员专享的批量下载能力，' +
      '也没有伪造会员状态。个别照片若被平台拒绝，日志会写出来。';
    el.hidden = false;
    return;
  }
  if (exp && exp - Date.now() < 7 * 86400000) {
    el.className = 'banner banner--warn';
    el.innerHTML = `<b>会员 ${Math.max(1, Math.ceil((exp - Date.now()) / 86400000))} 天后到期</b>：到期后平台会限制照片查看与批量下载，建议先把要留的日期导完。`;
    el.hidden = false;
    return;
  }
  el.hidden = true;
}

async function loadOrg() {
  const rootName = S.group?.group_name || '团队';

  // 部门树接口要求传「当前登录用户」的 id，传别人会 verify error
  let meId = S.me?.user_id || '';
  if (!meId) {
    try {
      const me = await runInPage(ipMe, {});
      meId = me?.userID || '';
    } catch {
      /* 忽略 */
    }
  }

  const apiDepts = [];
  const apiAssign = new Map(); // userID -> deptId
  try {
    const rootData = await api('dept', { groupID: S.groupID, deptID: '0', userID: meId });
    if (!(rootData?.department || []).length) {
      log('部门接口没返回部门（可能没有权限）。可以点「分组管理」自己建部门。', 'err');
    }
    const queue = [{ id: '0', depth: 0 }];
    const seen = new Set(['0']);
    let guard = 0;
    while (queue.length && guard++ < 80) {
      const { id, depth } = queue.shift();
      const data = id === '0' ? rootData : await api('dept', { groupID: S.groupID, deptID: id, userID: meId });
      for (const d of data?.department || []) {
        const did = String(d.id);
        if (seen.has(did)) continue;
        seen.add(did);
        apiDepts.push({ id: `api:${did}`, name: d.name, depth, count: d.num || 0 });
        queue.push({ id: did, depth: depth + 1 });
      }
      for (const m of data?.member || []) {
        if (id !== '0' && m.user_id && !apiAssign.has(m.user_id)) apiAssign.set(m.user_id, `api:${id}`);
      }
    }
  } catch (e) {
    log(`部门读取失败：${e.message}（可用「分组管理」手动建）`, 'err');
  }

  // 手动分组（独立缓存，清理查询缓存不会动它）
  await loadGroups();
  const mine = S.manual;

  S.depts = [
    ...apiDepts,
    ...(mine.depts || []).map((d) => ({ id: d.id, name: d.name, depth: 0, count: 0, manual: true })),
  ];

  const assign = new Map(apiAssign);
  for (const [uid, did] of Object.entries(mine.assign || {})) {
    if (did) assign.set(uid, did);
    else assign.delete(uid);
  }
  S.memberDept = assign;
  S.baseAssign = new Map(apiAssign);

  S.persons = (S.group?.user_list || []).map((u) => ({
    userID: u.user_id,
    nickname: u.nickname,
    deptId: assign.get(u.user_id) || '',
    active: u.user_status === 1,
  }));
  // 人数以实际成员为准
  for (const d of S.depts) d.count = S.persons.filter((p) => p.deptId === d.id).length;

  S.wmDefs = (await api('watermarks', { groupID: S.groupID })) || [];
}

// ============ 手动分组（独立缓存，清理查询缓存不影响） ============
const LS_KEY = 'wmc-groups-v1';

async function loadGroups() {
  let all = {};
  try {
    const raw = await chrome.storage.local.get(LS_KEY);
    all = raw?.[LS_KEY] || {};
  } catch {
    all = {};
  }
  const mine = all[S.accountKey] || all[S.groupID] || { depts: [], assign: {} }; // 兼容旧版本的 groupID 键
  mine.depts = mine.depts || [];
  mine.assign = mine.assign || {};
  S.manual = mine;
}

async function saveGroups() {
  let all = {};
  try {
    const raw = await chrome.storage.local.get(LS_KEY);
    all = raw?.[LS_KEY] || {};
  } catch {
    all = {};
  }
  all[S.accountKey] = S.manual;
  await chrome.storage.local.set({ [LS_KEY]: all });
}

function openGroupDlg() {
  S.gTemp = JSON.parse(JSON.stringify(S.manual));
  $('gName').value = '';
  $('gSearch').value = '';
  renderGroupDlg();
  $('groupDlg').hidden = false;
}

function gid() {
  return 'm:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function renderGroupDlg() {
  const depts = S.gTemp.depts || [];
  $('gList').innerHTML = depts.length
    ? depts
        .map((d) => {
          const n = S.persons.filter((p) => (S.gTemp.assign[p.userID] ?? S.baseAssign.get(p.userID) ?? '') === d.id).length;
          return `<div class="gitem">
            <input class="gname" value="${d.name.replace(/"/g, '&quot;')}" data-rename="${d.id}" />
            <span class="cnt">${n}人</span>
            <button class="link" data-del="${d.id}">删除</button>
          </div>`;
        })
        .join('')
    : '<div class="muted" style="padding:6px">还没有自定义部门，在上面输入名称点「添加」</div>';

  const q = ($('gSearch').value || '').trim().toLowerCase();
  const rows = S.persons.filter((p) => !q || p.nickname.toLowerCase().includes(q));
  // 选项要包含「刚添加但还没保存」的部门
  const optsDepts = [...S.depts.filter((d) => !d.manual), ...(S.gTemp.depts || [])];
  const opts = ['<option value="">未分组</option>']
    .concat(optsDepts.map((d) => `<option value="${d.id}">${d.name}</option>`))
    .join('');
  $('gAssign').innerHTML = rows
    .map((p) => {
      const cur = S.gTemp.assign[p.userID] ?? S.baseAssign.get(p.userID) ?? '';
      const sel = opts.replace(`value="${cur}"`, `value="${cur}" selected`);
      return `<div class="grow-item"><span>${p.nickname}</span><select data-assign="${p.userID}">${sel}</select></div>`;
    })
    .join('');
  $('gCount').textContent = `${rows.length} 人`;

  $('gList').querySelectorAll('[data-rename]').forEach((el) => {
    el.oninput = () => {
      const d = S.gTemp.depts.find((x) => x.id === el.dataset.rename);
      if (d) d.name = el.value.trim() || d.name;
    };
  });
  $('gList').querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.del;
      S.gTemp.depts = S.gTemp.depts.filter((d) => d.id !== id);
      for (const [uid, did] of Object.entries(S.gTemp.assign)) if (did === id) delete S.gTemp.assign[uid];
      renderGroupDlg();
    };
  });
  $('gAssign').querySelectorAll('select[data-assign]').forEach((el) => {
    el.onchange = () => {
      S.gTemp.assign[el.dataset.assign] = el.value;
    };
  });
}

async function refreshDepts() {
  const apiDepts = S.depts.filter((d) => !d.manual);
  S.depts = [
    ...apiDepts,
    ...(S.manual.depts || []).map((d) => ({ id: d.id, name: d.name, depth: 0, count: 0, manual: true })),
  ];
  const assign = new Map(S.baseAssign);
  for (const [uid, did] of Object.entries(S.manual.assign || {})) {
    if (did) assign.set(uid, did);
    else assign.delete(uid);
  }
  S.memberDept = assign;
  for (const p of S.persons) p.deptId = assign.get(p.userID) || '';
  for (const d of S.depts) d.count = S.persons.filter((p) => p.deptId === d.id).length;
  if (S.mExpanded) S.mExpanded = new Set([...S.mExpanded, ...S.depts.map((d) => d.id)]);
}

// ============ 日期弹窗 ============
const QUICK = [
  ['today', '今天'], ['yesterday', '昨天'], ['week', '本周'], ['lastWeek', '上周'],
  ['month', '本月'], ['lastMonth', '上月'], ['year', '今年'], ['lastYear', '去年'],
  ['7d', '过去7天'], ['30d', '过去30天'], ['2m', '过去2个月'], ['3m', '过去3个月'],
  ['6m', '过去6个月'], ['1y', '过去一年'], ['all', '所有时间'],
];

function quickRange(kind, from = S.from, to = S.to) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const iso = ymd;
  const back = (n) => new Date(today.getTime() - n * DAY);
  switch (kind) {
    case 'today': return [iso(today), iso(today)];
    case 'yesterday': { const d = back(1); return [iso(d), iso(d)]; }
    case 'week': { const d = new Date(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return [iso(d), iso(today)]; }
    case 'lastWeek': {
      const s = new Date(today); s.setDate(s.getDate() - ((s.getDay() + 6) % 7) - 7);
      const e = new Date(s.getTime() + 6 * DAY); return [iso(s), iso(e)];
    }
    case 'month': return [iso(startOfMonth(today)), iso(today)];
    case 'lastMonth': {
      const s = addMonths(startOfMonth(today), -1);
      const e = new Date(startOfMonth(today).getTime() - DAY); return [iso(s), iso(e)];
    }
    case 'year': return [iso(new Date(today.getFullYear(), 0, 1)), iso(today)];
    case 'lastYear': return [iso(new Date(today.getFullYear() - 1, 0, 1)), iso(new Date(today.getFullYear() - 1, 11, 31))];
    case '7d': return [iso(back(6)), iso(today)];
    case '30d': return [iso(back(29)), iso(today)];
    case '2m': { const d = addMonths(today, -2); return [iso(d), iso(today)]; }
    case '3m': { const d = addMonths(today, -3); return [iso(d), iso(today)]; }
    case '6m': { const d = addMonths(today, -6); return [iso(d), iso(today)]; }
    case '1y': { const d = addMonths(today, -12); return [iso(d), iso(today)]; }
    case 'all': return ['2000-01-01', iso(today)];
    default: return [from || iso(today), to || iso(today)];
  }
}

function setRange(from, to, label) {
  S.from = from;
  S.to = to;
  S.rangeLabel = label || (from === to ? `${fmtShort(from)}` : `${fmtShort(from)}-${fmtShort(to)}`);
  $('dateBtn').textContent = `${S.rangeLabel} ▾`;
  $('rangeTip').textContent = `${from} ~ ${to}`;
}

function openDateDlg() {
  S.dFrom = S.from ? toDate(S.from) : null;
  S.dTo = S.to ? toDate(S.to) : null;
  S.dBase = addMonths(startOfMonth(S.dTo || S.dFrom || new Date()), -1);
  S.dQuick = '';
  renderQuick();
  renderCalendars();
  $('dateDlg').hidden = false;
}

function renderQuick() {
  $('quickCol').innerHTML =
    '<div class="q-title">快速选择</div>' +
    QUICK.map(([k, label]) => `<button class="q ${S.dQuick === k ? 'active' : ''}" data-q="${k}">${label}</button>`).join('');
  $('quickCol').querySelectorAll('.q').forEach((b) => {
    b.onclick = () => {
      const [f, t] = quickRange(b.dataset.q);
      S.dQuick = b.dataset.q;
      S.dFrom = toDate(f);
      S.dTo = toDate(t);
      S.dBase = addMonths(startOfMonth(S.dTo || S.dFrom), -1);
      renderQuick();
      renderCalendars();
    };
  });
}

function renderCalendars() {
  const wrap = $('calendars');
  // S.dBase 是左日历的月份；右日历是选中月（后台的排法）
  const months = S.dMode === 'range' ? [S.dBase, addMonths(S.dBase, 1)] : [addMonths(S.dBase, 1)];
  const wk = ['一', '二', '三', '四', '五', '六', '日'];
  const todayIso = ymd(new Date());
  const thisYear = new Date().getFullYear();
  const years = [];
  for (let y = 2016; y <= thisYear; y++) years.push(y);

  const f = S.dFrom ? ymd(S.dFrom) : '';
  const t = S.dTo ? ymd(S.dTo) : '';

  const cals = months
    .map((m, idx) => {
      const first = startOfMonth(m);
      const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      const lead = (first.getDay() + 6) % 7;
      const cells = [];
      for (let i = 0; i < lead; i++) {
        const d = new Date(first.getTime() - (lead - i) * DAY);
        cells.push(`<span class="d other">${d.getDate()}</span>`);
      }
      for (let day = 1; day <= daysInMonth; day++) {
        const cur = new Date(m.getFullYear(), m.getMonth(), day);
        const iso = ymd(cur);
        const cls = ['d'];
        if (iso === todayIso) cls.push('today');
        if ((f && iso === f) || (t && iso === t)) cls.push('edge');
        else if (f && t && iso > f && iso < t) cls.push('in-range');
        cells.push(`<span class="${cls.join(' ')}" data-day="${iso}">${day}</span>`);
      }
      return `<div class="cal">
        <div class="m-title">
          <select data-y="${idx}">${years.map((y) => `<option value="${y}" ${y === m.getFullYear() ? 'selected' : ''}>${y}年</option>`).join('')}</select>
          <select data-m="${idx}">${Array.from({ length: 12 }, (_, i) => `<option value="${i}" ${i === m.getMonth() ? 'selected' : ''}>${i + 1}月</option>`).join('')}</select>
        </div>
        <div class="wk">${wk.map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="days">${cells.join('')}</div>
      </div>`;
    })
    .join('');

  wrap.innerHTML =
    `<div class="calnav"><button data-nav="-1">‹</button></div>` + cals + `<div class="calnav"><button data-nav="1">›</button></div>`;

  wrap.querySelectorAll('.d[data-day]').forEach((el) => {
    el.onclick = () => {
      const iso = el.dataset.day;
      const d = toDate(iso);
      if (S.dMode === 'single') {
        S.dFrom = d;
        S.dTo = d;
      } else if (!S.dFrom || (S.dFrom && S.dTo)) {
        S.dFrom = d;
        S.dTo = null;
      } else if (iso < ymd(S.dFrom)) {
        S.dTo = S.dFrom;
        S.dFrom = d;
      } else {
        S.dTo = d;
      }
      S.dQuick = '';
      renderQuick();
      renderCalendars();
    };
  });

  wrap.querySelectorAll('[data-nav]').forEach((b) => {
    b.onclick = () => {
      S.dBase = addMonths(S.dBase, Number(b.dataset.nav));
      renderCalendars();
    };
  });
  wrap.querySelectorAll('select[data-y]').forEach((sel) => {
    sel.onchange = () => {
      const idx = Number(sel.dataset.y);
      const cur = addMonths(S.dBase, idx);
      const next = new Date(Number(sel.value), cur.getMonth(), 1);
      S.dBase = addMonths(next, -idx);
      renderCalendars();
    };
  });
  wrap.querySelectorAll('select[data-m]').forEach((sel) => {
    sel.onchange = () => {
      const idx = Number(sel.dataset.m);
      const cur = addMonths(S.dBase, idx);
      const next = new Date(cur.getFullYear(), Number(sel.value), 1);
      S.dBase = addMonths(next, -idx);
      renderCalendars();
    };
  });

  let label = '未选择';
  if (f && t) {
    const days = Math.round((toDate(t) - toDate(f)) / DAY) + 1;
    label = `${f} 至 ${t} 共${days}天`;
  } else if (f) {
    label = `${f} 至 —`;
  }
  $('dateLabel').textContent = label;
}

// ============ 成员弹窗 ============
function openMemberDlg() {
  S.mTemp = new Set(S.userSel);
  S.mExpanded = new Set(['__root', ...S.depts.map((d) => d.id)]);
  $('mSearch').value = '';
  renderMemberTree();
  renderPicked();
  $('memberDlg').hidden = false;
}

function renderMemberTree() {
  const q = ($('mSearch').value || '').trim().toLowerCase();
  const onlyActive = $('onlyActive').checked;
  const pool = S.persons.filter((p) => (!onlyActive || p.active) && (!q || p.nickname.toLowerCase().includes(q)));
  const rootName = S.group?.group_name || '团队';
  const allSelected = pool.length > 0 && pool.every((p) => S.mTemp.has(p.userID));

  let html = `<div class="node dept"><span class="caret" data-toggle="__root">${S.mExpanded.has('__root') ? '▾' : '▸'}</span>
    <input type="checkbox" data-team="1" ${allSelected ? 'checked' : ''} />
    <span>${rootName}</span><span class="cnt">(${pool.length}人)</span></div>`;

  if (S.mExpanded.has('__root')) {
    for (const d of S.depts) {
      const members = S.persons.filter(
        (p) => p.deptId === d.id && (!onlyActive || p.active) && (!q || p.nickname.toLowerCase().includes(q)),
      );
      if (!members.length && q) continue;
      const picked = members.filter((p) => S.mTemp.has(p.userID)).length;
      const open = S.mExpanded.has(d.id);
      html += `<div class="node dept" style="padding-left:${14 + (d.depth || 0) * 14}px">
        <span class="caret" data-toggle="${d.id}">${open ? '▾' : '▸'}</span>
        <input type="checkbox" data-dept="${d.id}" ${members.length && picked === members.length ? 'checked' : ''} />
        <span>${d.name}</span><span class="cnt">(${members.length}人)</span></div>`;
      if (open) {
        for (const p of members) {
          html += `<div class="node member" style="padding-left:${44 + (d.depth || 0) * 14}px">
            <input type="checkbox" data-user="${p.userID}" ${S.mTemp.has(p.userID) ? 'checked' : ''} />
            <span>${p.nickname}</span></div>`;
        }
      }
    }
    const loose = pool.filter((p) => !p.deptId || !S.depts.some((d) => d.id === p.deptId));
    for (const p of loose) {
      html += `<div class="node member"><input type="checkbox" data-user="${p.userID}" ${S.mTemp.has(p.userID) ? 'checked' : ''} /><span>${p.nickname}</span></div>`;
    }
  }
  $('mTree').innerHTML = html;

  $('mTree').querySelectorAll('[data-toggle]').forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.toggle;
      if (S.mExpanded.has(k)) S.mExpanded.delete(k);
      else S.mExpanded.add(k);
      renderMemberTree();
    };
  });
  $('mTree').querySelectorAll('input[data-team]').forEach((el) => {
    el.onchange = () => {
      if (el.checked) pool.forEach((p) => S.mTemp.add(p.userID));
      else pool.forEach((p) => S.mTemp.delete(p.userID));
      renderMemberTree();
      renderPicked();
    };
  });
  $('mTree').querySelectorAll('input[data-dept]').forEach((el) => {
    el.onchange = () => {
      const did = el.dataset.dept;
      const members = S.persons.filter((p) => p.deptId === did);
      if (el.checked) members.forEach((p) => S.mTemp.add(p.userID));
      else members.forEach((p) => S.mTemp.delete(p.userID));
      renderMemberTree();
      renderPicked();
    };
  });
  $('mTree').querySelectorAll('input[data-user]').forEach((el) => {
    el.onchange = () => {
      if (el.checked) S.mTemp.add(el.dataset.user);
      else S.mTemp.delete(el.dataset.user);
      renderMemberTree();
      renderPicked();
    };
  });
}

function renderPicked() {
  const list = S.persons.filter((p) => S.mTemp.has(p.userID));
  $('mPicked').innerHTML = list.length
    ? list.map((p) => `<div class="picked-item"><span>${p.nickname}</span><button data-unpick="${p.userID}">✕</button></div>`).join('')
    : '<div class="muted" style="padding:8px">还没有选择成员</div>';
  $('mPicked').querySelectorAll('[data-unpick]').forEach((b) => {
    b.onclick = () => {
      S.mTemp.delete(b.dataset.unpick);
      renderMemberTree();
      renderPicked();
    };
  });
}

// ============ 水印弹窗 ============
function openWmDlg() {
  S.wmTemp = new Set(S.wmSel);
  const seen = new Set();
  const rows = [];
  for (const w of S.wmDefs) {
    const key = `${w.watermark_base_id}|${w.group_watermark_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, name: w.name, filter: { watermarkBaseID: w.watermark_base_id, groupWatermarkID: w.group_watermark_id || undefined } });
  }
  $('wmList').innerHTML = rows
    .map((r) => `<label><input type="checkbox" data-wm="${r.key}" ${S.wmTemp.has(r.key) ? 'checked' : ''} /> ${r.name}</label>`)
    .join('');
  $('wmList').querySelectorAll('input[data-wm]').forEach((el) => {
    el.onchange = () => {
      if (el.checked) S.wmTemp.add(el.dataset.wm);
      else S.wmTemp.delete(el.dataset.wm);
    };
  });
  S.wmRows = rows;
  $('wmDlg').hidden = false;
}

function wmFilters() {
  const rows = S.wmRows || [];
  return [...S.wmSel].map((k) => rows.find((r) => r.key === k)?.filter).filter(Boolean);
}

// ============ 查询 ============
async function query() {
  if (S.busy) return;
  if (!S.loggedIn && !(await connect({ silent: true }))) return log('未连接，请先登录 5181688', 'err');
  if (!S.from || !S.to) {
    const [f, t] = quickRange('today');
    setRange(f, t, '今天');
  }
  S.busy = true;
  $('btnQuery').disabled = true;
  S.items = [];
  S.selected = new Set();
  S.page = 0;
  setBar(0);
  log(`查询 ${S.from} ~ ${S.to} …`);

  const args = {
    groupID: S.groupID,
    from: S.from,
    to: S.to,
    userIDs: [...S.userSel],
    watermarks: wmFilters(),
  };

  try {
    let cursor = '';
    const seen = new Set();
    let total = 0;
    while (true) {
      const p = await api('list', { ...args, cursor });
      total = p?.total || 0;
      for (const ph of p?.photos || []) {
        const thumbUrl = ph.smallURL || '';
        const isVideo = ph.mediaType === 1;
        const videoUrl = ph.videoURL || '';
        let imageUrl = ph.largeURL || '';
        let derived = false;
        if (!imageUrl && thumbUrl) {
          // 平台缩略图 = 原图 + ?x-oss-process=image/resize...，去掉参数即原图（图片；视频则是首帧）
          imageUrl = thumbUrl.split('?')[0];
          derived = !!imageUrl;
        }
        // 视频优先用视频地址；图片用原图地址
        const mediaUrl = isVideo ? videoUrl : imageUrl;
        S.items.push({
          seq: String(ph.seq),
          person: ph.userNickname || '未知',
          userID: ph.userID,
          time: ph.time,
          mediaType: ph.mediaType,
          url: mediaUrl,
          imageUrl,
          videoUrl,
          urlDerived: derived,
          thumb: thumbUrl,
          addr: ph.addr || '',
          restricted: !!((ph.temporaryPhotoThaw && ph.temporaryPhotoThaw.isRestricted) || ph.isLimitViewByPhotoCount),
          flagThaw: !!(ph.temporaryPhotoThaw && ph.temporaryPhotoThaw.isRestricted),
          flagLimit: !!ph.isLimitViewByPhotoCount,
          hasUrl: !!mediaUrl,
          hasVideo: !!videoUrl,
          wm: '',
        });
      }
      $('countText').textContent = `已读取 ${S.items.length}/${total} 张照片`;
      setBar(total ? (S.items.length * 100) / total : 0);
      const next = p?.lastPageCond || '';
      if (!(p?.photos || []).length || !next || next === cursor || seen.has(next)) break;
      seen.add(next);
      cursor = next;
      await sleep(250);
    }
    await resolveWatermarks(args);

    // 受限照片诊断：把"为什么下不了"直接写进日志
    const restricted = S.items.filter((i) => i.restricted).length;
    if (restricted) {
      log(
        `平台标记 ${restricted}/${S.items.length} 张：本工具按「逐张下载」处理（等效右键另存），会尝试保存并在被拒时报告`,
        'ok',
      );
      const s0 = S.items.find((i) => i.restricted);
      if (s0) {
        log(
          `诊断样例：temporaryPhotoThaw.isRestricted=${s0.flagThaw} · isLimitViewByPhotoCount=${s0.flagLimit} · 原图地址=${s0.hasUrl ? (s0.urlDerived ? '接口未给，用缩略图反推' : '接口直给') : '无'}`,
        );
      }
      try {
        const nv = await api('notvip', { ...args, cursor: '' });
        log(`平台口径 notvip/count：isVip=${nv?.isVip} · 受限 ${nv?.photoCount ?? '?'} 张`);
      } catch (e) {
        log(`notvip/count 读取失败：${e.message}`);
      }
      if (restricted === S.items.length) {
        log('本次结果全部带平台标记 —— 若逐张保存也被拒，说明这批照片确实不允许非会员取用', 'err');
      }
    }

    renderGrid();
    $('resultCard').hidden = false;
    log(`查询完成：${S.items.length} 张`, 'ok');
  } catch (e) {
    log('查询失败：' + e.message, 'err');
  } finally {
    S.busy = false;
    $('btnQuery').disabled = false;
    setBar(0);
  }
}

async function resolveWatermarks(args) {
  // 用户已选定水印：直接套用名字
  if (S.wmSel.size === 1) {
    const row = (S.wmRows || []).find((r) => r.key === [...S.wmSel][0]);
    if (row) {
      for (const it of S.items) it.wm = row.name;
      return;
    }
  }
  if (S.wmSel.size > 1) return; // 多选时不额外反查，名字留空以免拖慢

  try {
    const cands = [];
    const seen = new Set();
    for (const w of S.wmDefs) {
      if (w.group_watermark_id) {
        const key = `${w.watermark_base_id}|${w.group_watermark_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cands.push({ name: w.name, filter: { watermarkBaseID: w.watermark_base_id, groupWatermarkID: w.group_watermark_id } });
      }
    }
    for (const w of S.wmDefs) {
      if (w.group_watermark_id || w.type === 1) continue;
      const key = `${w.watermark_base_id}|`;
      if (seen.has(key)) continue;
      seen.add(key);
      cands.push({ name: w.name, filter: { watermarkBaseID: w.watermark_base_id } });
    }

    const total = (await api('list', { ...args, cursor: '' }))?.total || 0;
    const hit = [];
    let covered = 0;
    for (const c of cands) {
      const t = (await api('list', { ...args, cursor: '', watermarks: [c.filter] }))?.total || 0;
      if (t > 0) { c.total = t; hit.push(c); covered += t; }
      if (covered >= total) break;
      await sleep(200);
    }
    if (hit.length === 1) {
      for (const it of S.items) it.wm = hit[0].name;
      return;
    }
    const map = new Map();
    for (const c of hit) {
      let cur = '';
      const seenC = new Set();
      while (true) {
        const p = await api('list', { ...args, cursor: cur, watermarks: [c.filter] });
        for (const ph of p?.photos || []) map.set(String(ph.seq), c.name);
        const next = p?.lastPageCond || '';
        if (!(p?.photos || []).length || !next || next === cur || seenC.has(next)) break;
        seenC.add(next);
        cur = next;
        await sleep(200);
      }
    }
    for (const it of S.items) it.wm = map.get(it.seq) || '';
  } catch {
    /* 水印名解析失败不影响下载 */
  }
}

// ============ 网格 ============
function renderGrid() {
  if (!S.items.length) {
    const [yf] = quickRange('yesterday');
    $('grid').innerHTML = `<div class="empty-state">
      <div class="empty-title">${S.from} ~ ${S.to} 没有照片</div>
      <div class="muted">当前时间 ${new Date().toLocaleString('zh-CN', { hour12: false })}。
        如果刚过零点，今天可能还没有人拍照。</div>
      <div class="empty-actions">
        <button class="chip" data-empty="yesterday">查昨天 <span id="yCnt"></span></button>
        <button class="chip" data-empty="7d">查最近 7 天</button>
      </div>
    </div>`;
    $('grid').querySelectorAll('[data-empty]').forEach((b) => {
      b.onclick = () => {
        const [f, t] = quickRange(b.dataset.empty);
        const label = b.dataset.empty === 'yesterday' ? '昨天' : '过去7天';
        setRange(f, t, label);
        query();
      };
    });
    // 顺手查一下昨天有多少张，作为引导
    api('list', {
      groupID: S.groupID, from: yf, to: yf,
      userIDs: [...S.userSel], watermarks: wmFilters(), cursor: '',
    })
      .then((p) => {
        const n = p?.total || 0;
        const el = $('yCnt');
        if (el) el.textContent = `（${n} 张）`;
      })
      .catch(() => {});
    $('pageInfo').textContent = '第 0/0 页';
    $('prevPage').disabled = true;
    $('nextPage').disabled = true;
    $('countText').textContent = '0 张照片';
    $('selText').textContent = '已选择 0 张照片';
    $('chkAll').checked = false;
    return;
  }
  const pages = Math.max(1, Math.ceil(S.items.length / PAGE_SIZE));
  if (S.page >= pages) S.page = pages - 1;
  const rows = S.items.slice(S.page * PAGE_SIZE, S.page * PAGE_SIZE + PAGE_SIZE);

  $('grid').innerHTML = rows
    .map((it) => {
      const sel = S.selected.has(it.seq);
      const cb = `<label class="cb"><input type="checkbox" data-sel="${it.seq}" ${sel ? 'checked' : ''} /></label>`;
      const badge = it.mediaType === 1 ? '<span class="badge">视频</span>' : '';
      const limit = it.restricted ? '<span class="flag">平台标记</span>' : '';
      return `<div class="cell ${sel ? 'sel' : ''}${it.restricted ? ' cell--flag' : ''}" data-seq="${it.seq}">
        <div class="thumb-wrap" data-open="${it.seq}">
          ${it.thumb ? `<img src="${it.thumb}" loading="lazy" referrerpolicy="no-referrer" />` : ''}
          ${badge}${limit}${cb}
        </div>
        <div class="cap"><div class="name">${it.person}</div>
          <div class="tm">${+fmtDate(it.time).slice(5, 7)}月${+fmtDate(it.time).slice(8, 10)}日 ${fmtTime(it.time).slice(0, 5)}</div>
          <div class="wmtag">${it.wm || ''}</div></div>
      </div>`;
    })
    .join('');

  $('grid').querySelectorAll('input[data-sel]').forEach((el) => {
    el.onclick = (e) => e.stopPropagation();
    el.onchange = () => {
      if (el.checked) S.selected.add(el.dataset.sel);
      else S.selected.delete(el.dataset.sel);
      el.closest('.cell')?.classList.toggle('sel', el.checked);
      updateCounts();
    };
  });
  $('grid').querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = () => openViewer(el.dataset.open);
  });

  $('pageInfo').textContent = `第 ${S.page + 1}/${pages} 页`;
  $('prevPage').disabled = S.page === 0;
  $('nextPage').disabled = S.page >= pages - 1;
  updateCounts();
}

function updateCounts() {
  const flagged = S.items.filter((i) => i.restricted).length;
  $('countText').textContent = `${S.items.length} 张照片`;
  $('selText').textContent =
    `已选择 ${S.selected.size} 张照片` + (flagged ? ` · 平台标记 ${flagged} 张（会尝试逐张保存）` : '');
  const all = S.items;
  $('chkAll').checked = all.length > 0 && all.every((i) => S.selected.has(i.seq));
}

// ============ 预览 ============
function openViewer(seq) {
  S.viewList = S.items.filter((i) => !i.restricted);
  S.viewIndex = S.viewList.findIndex((i) => i.seq === seq);
  if (S.viewIndex < 0) return;
  renderViewer();
  $('viewer').hidden = false;
}

function renderViewer() {
  const it = S.viewList[S.viewIndex];
  if (!it) return;
  $('vTitle').textContent = `${it.person} · ${fmtDate(it.time)} ${fmtTime(it.time)}${it.wm ? ' · ' + it.wm : ''}`;
  if (it.mediaType === 1) {
    $('vStage').innerHTML = it.videoUrl
      ? `<video src="${it.videoUrl}" controls autoplay playsinline></video>`
      : `<div class="v-note">该视频没有可播放地址（平台未返回 videoURL）<br />
          下面是首帧快照：<br /><img src="${it.imageUrl || ''}" referrerpolicy="no-referrer" style="max-height:60vh;margin-top:10px" /></div>`;
  } else {
    $('vStage').innerHTML = `<img src="${it.imageUrl || it.url}" referrerpolicy="no-referrer" />`;
  }
  $('vPrev').disabled = S.viewIndex <= 0;
  $('vNext').disabled = S.viewIndex >= S.viewList.length - 1;
}

function closeViewer() {
  $('vStage').innerHTML = '';
  $('viewer').hidden = true;
}

// ============ 下载设置 + 下载 ============
const DIM = {
  person: '拍摄人姓名',
  date: '拍摄日期',
  wm: '水印名称',
  dept: '部门',
  addr: '拍摄地点',
};
const TOKEN = { ...DIM, time: '拍摄时间' };

function deptNameOf(it) {
  const did = S.memberDept.get(it.userID);
  const d = S.depts.find((x) => x.id === did);
  return d ? d.name : '';
}

function dimValue(it, key) {
  switch (key) {
    case 'person': return safeName(it.person);
    case 'date': return fmtDate(it.time);
    case 'wm': return safeName(it.wm || '无水印');
    case 'dept': return safeName(deptNameOf(it) || '未分组');
    case 'addr': return safeName(it.addr || '未知地点');
    default: return '';
  }
}

function tokenValue(it, key) {
  if (key === 'time') return fmtTime(it.time).replace(/:/g, '_');
  if (key === 'date') return fmtDate(it.time);
  return dimValue(it, key);
}

function buildFileName(it) {
  const parts = S.dl.tokens.map((t) => tokenValue(it, t)).filter(Boolean);
  return `${parts.join(' ')}.${extOf(it)}`;
}

function buildRelPath(it) {
  const segs = S.dl.levels.filter(Boolean).map((k) => dimValue(it, k));
  return [...segs, buildFileName(it)];
}

function openDownloadDlg(items) {
  if (!items.length) return log('还没有勾选照片', 'err');
  S.pending = items;
  renderDownloadDlg();
  $('downloadDlg').hidden = false;
}

function fillLevelSelect(el, val, allowNone, noneLabel) {
  el.innerHTML =
    (allowNone ? `<option value="">${noneLabel}</option>` : '') +
    Object.entries(DIM)
      .map(([k, label]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${label}</option>`)
      .join('');
  el.value = val || '';
}

function renderDownloadDlg() {
  const [l0, l1, l2] = S.dl.levels;
  fillLevelSelect($('lv0'), l0, true, '不分类');
  fillLevelSelect($('lv1'), l1, true, '不分类');
  fillLevelSelect($('lv2'), l2, true, '不分类');

  // 命名标签
  $('dlChips').innerHTML =
    S.dl.tokens
      .map((t) => `<span class="chip-tag">${TOKEN[t]}<button data-rm="${t}">✕</button></span>`)
      .join('') || '<span class="muted">至少保留一个字段</span>';
  $('dlChips').querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = () => {
      if (S.dl.tokens.length <= 1) return log('至少要保留一个命名字段', 'err');
      S.dl.tokens = S.dl.tokens.filter((x) => x !== b.dataset.rm);
      renderDownloadDlg();
      saveAccountSettings();
    };
  });
  const addable = Object.entries(TOKEN).filter(([k]) => !S.dl.tokens.includes(k));
  $('dlTokenAdd').innerHTML =
    '<option value="">＋ 添加字段</option>' +
    addable.map(([k, label]) => `<option value="${k}">${label}</option>`).join('');

  // 示例 + 预览
  const sample = S.pending[0];
  $('dlExample').textContent = sample ? buildFileName(sample) : '';
  const counts = new Map();
  for (const it of S.pending.slice(0, 100)) {
    const segs = S.dl.levels.filter(Boolean).map((k) => dimValue(it, k));
    const key = segs.join(' / ') || '（不分类）';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  $('dlPreview').innerHTML =
    [...counts.entries()]
      .slice(0, 8)
      .map(([k, n]) => `<div class="d1">📁 ${k} <span class="muted">(${n} 张)</span></div>`)
      .join('') || '<div class="muted">没有可预览的目录</div>';
  $('dlCount').textContent = `已选择 ${S.pending.length} 张照片`;
}

async function downloadPending(dirHandle) {
  const items = S.pending;
  let dl = 0, blocked = 0, noUrl = 0, fail = 0, bytes = 0;
  const used = new Set();

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.url) {
      noUrl++;
      if (noUrl <= 3) {
        log(
          `无可用地址，跳过：${it.person} ${fmtDate(it.time)}${it.mediaType === 1 ? '（视频：平台未返回 videoURL）' : ''}`,
          'err',
        );
      }
      setBar(((i + 1) * 100) / items.length);
      continue;
    }
    try {
      const res = await fetch(it.url, { credentials: 'omit', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 1000) throw new Error('内容过小');

      let segs = buildRelPath(it);
      let fileName = segs[segs.length - 1];
      const dirs = segs.slice(0, -1);
      const fullKey = [...dirs, fileName].join('/');
      if (used.has(fullKey)) {
        fileName = fileName.replace(/\.([^.]+)$/, ` ${it.seq}.$1`);
      }
      used.add([...dirs, fileName].join('/'));

      let handle = dirHandle;
      for (const d of dirs) handle = await handle.getDirectoryHandle(d, { create: true });
      const fh = await handle.getFileHandle(fileName, { create: true }); // 同名直接覆盖
      const w = await fh.createWritable();
      await w.write(buf);
      await w.close();
      dl++;
      bytes += buf.byteLength;
      if (dl <= 3) log(`已写入 ${[...dirs, fileName].join('/')}`, 'ok');
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/HTTP (40[13]|451)/.test(msg)) {
        blocked++;
        if (blocked <= 3) log(`平台拒绝该图（${msg}）：${it.person} ${fmtDate(it.time)}`, 'err');
      } else {
        fail++;
        log(`失败 ${it.person} ${fmtDate(it.time)}：${msg}`, 'err');
      }
    }
    setBar(((i + 1) * 100) / items.length);
  }
  log(
    `完成：下载 ${dl} 张（${(bytes / 1048576).toFixed(1)} MB）` +
      (blocked ? `，被平台拒绝 ${blocked} 张` : '') +
      (noUrl ? `，无可用地址 ${noUrl} 张` : '') +
      (fail ? `，其他失败 ${fail} 张` : ''),
    blocked || noUrl || fail ? 'err' : 'ok',
  );
}

async function downloadItems(items) {
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'wmc-out' });
  } catch (e) {
    if (e.name !== 'AbortError') log('选择目录失败：' + e.message, 'err');
    return;
  }
  S.busy = true;
  $('btnDownload').disabled = true;
  try {
    await downloadPending(dirHandle);
  } finally {
    S.busy = false;
    $('btnDownload').disabled = false;
    setBar(0);
  }
  clearCache({ silent: true }); // 只清照片/视频缓存，配置与账号信息保留
}

// ============ 导出清单（只含元数据，不含照片）============
function csvCell(v) {
  const t = String(v == null ? '' : v);
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function exportList() {
  if (!S.items.length) return log('还没有查询结果', 'err');
  const head = ['姓名', '部门', '拍摄时间', '类型', '水印', '是否受限', '预计文件名'];
  const rows = S.items.map((it) => [
    it.person,
    deptNameOf(it) || '',
    `${fmtDate(it.time)} ${fmtTime(it.time)}`,
    it.mediaType === 1 ? '视频' : '照片',
    it.wm || '',
    it.restricted ? '受限(需会员)' : '可下载',
    buildFileName(it),
  ]);
  const csv = '\ufeff' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `照片清单_${S.from}_${S.to}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
  const limitedCount = S.items.filter((i) => i.restricted).length;
  log(`已导出清单 ${S.items.length} 条（其中受限 ${limitedCount} 条）→ ${a.download}`, 'ok');
}

// ============ 缓存清理 ============
function clearCache({ silent = false } = {}) {
  closeViewer();
  S.items = [];
  S.selected = new Set();
  S.viewList = [];
  S.page = 0;
  $('grid').innerHTML = '';
  $('resultCard').hidden = true;
  $('countText').textContent = '0 张照片';
  $('selText').textContent = '已选择 0 张照片';
  if (!silent) log('已清理查询缓存');
  else log('已清理查询缓存（内存中的列表、选择、预览均已释放）', 'ok');
}

// ============ 事件 ============
function bind() {
  const [f, t] = quickRange('today');
  setRange(f, t, '今天');

  $('dateBtn').onclick = openDateDlg;
  $('memberBtn').onclick = openMemberDlg;
  $('wmBtn').onclick = openWmDlg;

  document.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => (b.closest('.overlay').hidden = true);
  });
  document.querySelectorAll('.overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => {
      if (e.target === ov) ov.hidden = true;
    });
  });

  // 日期弹窗
  document.querySelectorAll('#dateDlg .tab').forEach((t2) => {
    t2.onclick = () => {
      document.querySelectorAll('#dateDlg .tab').forEach((x) => x.classList.remove('active'));
      t2.classList.add('active');
      S.dMode = t2.dataset.mode;
      renderCalendars();
    };
  });
  $('dateOk').onclick = () => {
    const f2 = S.dFrom ? ymd(S.dFrom) : S.from;
    const t2 = S.dTo ? ymd(S.dTo) : S.dFrom ? ymd(S.dFrom) : S.to;
    const quickLabel = S.dQuick ? QUICK.find((q) => q[0] === S.dQuick)?.[1] : '';
    setRange(f2, t2, quickLabel);
    $('dateDlg').hidden = true;
  };

  // 成员弹窗
  $('mSearch').oninput = () => renderMemberTree();
  $('onlyActive').onchange = () => renderMemberTree();
  $('mAll').onclick = () => {
    S.mTemp = new Set(S.persons.map((p) => p.userID));
    renderMemberTree();
    renderPicked();
  };
  $('mClear').onclick = () => {
    S.mTemp = new Set();
    renderMemberTree();
    renderPicked();
  };
  $('memberOk').onclick = () => {
    S.userSel = new Set(S.mTemp);
    refreshFilterLabels();
    $('memberDlg').hidden = true;
    saveAccountSettings();
  };

  // 水印弹窗
  $('wmOk').onclick = () => {
    S.wmSel = new Set(S.wmTemp);
    refreshFilterLabels();
    $('wmDlg').hidden = true;
    saveAccountSettings();
  };

  // 快捷日期
  document.querySelectorAll('[data-quick]').forEach((a) => {
    a.onclick = () => {
      const [f2, t2] = quickRange(a.dataset.quick);
      const label = QUICK.find((q) => q[0] === a.dataset.quick)?.[1] || '';
      setRange(f2, t2, label);
    };
  });

  $('accountBtn').onclick = () => {
    if (S.loggedIn) signOut({ thenLogin: true });
    else openLoginDlg();
  };
  $('loginPopup').onclick = loginInPopup;
  $('loginRetry').onclick = async () => {
    if (await afterLogin()) $('loginDlg').hidden = true;
  };
  $('loginDlg').querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => {
      stopLoginPoll();
      $('loginFrame').src = 'about:blank';
    });
  });

  $('groupBtn').onclick = openGroupDlg;
  $('gAdd').onclick = () => {
    const name = $('gName').value.trim();
    if (!name) return;
    S.gTemp.depts.push({ id: gid(), name });
    $('gName').value = '';
    renderGroupDlg();
  };
  $('gName').onkeydown = (e) => { if (e.key === 'Enter') $('gAdd').click(); };
  $('gSearch').oninput = () => renderGroupDlg();
  $('gSave').onclick = async () => {
    S.manual = { depts: S.gTemp.depts, assign: { ...S.gTemp.assign } };
    await saveGroups();
    $('groupDlg').hidden = true;
    await refreshDepts();
    log(`分组已保存（${S.manual.depts.length} 个自定义部门），清理查询缓存不会删除`, 'ok');
  };

  $('btnQuery').onclick = query;
  $('btnReset').onclick = () => {
    const [f2, t2] = quickRange('today');
    setRange(f2, t2, '今天');
    S.userSel = new Set();
    S.wmSel = new Set();
    $('memberBtn').textContent = '筛选人员 · 全部成员 ▾';
    $('wmBtn').textContent = '筛选水印 · 全部 ▾';
    clearCache({ silent: true });
    log('已重置筛选条件');
  };
  $('btnClean').onclick = () => clearCache();

  // 与后台一致：全选 = 选中全部结果（不只是当前页）
  $('chkAll').onchange = (e) => {
    for (const it of S.items) {
      if (e.target.checked) S.selected.add(it.seq);
      else S.selected.delete(it.seq);
    }
    renderGrid();
  };
  $('prevPage').onclick = () => { S.page = Math.max(0, S.page - 1); renderGrid(); };
  $('nextPage').onclick = () => { S.page++; renderGrid(); };
  $('btnCsv').onclick = () => exportList();

  $('btnDownload').onclick = () => {
    const picked = S.items.filter((i) => S.selected.has(i.seq));
    if (!picked.length) return log('还没有勾选照片', 'err');
    openDownloadDlg(picked);
  };

  // 下载设置弹窗
  ['lv0', 'lv1', 'lv2'].forEach((id, idx) => {
    $(id).onchange = () => {
      S.dl.levels[idx] = $(id).value;
      renderDownloadDlg();
      saveAccountSettings();
    };
  });
  $('dlTokenAdd').onchange = () => {
    const v = $('dlTokenAdd').value;
    if (!v) return;
    S.dl.tokens.push(v);
    $('dlTokenAdd').value = '';
    renderDownloadDlg();
    saveAccountSettings();
  };
  $('dlGo').onclick = async () => {
    $('downloadDlg').hidden = true;
    await saveAccountSettings(); // 目录分层 + 命名方式按账号记住
    await downloadItems(S.pending);
  };

  // 预览
  $('vClose').onclick = closeViewer;
  $('vPrev').onclick = () => { if (S.viewIndex > 0) { S.viewIndex--; renderViewer(); } };
  $('vNext').onclick = () => { if (S.viewIndex < S.viewList.length - 1) { S.viewIndex++; renderViewer(); } };
  $('vDownload').onclick = () => {
    const it = S.viewList[S.viewIndex];
    if (it) openDownloadDlg([it]);
  };
  document.addEventListener('keydown', (e) => {
    if ($('viewer').hidden) return;
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowLeft') $('vPrev').click();
    if (e.key === 'ArrowRight') $('vNext').click();
  });
}

(async function init() {
  bind();
  const ok = await connect({ silent: true });
  $('resultCard').hidden = false;
  if (!ok) {
    log('还没登录。请在弹出的窗口里登录今日水印相机（手机号或微信扫码）。', 'err');
    await openLoginDlg();
    return;
  }
  try {
    await loadAccountSettings(); // 按账号恢复：命名方式/目录分层/筛选
    await loadOrg();
    refreshFilterLabels();
    log(
      `就绪：已连接「${S.group?.group_name || ''}」，${S.persons.length} 位成员，${S.depts.length} 个部门。`,
      'ok',
    );
  } catch (e) {
    log('读取组织架构失败：' + e.message, 'err');
  }
  // 打开即自动查询当天的照片（只跑一次）
  if (!S.autoQueried) {
    S.autoQueried = true;
    await query();
  }
})();
