import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const port = Number(process.env.ZHIHU_CDP_PORT || 9222);
const profile = process.env.ZHIHU_PROFILE_DIR || path.join(os.homedir(), '.zhihu-archive', 'chrome-profile');

function chromePaths() {
  const envPath = process.env.CHROME_PATH;
  const list = envPath ? [envPath] : [];
  if (process.platform === 'win32') {
    list.push(
      path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Chromium/Application/chrome.exe'),
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return list;
}

async function cdpAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const alive = await cdpAlive();
if (alive) {
  console.log(`Chrome 调试端口已开启：${alive.Browser}`);
  console.log(`如果还没登录知乎，请在打开的 Chrome 窗口里扫码登录。`);
  process.exit(0);
}

const chrome = chromePaths().find((p) => p && fs.existsSync(p));
if (!chrome) {
  console.error('没有找到 Chrome。请先安装 Google Chrome，或设置 CHROME_PATH 环境变量。');
  process.exit(2);
}

fs.mkdirSync(profile, { recursive: true });
const args = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--remote-allow-origins=*',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  '--window-size=1440,1000',
  'https://www.zhihu.com/',
];

const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
child.unref();

for (let i = 0; i < 40; i++) {
  const info = await cdpAlive();
  if (info) {
    console.log(`Chrome 已启动：${info.Browser}`);
    console.log(`配置目录：${profile}`);
    console.log('');
    console.log('请在打开的 Chrome 窗口里用知乎 App 扫码登录，登录后保持窗口运行，再执行归档命令。');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}

console.error('Chrome 调试端口没有打开。请检查 Chrome 是否被安全软件拦截，或手动运行：');
console.error(`"${chrome}" ${args.join(' ')}`);
process.exit(1);
