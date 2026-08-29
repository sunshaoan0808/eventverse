// 事件verse 看门狗：server 意外退出（如 Node/libuv 在 Windows 上的并发 abort）自动拉起
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, 'apps/server/dist/index.js');

let n = 0;
function start() {
  n++;
  const child = spawn(process.execPath, [ENTRY], { stdio: 'inherit' });
  console.log(`[watchdog] server 启动（第 ${n} 次，pid=${child.pid}）`);
  child.on('exit', (code, sig) => {
    if (child.__restarting) return;
    console.log(`[watchdog] server 退出（code=${code} sig=${sig}），2 秒后重启…`);
    setTimeout(start, 2000);
  });
  ['SIGINT', 'SIGTERM'].forEach(sig => {
    process.on(sig, () => { child.__restarting = true; child.kill(); process.exit(0); });
  });
}
start();
