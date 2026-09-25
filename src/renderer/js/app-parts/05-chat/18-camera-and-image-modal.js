  // ---- Camera Modal ----
  if (btnCamera) {
    btnCamera.addEventListener('click', async () => {
      cameraModal.classList.remove('hidden');
      const video = document.getElementById('camera-video');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        video.play();
      } catch (e) {
        console.error('Camera error:', e);
        fadeOutHide(cameraModal);
      }
    });
  }

  document.getElementById('btn-close-camera')?.addEventListener('click', () => {
    closeCameraModal();
  });

  document.getElementById('btn-cancel-camera')?.addEventListener('click', () => {
    closeCameraModal();
  });

  document.getElementById('btn-capture-photo')?.addEventListener('click', async () => {
    const video = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const response = await fetch(dataUrl);
    const arrayBuffer = await response.arrayBuffer();
    const name = `camera-${Date.now()}.png`;
    const result = await window.api.saveUploadedFile(name, arrayBuffer);
    if (result.ok) {
      currentAttachments.push({ name, path: result.path, isImage: true });
      renderAttachments();
    }
    closeCameraModal();
  });

  function closeCameraModal() {
    const video = document.getElementById('camera-video');
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    }
    fadeOutHide(cameraModal);
  }

  // ---- Image Preview Modal ----
  document.getElementById('btn-close-image-modal')?.addEventListener('click', () => {
    fadeOutHide(imagePreviewModal);
  });
  if (imagePreviewModal && typeof bindBackdropClose === 'function') {
    bindBackdropClose(imagePreviewModal, () => fadeOutHide(imagePreviewModal));
  }
