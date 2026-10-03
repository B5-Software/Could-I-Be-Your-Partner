/*
 * 在真实 PTY 下探测 Electron 主进程的 TTY 判定（stdin/stdout/stderr.isTTY）。
 * 用法：node scripts/pty-probe.cjs
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const root = path.resolve(__dirname, '..');
const probeFile = path.join(os.tmpdir(), 'cibyp-tty-probe.js');
fs.writeFileSync(
  probeFile,
  `const info = {
  argv: process.argv.slice(1),
  stdinTTY: Boolean(process.stdin.isTTY),
  stdoutTTY: Boolean(process.stdout.isTTY),
  stderrTTY: Boolean(process.stderr.isTTY),
  stdinSetRaw: typeof process.stdin.setRawMode,
  columns: process.stdout.columns || null,
  rows: process.stdout.rows || null,
};
console.log('PROBE ' + JSON.stringify(info));
let got = [];
try {
  process.stdin.on('data', (d) => {
    got.push(String(d));
    console.log('STDIN-DATA ' + JSON.stringify(String(d)));
  });
  process.stdin.resume();
} catch (e) {
  console.log('STDIN-ERROR ' + e.message);
}
setTimeout(() => {
  console.log('STDIN-SUMMARY ' + JSON.stringify(got));
  process.exit(0);
}, 3000);`,
);

const electron = require(path.join(root, 'node_modules', 'electron'));
// 纯 Node（控制台程序）可直接 spawn；Electron 是 GUI 程序，需 cmd /c 托管控制台
const useNode = process.env.PTY_TARGET === 'node';
const command = useNode
  ? null
  : `${electron} ${probeFile}`; // 路径无空格，避免 node-pty 二次加引号

const ptyProcess = useNode
  ? pty.spawn(process.execPath, [probeFile], {
      name: 'xterm-color',
      cols: 100,
      rows: 30,
      cwd: root,
      env: process.env,
    })
  : pty.spawn('cmd.exe', ['/d', '/s', '/c', command], {
      name: 'xterm-color',
      cols: 100,
      rows: 30,
      cwd: root,
      env: process.env,
    });

let out = '';
ptyProcess.onData((data) => {
  out += data;
});
// 1.5s 后向 PTY 写入按键，验证 Electron 主进程 stdin 是否能收到
setTimeout(() => {
  try {
    ptyProcess.write('hello\n');
  } catch {
    /* ignore */
  }
}, 1500);
ptyProcess.onExit(({ exitCode }) => {
  console.log('--- raw output ---');
  console.log(out.replace(/\r/g, ''));
  console.log('--- exit', exitCode, '---');
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  try {
    console.log('parsed:', JSON.stringify(JSON.parse(json), null, 1));
  } catch (e) {
    console.log('no json parsed');
  }
  process.exit(0);
});

setTimeout(() => {
  console.log('TIMEOUT');
  console.log(out.replace(/\r/g, ''));
  ptyProcess.kill();
  process.exit(1);
}, 40000);
