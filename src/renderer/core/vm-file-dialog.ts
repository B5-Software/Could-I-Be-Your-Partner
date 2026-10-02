/* SPDX-License-Identifier: GPL-3.0-or-later */
type PickerRequest = { id: string; config: { title: string } };
type PickerAPI = {
  onVMFileDialogOpen(callback: (request: PickerRequest) => void): () => void;
  onVMFileDialogClose(callback: (request: { id: string }) => void): () => void;
  vmFileDialogCancel(id: string): Promise<unknown>;
  vmFileDialogConfig(id: string): Promise<unknown>;
  vmFileDialogBrowse(id: string, directory: string): Promise<unknown>;
  vmFileDialogMkdir(id: string, directory: string): Promise<unknown>;
  vmFileDialogChoose(id: string, file: string, overwrite: boolean): Promise<unknown>;
};
declare global {
  interface Window {
    initializeVMFilePicker(
      container: HTMLElement,
      api: {
        config(): Promise<unknown>;
        browse(directory: string): Promise<unknown>;
        mkdir(directory: string): Promise<unknown>;
        choose(file: string, overwrite: boolean): Promise<unknown>;
        cancel(): Promise<unknown>;
      },
    ): Promise<void>;
  }
}
export function installVmFileDialog(api: PickerAPI): void {
  let current: { id: string; dialog: HTMLDialogElement; focus: HTMLElement | null } | null = null;
  api.onVMFileDialogClose(({ id }) => {
    if (current?.id !== id) return;
    const { dialog, focus } = current;
    current = null;
    dialog.close();
    dialog.remove();
    if (focus?.isConnected) focus.focus({ preventScroll: true });
  });
  api.onVMFileDialogOpen(({ id, config }) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'vm-file-dialog-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', config.title);
    const template = document.getElementById('vm-file-dialog-template') as HTMLTemplateElement;
    dialog.append(template.content.cloneNode(true));
    const content = dialog.querySelector<HTMLElement>('.vm-file-dialog-content')!;
    current = {
      id,
      dialog,
      focus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      void api.vmFileDialogCancel(id);
    });
    document.body.append(dialog);
    dialog.showModal();
    void window
      .initializeVMFilePicker(content, {
        config: () => api.vmFileDialogConfig(id),
        browse: (directory) => api.vmFileDialogBrowse(id, directory),
        mkdir: (directory) => api.vmFileDialogMkdir(id, directory),
        choose: (file, overwrite) => api.vmFileDialogChoose(id, file, overwrite),
        cancel: () => api.vmFileDialogCancel(id),
      })
      .catch((error) => {
        if (dialog.isConnected) content.querySelector('#status')!.textContent = error.message;
      });
  });
}
