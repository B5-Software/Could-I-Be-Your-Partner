/**
 * 真机冒烟：附件入库 VM（ensureVmFile / copyFile）+ Code 模式外部目录挂载（mountExternalDir）
 *
 * 用法（在仓库根目录，需已装好镜像）：
 *   node vm-os/tests/attach-mount-smoke.js
 * 可选环境变量：
 *   CIBYP_ASSETS_DIR   资源目录（默认 D:/cibyp-vm-p0/assets）
 *   CIBYP_VARIANT      镜像变体（默认 base）
 *   CIBYP_IMAGE_VER    镜像版本（默认取本地最新）
 *   CIBYP_ATTACH_FILE  用于测试的宿主附件（默认 C:/Users/32109/Downloads/sfx_gift.mp3）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const { VmService } = require(path.join(APP_ROOT, 'src', 'main', 'vm', 'vm-service.js'));
const { VmFs } = require(path.join(APP_ROOT, 'src', 'main', 'vm', 'vm-fs.js'));

const ASSETS = process.env.CIBYP_ASSETS_DIR || 'D:/cibyp-vm-p0/assets';
const VARIANT = process.env.CIBYP_VARIANT || 'base';
const ATTACH = process.env.CIBYP_ATTACH_FILE || 'C:/Users/32109/Downloads/sfx_gift.mp3';
const USER_DATA = path.join(os.tmpdir(), 'cibyp-attach-mount-smoke');

let imageVersion = process.env.CIBYP_IMAGE_VER || null;
if (!imageVersion) {
  const dir = path.join(ASSETS, 'images', VARIANT);
  imageVersion = fs.existsSync(dir) ? fs.readdirSync(dir).sort().pop() : null;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

const settings = {
  runtime: {
    location: 'vm',
    workspaceMode: 'shared',
    vm: {
      variant: VARIANT,
      imageVersion,
      assetsDir: ASSETS,
      accel: 'auto',
      allowTcg: true,
      smp: 2,
      memMB: 3072,
      netMode: 'nat',
      shutdownOnExit: true,
    },
  },
};

const fakeApp = {
  getPath: (name) => (name === 'userData' ? USER_DATA : path.join(USER_DATA, name)),
  getAppPath: () => APP_ROOT,
  getVersion: () => '1.9.0-alpha.3',
  isPackaged: false,
};

(async () => {
  console.log(`[cfg] assets=${ASSETS} variant=${VARIANT} version=${imageVersion}`);
  console.log(`[cfg] attach=${ATTACH} exists=${fs.existsSync(ATTACH)}`);

  const vmService = new VmService({
    app: fakeApp,
    getSettings: () => settings,
    persistSettings: () => {},
    aria2: null,
  });
  vmService.on('serial', () => {});
  vmService.on('error', (e) => console.error('[vm error]', e && e.message));

  let inst = null;
  try {
    const st = vmService.localStatus ? vmService.localStatus() : null;
    if (st && !st.installed) { console.log('[skip] 本地未安装镜像:', JSON.stringify(st)); process.exit(2); }

    console.log('[vm] 启动虚拟机…');
    inst = await vmService.start();
    check('VM 启动就绪 state=ready', inst && inst.state === 'ready', `accel=${inst && inst.accel}`);

    const vmFs = new VmFs({ vmService });

    // ---------- 1) 附件：宿主下载目录文件 → VM ----------
    if (fs.existsSync(ATTACH)) {
      const hostBuf = fs.readFileSync(ATTACH);
      const vmPath = await vmFs.ensureVmFile(ATTACH);
      check('ensureVmFile 返回 VM 路径', /^\/workspace\/_uploads\//.test(String(vmPath)), String(vmPath));
      const back = await vmFs.readBuffer(vmPath);
      check('VM 内文件内容与宿主一致（sha256）', sha(back) === sha(hostBuf), `host=${sha(hostBuf)} vm=${sha(back)} size=${back.length}`);
    } else {
      check('附件存在（跳过测试）', false, '测试附件不存在: ' + ATTACH);
    }

    // ---------- 2) 幂等：VM 路径原样返回 ----------
    const idem = await vmFs.ensureVmFile('/workspace/_uploads/keep_me.txt');
    check('ensureVmFile 对 VM 路径幂等', idem === '/workspace/_uploads/keep_me.txt', idem);
    check('toVmPath 对 VM 路径幂等', vmService.toVmPath('/workspace/_uploads/keep_me.txt') === '/workspace/_uploads/keep_me.txt');

    // ---------- 3) 附件复制进工作区（渲染层 copyFile 流程） ----------
    if (fs.existsSync(ATTACH)) {
      const wsRoot = vmService.workspaceRoot || path.join(USER_DATA, 'Could-I-Be-Your-Partner');
      const destHost = path.join(wsRoot, '_attachments_test', path.basename(ATTACH));
      fs.mkdirSync(path.dirname(destHost), { recursive: true });
      const cp = await vmFs.copyFile(ATTACH, destHost);
      check('copyFile 宿主附件 → 工作区（VM 内）', cp && cp.ok, cp && cp.error);
      const destVm = vmService.toVmPath(destHost);
      check('工作区路径映射正确', /^\/workspace\/[^.]/.test(destVm) && !destVm.includes('..'), destVm);
      const destBuf = await vmFs.readBuffer(destVm);
      check('目标文件内容一致', sha(destBuf) === sha(fs.readFileSync(ATTACH)), `size=${destBuf.length}`);
    }

    // ---------- 4) Code 模式外部目录挂载 ----------
    const projDir = path.join(os.tmpdir(), 'cibyp-mount-test-' + Date.now());
    fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'src', 'a.txt'), 'hello-vm-mount');
    fs.writeFileSync(path.join(projDir, 'node_modules', 'skip.txt'), 'should-be-skipped');
    fs.writeFileSync(path.join(projDir, 'root.txt'), 'root-file');

    const mount = await vmService.mountExternalDir(projDir);
    check('mountExternalDir 成功', mount && mount.ok, JSON.stringify(mount));
    const mapped = vmService.toVmPath(path.join(projDir, 'src', 'a.txt'));
    check('外部目录映射到 /workspace/_external', mapped === `${mount.vmRoot}/src/a.txt`, mapped);
    const aBuf = await vmFs.readBuffer(mapped);
    check('外部目录文件已在 VM 内', aBuf.toString('utf8') === 'hello-vm-mount', aBuf.toString('utf8'));
    const backHost = vmService.toHostPath(`${mount.vmRoot}/root.txt`);
    check('反向映射 VM → 宿主', backHost === path.join(projDir, 'root.txt'), String(backHost));
    const ls = await vmFs.exec(`ls ${JSON.stringify(mount.vmRoot)} | tr '\\n' ' '`);
    check('跳过 node_modules', ls && !ls.stdout.includes('node_modules'), ls && ls.stdout.trim());
    check('顶层文件已同步', ls && ls.stdout.includes('root.txt') && ls.stdout.includes('src'), ls && ls.stdout.trim());

    fs.rmSync(projDir, { recursive: true, force: true });
  } catch (e) {
    check('冒烟执行未抛异常', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    try { if (vmService.instance) await vmService.instance.stop({ timeoutMs: 15000 }); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})();
