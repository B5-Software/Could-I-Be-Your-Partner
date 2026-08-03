/**
 * Windows 全量打包脚本（x64/arm64 × 有/无塔罗牌 = 4 个包）
 *
 * 用法：node scripts/build-all-win.js
 *
 * 输出 4 个安装包到 dist/ 目录：
 *   - Could-I-Be-Your-Partner-<ver>-win-x64-tarot.exe     (有塔罗牌 x64)
 *   - Could-I-Be-Your-Partner-<ver>-win-x64-notarot.exe   (无塔罗牌 x64)
 *   - Could-I-Be-Your-Partner-<ver>-win-arm64-tarot.exe   (有塔罗牌 arm64)
 *   - Could-I-Be-Your-Partner-<ver>-win-arm64-notarot.exe (无塔罗牌 arm64)
 *
 * 策略：
 *   - electron-builder 输出到工作区外的临时目录（避免 IDE 文件监视器锁文件）
 *   - 临时修改 package.json 的 arch 配置，打包后恢复
 *   - arm64 构建跳过原生模块重编译（使用预编译二进制）
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const flagFile = path.join(projectRoot, '.no-tarot');
const pkgPath = path.join(projectRoot, 'package.json');

// 使用工作区外的临时目录作为 electron-builder 输出，避免 IDE 文件监视器锁定文件
const buildOutDir = 'D:\\Electron-Build-Temp';

// 从 package.json 读取版本号
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
const productName = pkg.build.productName;

// 保存原始 package.json 内容，便于恢复
const originalPkgContent = fs.readFileSync(pkgPath, 'utf8');

// electron-builder 默认产物文件名（NSIS）
function defaultSetupName() {
  return `${productName} Setup ${version}.exe`;
}

// 目标重命名格式
function targetName(arch, tarot) {
  return `Could-I-Be-Your-Partner-${version}-win-${arch}-${tarot}.exe`;
}

// 杀掉可能占用产物的进程
function killBlockingProcesses() {
  if (process.platform !== 'win32') return;
  const names = [
    'Could I Be Your Partner.exe',
    'electron.exe',
    'Could-I-Be-Your-Partner.exe'
  ];
  for (const name of names) {
    try {
      execSync(`taskkill /F /IM "${name}"`, { stdio: 'ignore' });
      console.log(`[build-all] 已终止进程: ${name}`);
    } catch {}
  }
  try { execSync('timeout /t 1 /nobreak >nul', { stdio: 'ignore' }); } catch {}
}

// 修改 package.json 的 win.target.arch 为指定架构
function setPkgArch(arch) {
  const p = JSON.parse(originalPkgContent);
  if (!p.build.win || !p.build.win.target || !p.build.win.target[0]) {
    throw new Error('package.json build.win.target 结构异常');
  }
  p.build.win.target[0].arch = [arch];
  fs.writeFileSync(pkgPath, JSON.stringify(p, null, 2), 'utf8');
  console.log(`[build-all] package.json arch 已设置为: ${arch}`);
}

// 恢复原始 package.json
function restorePkg() {
  fs.writeFileSync(pkgPath, originalPkgContent, 'utf8');
  console.log('[build-all] package.json 已恢复');
}

// 清空 dist 目录（只放最终 exe，不会被 IDE 锁定）
function cleanDist() {
  console.log('[build-all] 清空 dist 目录...');
  killBlockingProcesses();
  if (fs.existsSync(distDir)) {
    try {
      for (const entry of fs.readdirSync(distDir)) {
        const p = path.join(distDir, entry);
        try { fs.unlinkSync(p); } catch {
          try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
        }
      }
    } catch (e) {
      console.warn(`[build-all] 警告: 清空 dist 时出错: ${e.message}`);
    }
  }
  fs.mkdirSync(distDir, { recursive: true });
  console.log('[build-all] dist 目录已清空');
}

// 清空临时构建目录（工作区外，不会被 IDE 锁）
function cleanBuildOut() {
  if (fs.existsSync(buildOutDir)) {
    try {
      fs.rmSync(buildOutDir, { recursive: true, force: true });
    } catch {
      try {
        execSync(`rd /S /Q "${buildOutDir}"`, { stdio: 'ignore' });
      } catch {}
    }
  }
  fs.mkdirSync(buildOutDir, { recursive: true });
  console.log(`[build-all] 临时构建目录已就绪: ${buildOutDir}`);
}

// 修补 node-pty：禁用 Spectre 缓解要求（避免需要安装 ARM64 Spectre 库）
function patchNodePty() {
  const files = [
    path.join(projectRoot, 'node_modules', 'node-pty', 'binding.gyp'),
    path.join(projectRoot, 'node_modules', 'node-pty', 'deps', 'winpty', 'src', 'winpty.gyp'),
  ];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    let content = fs.readFileSync(f, 'utf8');
    const updated = content.replace(/'SpectreMitigation':\s*'Spectre'/g, "'SpectreMitigation': 'false'");
    if (updated !== content) {
      fs.writeFileSync(f, updated, 'utf8');
      console.log(`[build-all] 已修补 SpectreMitigation: ${path.basename(f)}`);
    }
  }
  // 删除 node-pty 的 build 目录，让 node-gyp 重新生成 vcxproj
  const buildDir = path.join(projectRoot, 'node_modules', 'node-pty', 'build');
  if (fs.existsSync(buildDir)) {
    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch {}
  }
}

// 确保 aria2 二进制存在（打包前下载对应架构的 aria2c）
function ensureAria2Binary(arch) {
  const aria2Dir = path.join(projectRoot, 'assets', 'aria2', `win-${arch}`);
  const exePath = path.join(aria2Dir, 'aria2c.exe');
  if (fs.existsSync(exePath)) {
    console.log(`[build-all] aria2 二进制已存在: win-${arch}`);
    return;
  }
  console.log(`[build-all] 正在下载 aria2 二进制: win-${arch}...`);
  try {
    execSync(`node "${path.join(projectRoot, 'scripts', 'download-aria2.js')}" win ${arch}`, {
      cwd: projectRoot,
      stdio: 'inherit'
    });
    if (!fs.existsSync(exePath)) {
      console.warn(`[build-all] 警告: aria2 二进制下载后仍未找到: ${exePath}`);
    }
  } catch (e) {
    console.warn(`[build-all] 警告: aria2 二进制下载失败: ${e.message}`);
    console.warn(`[build-all] 打包将继续，但安装后下载功能将不可用`);
  }
}

// 执行单个打包任务
function runBuild(arch, withTarot) {
  return new Promise((resolve, reject) => {
    const label = withTarot ? '有塔罗牌' : '无塔罗牌';
    console.log(`\n[build-all] 开始打包: Windows ${arch} ${label}`);

    // 每次打包前清理临时目录
    cleanBuildOut();

    // 修改 package.json 的 arch
    try {
      setPkgArch(arch);
    } catch (e) {
      return reject(e);
    }

    // 构建参数
    const args = ['electron-builder', '--win', `--${arch}`, `-c.directories.output=${buildOutDir}`];

    const env = { ...process.env };

    if (!withTarot) {
      try {
        fs.writeFileSync(flagFile, 'no-tarot\n', 'utf8');
        console.log('[build-all] 已创建 .no-tarot 标志文件');
      } catch (e) {
        restorePkg();
        return reject(new Error(`创建 .no-tarot 失败: ${e.message}`));
      }
    }

    const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    console.log(`[build-all] 执行: ${cmd} ${args.join(' ')}`);

    // 设置国内镜像源
    env.ELECTRON_MIRROR = env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
    env.ELECTRON_BUILDER_BINARIES_MIRROR = env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/';
    env.CI = '';

    const child = spawn(cmd, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: true,
      env
    });

    child.on('error', (err) => {
      cleanupFlag();
      restorePkg();
      reject(new Error(`打包失败: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      cleanupFlag();
      restorePkg();
      if (signal) {
        return reject(new Error(`被信号 ${signal} 终止`));
      }
      if (code !== 0) {
        return reject(new Error(`退出码: ${code}`));
      }

      // 把产物从临时目录复制到 dist，并重命名
      try {
        const defaultName = defaultSetupName();
        const defaultPath = path.join(buildOutDir, defaultName);
        const targetPath = path.join(distDir, targetName(arch, withTarot ? 'tarot' : 'notarot'));

        if (fs.existsSync(defaultPath)) {
          fs.copyFileSync(defaultPath, targetPath);
          console.log(`[build-all] 产物已复制到: ${path.basename(targetPath)}`);
        } else {
          // 查找可能的产物文件
          const files = fs.readdirSync(buildOutDir).filter(f => f.endsWith('.exe'));
          if (files.length > 0) {
            fs.copyFileSync(path.join(buildOutDir, files[0]), targetPath);
            console.log(`[build-all] 产物已复制到: ${path.basename(targetPath)}`);
          } else {
            console.warn('[build-all] 警告: 未找到产物 exe 文件');
          }
        }
      } catch (e) {
        console.warn(`[build-all] 复制产物时出错: ${e.message}`);
      }

      // 清理临时目录
      cleanBuildOut();

      console.log(`[build-all] 完成: Windows ${arch} ${label}`);
      resolve();
    });
  });
}

function cleanupFlag() {
  try {
    if (fs.existsSync(flagFile)) {
      fs.unlinkSync(flagFile);
      console.log('[build-all] 已删除 .no-tarot 标志文件');
    }
  } catch {}
}

// 主流程
async function main() {
  console.log(`[build-all] 版本: ${version}`);
  console.log('[build-all] 将打包 4 个安装包: x64/arm64 × 有/无塔罗牌\n');
  console.log(`[build-all] 临时构建目录: ${buildOutDir}`);
  console.log(`[build-all] 最终产物目录: ${distDir}\n`);

  cleanDist();
  patchNodePty();
  // 确保 aria2 二进制存在（按架构下载对应的二进制到 assets/aria2/）
  ensureAria2Binary('x64');
  ensureAria2Binary('arm64');
  cleanBuildOut();

  const tasks = [
    { arch: 'x64', tarot: true },
    { arch: 'x64', tarot: false },
    { arch: 'arm64', tarot: true },
    { arch: 'arm64', tarot: false },
  ];

  const results = [];
  for (const t of tasks) {
    try {
      await runBuild(t.arch, t.tarot);
      results.push({ ...t, ok: true });
    } catch (e) {
      console.error(`[build-all] 错误 (${t.arch} ${t.tarot ? 'tarot' : 'notarot'}): ${e.message}`);
      results.push({ ...t, ok: false, error: e.message });
      // 继续下一个，不中断
    }
  }

  // 确保 package.json 已恢复
  try { restorePkg(); } catch {}
  cleanupFlag();

  // 清理临时目录
  try {
    if (fs.existsSync(buildOutDir)) {
      fs.rmSync(buildOutDir, { recursive: true, force: true });
    }
  } catch {}

  // 列出最终产物
  console.log('\n[build-all] 打包结果:');
  for (const r of results) {
    const label = `${r.arch} ${r.tarot ? 'tarot' : 'notarot'}`;
    console.log(`  ${label}: ${r.ok ? '成功' : '失败 - ' + r.error}`);
  }

  console.log('\n[build-all] 最终产物:');
  if (fs.existsSync(distDir)) {
    const files = fs.readdirSync(distDir).filter(f => f.endsWith('.exe'));
    if (files.length === 0) {
      console.log('  (无)');
    } else {
      for (const f of files) {
        const stat = fs.statSync(path.join(distDir, f));
        console.log(`  ${f}  (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
      }
    }
  }
}

main();
