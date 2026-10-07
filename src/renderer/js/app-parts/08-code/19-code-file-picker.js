  // ---- Code 模式文件选择按钮 ----
  document.getElementById('btn-code-attach-file')?.addEventListener('click', async () => {
    try {
      const result = await chooseAttachmentFiles(document.getElementById('btn-code-attach-file'), { multiple: true, title: '添加文件到上下文' });
      if (result.ok && result.paths) {
        for (const p of result.paths) {
          const name = result.files?.find(file => file.path === p)?.name || p.split(/[\\/]/).pop();
          await addFileToCodeContext({ path: p, name: name, type: 'file' });
        }
      }
    } catch (error) { showToast(error.message, 'error'); }
  });

  // WebUI 上传文件后通知 Code 模式刷新附件（与 Chat 模式的 onWebControlFileUploaded 对齐）
  if (typeof window.api?.onWebControlFileUploaded === 'function') {
    window.api.onWebControlFileUploaded(async (data) => {
      if (data && data.path && document.getElementById('page-code')?.classList.contains('active')) {
        try { await addFileToCodeContext({ path: data.path, name: data.name, type: 'file' }); }
        catch (error) { showToast(error.message, 'error'); }
      }
    });
  }
