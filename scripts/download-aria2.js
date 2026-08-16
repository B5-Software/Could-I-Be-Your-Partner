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
 *
 * 下载源：
 *   win-x64 / win-arm64 → aria2 官方 GitHub Releases（win-64bit-build1）
 *   mac-x64 / mac-arm64 → 官方 release-1.35.0 osx-darwin.tar.bz2
 *                         （1.37.0 起官方不再发布 macOS 二进制）
 *   linux-x64           → abcfy2/aria2-static-build 1.37.0 musl 静态构建
 *                         （官方从不提供 Linux 预编译二进制）
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
    // 官方 1.37.0 起不再发布 osx-darwin 二进制（仅 win/android/源码），
    // 1.35.0 为最后一个含 osx-darwin 包的版本（x86_64）
    url: `https://github.com/aria2/aria2/releases/download/release-1.35.0/aria2-1.35.0-osx-darwin.tar.bz2`,
    type: 'tarbz2',
    exeName: 'aria2c',
    // 目录映射：darwin → mac（与 electron-builder ${os} 变量一致）
    dirName: 'mac-x64'
  },
  'darwin-arm64': {
    // macOS arm64 使用 Intel 版（Rosetta 兼容）
    url: `https://github.com/aria2/aria2/releases/download/release-1.35.0/aria2-1.35.0-osx-darwin.tar.bz2`,
    type: 'tarbz2',
    exeName: 'aria2c',
    dirName: 'mac-arm64'
  },
  'linux-x64': {
    // 官方不提供 Linux 预编译二进制，使用 abcfy2/aria2-static-build 的
    // 1.37.0 musl 静态构建（x86_64-unknown-linux-musl，OpenSSL + zlib-ng）
    url: `https://github.com/abcfy2/aria2-static-build/releases/download/1.37.0/aria2-x86_64-linux-musl_static.zip`,
    type: 'zip',
    exeName: 'aria2c',
    dirName: 'linux-x64'
  }
};

function downloadFile(url, dest, attempt = 1) {
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
  }).then((ok) => {
    // 网络抖动（socket hang up / ECONNRESET）常见，最多重试 3 次
    if (!ok && attempt < 3) {
      console.warn(`  下载失败，${2 * attempt}s 后重试 (${attempt + 1}/3)...`);
      return new Promise((r) => setTimeout(r, 2000 * attempt))
        .then(() => downloadFile(url, dest, attempt + 1));
    }
    return ok;
  });
}

function extractZip(archivePath, destDir) {
  if (process.platform === 'win32') {
    // Windows: 使用 PowerShell Expand-Archive
    const psCmd = `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`;
    execFileSync('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'inherit', timeout: 30000 });
  } else {
    // macOS / Linux: 系统 unzip（ubuntu/macos runner 均自带）
    execFileSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit', timeout: 30000 });
  }
}

function extractTarBz2(archivePath, destDir) {
  execFileSync('tar', ['-xjf', archivePath, '-C', destDir], { stdio: 'inherit', timeout: 30000 });
}

function findFileRecursive(dir, name) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFileRecursive(p, name);
        if (found) return found;
      } else if (entry.name === name) {
        return p;
      }
    }
  } catch {}
  return null;
}

function flattenBinary(destDir, exeName) {
  // 压缩包可能直接包含 aria2c[.exe]，或带一层/多层子目录（如 aria2-1.35.0/bin/aria2c），
  // 统一确保二进制位于 destDir 根目录
  const finalPath = path.join(destDir, exeName);
  if (fs.existsSync(finalPath)) {
    // 已位于根目录：直接设置可执行权限
    if (process.platform !== 'win32') {
      try { fs.chmodSync(finalPath, 0o755); } catch {}
    }
    return true;
  }
  const found = findFileRecursive(destDir, exeName);
  if (found && found !== finalPath) {
    try {
      fs.copyFileSync(found, finalPath);
      if (process.platform !== 'win32') {
        try { fs.chmodSync(finalPath, 0o755); } catch {}
      }
      // 清理解压残留（保留根目录文件本身）
      const subDirs = fs.readdirSync(destDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(destDir, e.name));
      for (const d of subDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
      }
      return true;
    } catch (e) {
      console.error(`  flatten 失败: ${e.message}`);
    }
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
    const failed = [];
    for (const key of Object.keys(ASSETS)) {
      const ok = await downloadForPlatform(key);
      if (!ok) failed.push(key);
      console.log('');
    }
    if (failed.length > 0) {
      // 单个平台失败不阻塞整个构建：CI 网络稳定通常全量成功；本地受 GFW 影响时，
      // 缺少的平台若为当前构建所需，electron-builder 会因 extraResources 缺失而明确报错兜底
      console.warn(`[aria2] 以下平台下载失败（不影响已就绪平台）: ${failed.join(', ')}`);
      console.warn('[aria2] 提示：可稍后重试 `node scripts/download-aria2.js --all`，或手动放置二进制到 assets/aria2/<os>-<arch>/');
    }
    process.exit(0);
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
