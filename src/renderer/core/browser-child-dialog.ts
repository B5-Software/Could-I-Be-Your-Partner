/* SPDX-License-Identifier: GPL-3.0-or-later */
import { installVmFileDialog } from './vm-file-dialog';
document.addEventListener('DOMContentLoaded', () => {
  const api = (window as unknown as { api: Parameters<typeof installVmFileDialog>[0] }).api;
  installVmFileDialog(api);
});
