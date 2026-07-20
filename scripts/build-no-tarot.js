/**
 * build --no-tarot 打包脚本
 *
 * 用法：
 *   node scripts/build-no-tarot.js                # 默认平台打包
 *   node scripts/build-no-tarot.js --win          # 仅打包 Windows
 *   node scripts/build-no-tarot.js --mac          # 仅打包 macOS
 *   node scripts/build-no-tarot.js --linux        # 仅打包 Linux
 *
 * 行为：
 *   1. 在项目根目录写入 `.no-tarot` 标志文件（应用启动时检测此文件存在则屏蔽塔罗牌元素）
 *   2. 调用 electron-builder，并转发所有命令行参数
 *   3. 无论构建成功失败，都删除 `.no-tarot` 标志文件
 *
 * 注意：`package.json` 的 `build.files` 已包含 `.no-tarot`，会被打包到最终产物中。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const flagFile = path.join(projectRoot, '.no-tarot');

// 转发命令行参数（去掉 node 和脚本路径）
const extraArgs = process.argv.slice(2);
const ebArgs = extraArgs.length > 0 ? extraArgs : [];

// 1. 写入 .no-tarot 标志文件
try {
  fs.writeFileSync(flagFile, 'no-tarot\n', 'utf8');
  console.log('[build-no-tarot] 已创建 .no-tarot 标志文件');
} catch (e) {
  console.error('[build-no-tarot] 创建 .no-tarot 标志文件失败:', e.message);
  process.exit(1);
}

// 2. 调用 electron-builder
const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['electron-builder', ...ebArgs];
console.log(`[build-no-tarot] 执行: ${cmd} ${args.join(' ')}`);

const child = spawn(cmd, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: false
});

child.on('error', (err) => {
  console.error('[build-no-tarot] 启动 electron-builder 失败:', err.message);
  cleanupAndExit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[build-no-tarot] electron-builder 被信号 ${signal} 终止`);
    cleanupAndExit(1);
  } else if (code !== 0) {
    console.error(`[build-no-tarot] electron-builder 退出码: ${code}`);
    cleanupAndExit(code);
  } else {
    console.log('[build-no-tarot] 打包完成');
    cleanupAndExit(0);
  }
});

function cleanupAndExit(code) {
  // 3. 删除 .no-tarot 标志文件（无论成功失败）
  try {
    if (fs.existsSync(flagFile)) {
      fs.unlinkSync(flagFile);
      console.log('[build-no-tarot] 已删除 .no-tarot 标志文件');
    }
  } catch (e) {
    console.warn('[build-no-tarot] 删除 .no-tarot 标志文件失败:', e.message);
  }
  process.exit(code);
}
