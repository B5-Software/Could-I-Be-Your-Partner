/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

// WHPX cannot migrate CPU/memory state. Linux swsusp saves and restores that
// state inside the guest instead, retaining hardware acceleration on Windows.
const PREPARE = String.raw`
import os, stat, json, struct, fcntl, subprocess, shutil, pathlib
if 'disk' not in pathlib.Path('/sys/power/state').read_text().split():
    raise RuntimeError('This VM kernel does not support hibernation')
kind = subprocess.check_output(['findmnt','-n','-o','FSTYPE','/'], text=True).strip()
device = subprocess.check_output(['findmnt','-n','-o','SOURCE','/'], text=True).strip()
if kind != 'ext4' or not device.startswith('/dev/') or any(c not in '/-_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' for c in device):
    raise RuntimeError('VM hibernation requires a local ext4 root disk')
root = pathlib.Path('/var/lib/cibyp-quick-resume')
root.mkdir(mode=0o700, exist_ok=True)
if root.is_symlink() or root.stat().st_uid != 0:
    raise RuntimeError('Unsafe VM hibernation directory')
file = root/'memory.swap'
page = os.sysconf('SC_PAGE_SIZE')
size = (os.sysconf('SC_PHYS_PAGES') * page + 256*1024*1024 + page-1)//page*page
active = [line.split()[0] for line in pathlib.Path('/proc/swaps').read_text().splitlines()[1:]]
exists = file.exists()
if exists and (file.is_symlink() or not stat.S_ISREG(file.stat().st_mode) or file.stat().st_uid != 0):
    raise RuntimeError('Unsafe VM hibernation swap file')
if exists and file.stat().st_size != size:
    if str(file) in active: subprocess.run(['swapoff',str(file)], check=True)
    file.unlink()
    exists = False
if not exists:
    if shutil.disk_usage(root).free < size + 128*1024*1024:
        raise RuntimeError('Not enough VM disk space to save memory')
    fd = os.open(file, os.O_CREAT|os.O_EXCL|os.O_RDWR, 0o600)
    try: os.posix_fallocate(fd, 0, size)
    finally: os.close(fd)
    subprocess.run(['mkswap',str(file)], stdout=subprocess.DEVNULL, check=True)
if str(file) not in active: subprocess.run(['swapon',str(file)], check=True)
with file.open('rb') as stream:
    buf = bytearray(88)
    struct.pack_into('=QQIIII',buf,0,0,2**64-1,1,0,1,0)
    fcntl.ioctl(stream.fileno(),0xC020660B,buf,True)
    if struct.unpack_from('=I',buf,20)[0] < 1: raise RuntimeError('Cannot locate VM swap header')
    logical, physical, length = struct.unpack_from('=QQQ',buf,32)
    if logical or physical % page or length < page: raise RuntimeError('Invalid VM swap header offset')
offset = physical//page
dev = os.stat('/').st_dev
pathlib.Path('/sys/power/resume').write_text(str(os.major(dev))+':'+str(os.minor(dev)))
pathlib.Path('/sys/power/resume_offset').write_text(str(offset))
pathlib.Path('/sys/power/disk').write_text('shutdown')
print(json.dumps({'device':device,'offset':offset,'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()}))
`;

async function prepareHibernate(ssh) {
  const script = Buffer.from(PREPARE).toString('base64');
  const result = await ssh.exec(
    `sudo python3 -c 'import base64; exec(base64.b64decode("${script}"))'`,
    { timeoutMs: 90000 },
  );
  if (!result.ok)
    throw new Error(
      result.stderr?.trim().split('\n').at(-1) || 'VM hibernation preparation failed',
    );
  const state = JSON.parse(result.stdout.trim());
  if (
    !/^\/dev\/[a-zA-Z0-9/_-]+$/.test(state.device) ||
    !Number.isSafeInteger(state.offset) ||
    state.offset < 1 ||
    !/^[a-f0-9-]{36}$/.test(state.bootId)
  )
    throw new Error('VM returned invalid hibernation metadata');
  return state;
}

module.exports = { prepareHibernate };
