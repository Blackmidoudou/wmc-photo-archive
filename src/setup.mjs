// 一键：登录 → 探测
// 只做这一件事，跑完把 probe/ 里的结果交给下一步。
import { login } from './login.mjs';
import { probe } from './probe.mjs';

const headless = process.argv.includes('--headless');

await login({ headless });
await probe({ headless: false });
