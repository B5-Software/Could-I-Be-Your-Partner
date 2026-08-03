/**
 * aria2 二进制下载脚本
 *
 * 下载 aria2c 二进制到 assets/aria2/{platform}-{arch}/ 目录。
 * 打包前由 build-all-win.js 调用，确保对应平台的二进制存在。
 *
 * 用法：
 *   node scripts/download-aria2.js            # 下载当前平台
 *   node scripts/download-aria2.js --all       # 下载所有平台
 *   node scripts/download-aria2.js win x64     # 下载指定平台和架构
 *
 * 目录结构（与 electron-builder 的 ${os} 变量一致）：
 *   assets/aria2/win-x64/aria2c.exe
 *   assets/aria2/win-arm64/aria2c.exe       (使用 x64 版，Win11 兼容)
 *   assets/aria2/mac-x64/aria2c
 *   assets/aria2/mac-arm64/aria2c          (使用 x64 版，Rosetta 兼容)
 *   assets/aria2/linux-x64/aria2c
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const ARIA2_VERSION = '1.37.0';
const projectRoot = path.resolve(__dirname, '..');
const assetsDir = path.join(projectRoot, 'assets', 'aria2');

// 各平台的下载源（GitHub Releases）
const ASSETS = {
  'win-x64': {
    url: `https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/aria2-${ARIA2_VERSION}-win-64bit-build1.zip`,
    type: 'zip',
    exeName: 'aria2c.exe',
    dirName: 'win-x64'
  },
  'win-arm64': {
    // aria2 官方无 arm64 Windows 构建，使用 x64 版（Windows 11 可运行 x64 程序）
    url: `https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/aria2-${ARIA2_VERSION}-win-64bit-build1.zip`,
    type: 'zip',
    exeName: 'aria2c.exe',
    dirName: 'win-arm64'
  },
  'darwin-x64': {
    url: `https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/aria2-${ARIA2_VERSION}-osx-darwin.tar.bz2`,
    type: 'tarbz2',
    exeName: 'aria2c',
    // 目录映射：darwin → mac（与 electron-builder ${os} 变量一致）
    dirName: 'mac-x64'
  },
  'darwin-arm64': {
    // macOS arm64 使用 Intel 版（Rosetta 兼容）
    url: `https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/aria2-${ARIA2_VERSION}-osx-darwin.tar.bz2`,
    type: 'tarbz2',
    exeName: 'aria2c',
    dirName: 'mac-arm64'
  },
  'linux-x64': {
    url: `https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/aria2-${ARIA2_VERSION}-linux-x86_64.tar.bz2`,
    type: 'tarbz2',
    exeName: 'aria2c',
    dirName: 'linux-x64'
  }
};

function downloadFile(url, dest) {
  return new Promise((resolve) => {
    const follow = (u, redirects = 0) => {
      if (redirects > 5) return resolve(false);
      const parsed = new URL(u);
      const proto = parsed.protocol === 'https:' ? https : http;
      const req = proto.get(u, {
        headers: { 'User-Agent': 'Could-I-Be-Your-Partner/aria2-setup' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          console.error(`  下载失败: HTTP ${res.statusCode}`);
          return resolve(false);
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const stream = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = Math.floor((downloaded / total) * 100);
            process.stdout.write(`\r  下载进度: ${pct}% (${(downloaded / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB)`);
          }
        });
        res.pipe(stream);
        stream.on('finish', () => {
          stream.close();
          process.stdout.write('\n');
          resolve(true);
        });
        stream.on('error', () => {
          try { fs.unlinkSync(dest); } catch {}
          resolve(false);
        });
      });
      req.on('error', (e) => {
        console.error(`  下载错误: ${e.message}`);
        resolve(false);
      });
      req.setTimeout(120000, () => { req.destroy(); resolve(false); });
    };
    follow(url);
  });
}

function extractZip(archivePath, destDir) {
  // Windows: 使用 PowerShell Expand-Archive
  const psCmd = `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`;
  execFileSync('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'inherit', timeout: 30000 });
}

function extractTarBz2(archivePath, destDir) {
  execFileSync('tar', ['-xjf', archivePath, '-C', destDir], { stdio: 'inherit', timeout: 30000 });
}

function flattenBinary(destDir, exeName) {
  // aria2 压缩包解压后会创建 aria2-<version>-<platform>/ 子目录
  // 将其中的 aria2c[.exe] 移动到 destDir 根目录
  try {
    const entries = fs.readdirSync(destDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subExe = path.join(destDir, entry.name, exeName);
        if (fs.existsSync(subExe)) {
          const finalPath = path.join(destDir, exeName);
          fs.copyFileSync(subExe, finalPath);
          // 清理子目录
          try { fs.rmSync(path.join(destDir, entry.name), { recursive: true, force: true }); } catch {}
          // 设置可执行权限（非 Windows）
          if (process.platform !== 'win32') {
            try { fs.chmodSync(finalPath, 0o755); } catch {}
          }
          return true;
        }
      }
    }
  } catch (e) {
    console.error(`  flatten 失败: ${e.message}`);
  }
  return false;
}

async function downloadForPlatform(platformKey) {
  const config = ASSETS[platformKey];
  if (!config) {
    console.error(`未知平台: ${platformKey}`);
    return false;
  }

  // 使用 dirName（darwin → mac 映射后的目录名）
  const dirName = config.dirName || platformKey;
  const destDir = path.join(assetsDir, dirName);
  const exePath = path.join(destDir, config.exeName);

  // 已存在则跳过
  if (fs.existsSync(exePath)) {
    console.log(`[aria2] ${platformKey} 二进制已存在: ${exePath}`);
    return true;
  }

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  console.log(`[aria2] 正在下载 ${platformKey}: ${config.url}`);
  const archiveName = path.basename(new URL(config.url).pathname);
  const archivePath = path.join(destDir, archiveName);

  const ok = await downloadFile(config.url, archivePath);
  if (!ok) {
    console.error(`[aria2] ${platformKey} 下载失败`);
    return false;
  }

  console.log(`[aria2] 正在解压 ${platformKey}...`);
  try {
    if (config.type === 'zip') {
      extractZip(archivePath, destDir);
    } else if (config.type === 'tarbz2') {
      extractTarBz2(archivePath, destDir);
    }
  } catch (e) {
    console.error(`[aria2] 解压失败: ${e.message}`);
    return false;
  } finally {
    try { fs.unlinkSync(archivePath); } catch {}
  }

  // 将二进制从子目录提取到根目录
  if (flattenBinary(destDir, config.exeName)) {
    console.log(`[aria2] ${platformKey} 二进制就绪: ${exePath}`);
    return true;
  }

  console.error(`[aria2] ${platformKey} 解压后未找到 ${config.exeName}`);
  return false;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--all')) {
    // 下载所有平台
    console.log('[aria2] 下载所有平台的 aria2 二进制...\n');
    let allOk = true;
    for (const key of Object.keys(ASSETS)) {
      const ok = await downloadForPlatform(key);
      if (!ok) allOk = false;
      console.log('');
    }
    process.exit(allOk ? 0 : 1);
    return;
  }

  if (args.length >= 2) {
    // 指定平台和架构
    const platform = args[0];
    const arch = args[1];
    const key = `${platform}-${arch}`;
    const ok = await downloadForPlatform(key);
    process.exit(ok ? 0 : 1);
    return;
  }

  // 默认下载当前平台
  const currentPlatform = process.platform === 'win32' ? 'win'
    : process.platform === 'darwin' ? 'darwin' : 'linux';
  const currentArch = process.arch;
  const key = `${currentPlatform}-${currentArch}`;
  const ok = await downloadForPlatform(key);
  process.exit(ok ? 0 : 1);
}

main();
