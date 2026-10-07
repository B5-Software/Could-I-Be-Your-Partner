  // One camera controller for GUI and WebUI, using the viewing device.
  const cameraVideo = document.getElementById('camera-video');
  const cameraPhoto = document.getElementById('camera-photo');
  const cameraCanvas = document.getElementById('camera-canvas');
  const cameraDevice = document.getElementById('camera-device');
  const cameraStatus = document.getElementById('camera-status');
  const captureButton = document.getElementById('btn-capture-photo');
  const usePhotoButton = document.getElementById('btn-use-photo');
  const retakeButton = document.getElementById('btn-retake-photo');
  const switchCameraButton = document.getElementById('btn-switch-camera');
  let cameraGeneration = 0, cameraMode = 'chat', photoData = '', cameraFocus;
  function stopCameraStream() {
    cameraVideo.srcObject?.getTracks().forEach(track => track.stop());
    cameraVideo.srcObject = null;
  }
  function cameraPreview(preview) {
    cameraPhoto.hidden = !preview; cameraVideo.hidden = preview;
    usePhotoButton.hidden = retakeButton.hidden = !preview;
    captureButton.hidden = preview;
    cameraDevice.disabled = switchCameraButton.disabled = preview;
  }
  async function startCamera(deviceId) {
    const generation = ++cameraGeneration;
    stopCameraStream(); photoData = ''; cameraPhoto.removeAttribute('src'); cameraPreview(false);
    captureButton.disabled = true; cameraDevice.disabled = switchCameraButton.disabled = true;
    cameraStatus.hidden = false; cameraStatus.textContent = t('ui.camera.starting', '正在连接摄像头…');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('ui.camera.secure', '摄像头需要 HTTPS 或 localhost 访问，请先使用安全连接。'));
      const stream = await navigator.mediaDevices.getUserMedia({ audio:false, video: deviceId ? { deviceId: { exact: deviceId }, width:{ideal:1920},height:{ideal:1080} } : { facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080} } });
      if (generation !== cameraGeneration || cameraModal.classList.contains('hidden')) { stream.getTracks().forEach(track=>track.stop()); return; }
      cameraVideo.srcObject = stream; await cameraVideo.play();
      if (generation !== cameraGeneration) return;
      const track = stream.getVideoTracks()[0], current = track.getSettings();
      cameraVideo.style.transform = current.facingMode === 'user' ? 'scaleX(-1)' : '';
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='videoinput');
      if (generation !== cameraGeneration) return;
      cameraDevice.replaceChildren(...devices.map((device,index)=>{const option=document.createElement('option');option.value=device.deviceId;option.textContent=device.label||t('ui.camera.device','摄像头')+' '+(index+1);return option;}));
      cameraDevice.value = current.deviceId || deviceId || cameraDevice.options[0]?.value || '';
      document.getElementById('camera-resolution').textContent = cameraVideo.videoWidth + ' × ' + cameraVideo.videoHeight;
      cameraStatus.hidden = true; captureButton.disabled = !cameraVideo.videoWidth;
      cameraDevice.disabled = false; switchCameraButton.disabled = devices.length < 2;
      captureButton.focus();
    } catch (error) {
      if (generation !== cameraGeneration) return;
      stopCameraStream(); cameraStatus.hidden = false;
      cameraStatus.textContent = error.name === 'NotAllowedError' ? t('ui.camera.denied','未获得摄像头权限。请在浏览器或系统设置中允许访问后重试。') : error.name === 'NotFoundError' ? t('ui.camera.missing','没有找到可用的摄像头。') : error.message;
      retakeButton.hidden = false; retakeButton.textContent = t('ui.camera.retry','重试');
    }
  }
  for (const [id,mode] of [['btn-camera','chat'],['btn-code-camera','code'],['btn-babe-camera','babe']]) {
    document.getElementById(id)?.addEventListener('click',()=>{
      cameraMode=mode; cameraFocus=document.activeElement; cameraModal.classList.remove('hidden');
      retakeButton.textContent=t('ui.camera.retake','重拍'); void startCamera();
    });
  }
  cameraDevice.addEventListener('change',()=>void startCamera(cameraDevice.value));
  switchCameraButton.addEventListener('click',()=>{
    const options=[...cameraDevice.options], index=options.findIndex(option=>option.value===cameraDevice.value);
    if(options.length>1)void startCamera(options[(index+1)%options.length].value);
  });
  retakeButton.addEventListener('click',()=>{retakeButton.textContent=t('ui.camera.retake','重拍');void startCamera(cameraDevice.value);});
  captureButton.addEventListener('click',()=>{
    if(!cameraVideo.videoWidth||!cameraVideo.srcObject)return;
    cameraCanvas.width=cameraVideo.videoWidth;cameraCanvas.height=cameraVideo.videoHeight;
    cameraCanvas.getContext('2d').drawImage(cameraVideo,0,0);
    photoData=cameraCanvas.toDataURL('image/jpeg',.92);cameraPhoto.src=photoData;
    stopCameraStream();cameraPreview(true);usePhotoButton.focus();
  });
  usePhotoButton.addEventListener('click',async()=>{
    if(!photoData||usePhotoButton.disabled)return;
    usePhotoButton.disabled=true;
    const generation=cameraGeneration, mode=cameraMode;
    try {
      const bytes=await(await fetch(photoData)).arrayBuffer(),name=`camera-${Date.now()}.jpg`;
      const result=await window.api.saveUploadedFile(name,bytes);
      if(!result.ok)throw new Error(result.error||'Photo upload failed');
      if(generation!==cameraGeneration)return;
      const file={name,path:result.path,isImage:true,size:bytes.byteLength,type:'image/jpeg'};
      if(mode==='code')await addFileToCodeContext({...file,type:'file'});
      else if(mode==='babe'){babeAttachments.push(file);renderBabeAttachments();}
      else{currentAttachments.push(file);renderAttachments();}
      closeCameraModal();
    }catch(error){showToast(error.message,'error');}finally{usePhotoButton.disabled=false;}
  });
  document.getElementById('btn-close-camera').addEventListener('click',closeCameraModal);
  document.getElementById('btn-cancel-camera').addEventListener('click',closeCameraModal);
  bindBackdropClose(cameraModal,closeCameraModal);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!cameraModal.classList.contains('hidden')){event.preventDefault();closeCameraModal();}});
  navigator.mediaDevices?.addEventListener('devicechange',()=>{if(!cameraModal.classList.contains('hidden')&&!photoData)void startCamera();});
  window.addEventListener('pagehide',()=>{++cameraGeneration;stopCameraStream();});
  function closeCameraModal(){++cameraGeneration;stopCameraStream();photoData='';cameraPhoto.removeAttribute('src');fadeOutHide(cameraModal);cameraFocus?.focus();}

  // ---- Image Preview Modal ----
  document.getElementById('btn-close-image-modal')?.addEventListener('click', () => {
    fadeOutHide(imagePreviewModal);
  });
  if (imagePreviewModal && typeof bindBackdropClose === 'function') {
    bindBackdropClose(imagePreviewModal, () => fadeOutHide(imagePreviewModal));
  }
