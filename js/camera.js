// Quick in-app camera (beta): shoot many photos without leaving the app.
// Android Chrome: ImageCapture.takePhoto() gives full sensor resolution. iOS/others: a frame of the video
// stream (up to what the browser offers, often 4K). The system camera stays available as a fallback.
// Photos are handed to the caller (photos.js queue) as File objects; this module never touches IndexedDB.

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}

function cameraError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Permiso de cámara denegado.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No se encontró una cámara.';
  if (n === 'NotReadableError') return 'La cámara está en uso por otra aplicación.';
  return 'No se pudo abrir la cámara rápida' + (e && e.message ? ` (${e.message})` : '') + '.';
}

async function grabFrame(video) {
  const w = video.videoWidth; const h = video.videoHeight;
  if (!w || !h) throw new Error('La cámara aún no está lista.');
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
  c.width = c.height = 0;
  if (!blob) throw new Error('No se pudo capturar la imagen.');
  return blob;
}

// Resolves when the user closes the camera. Throws (before showing anything) if the camera cannot open.
export async function openQuickCamera({ tag = null, onShot }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite la cámara dentro de la app.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } } });
  } catch (e) { throw new Error(cameraError(e)); }
  const track = stream.getVideoTracks()[0];
  const capture = typeof ImageCapture !== 'undefined' ? (() => { try { return new ImageCapture(track); } catch (_) { return null; } })() : null;
  let photoSize = null;
  if (capture?.getPhotoCapabilities) {
    try { const pc = await capture.getPhotoCapabilities(); if (pc?.imageWidth?.max) photoSize = { imageWidth: pc.imageWidth.max, imageHeight: pc.imageHeight.max }; } catch (_) { /* use defaults */ }
  }
  let caps = {};
  try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (_) { /* ignore */ }

  return new Promise((resolve) => {
    let mode = tag === 'placa' ? 'placa' : null;
    let shots = 0; let busy = false; let torchOn = false;
    const video = el('video', { class: 'qc-video', autoplay: '', playsinline: '', muted: '' });
    video.muted = true; video.srcObject = stream;
    const flash = el('div', { class: 'qc-flash' });
    const count = el('span', { class: 'qc-count', text: '0 fotos' });
    const msg = el('div', { class: 'qc-msg', role: 'status' });
    const done = el('button', { type: 'button', class: 'btn qc-done', text: 'Listo' });
    const torch = el('button', { type: 'button', class: 'btn qc-torch', text: '🔦', 'aria-label': 'Linterna' });
    torch.hidden = !caps.torch;
    const mFoto = el('button', { type: 'button', class: 'btn qc-mode', text: 'Foto' });
    const mPlaca = el('button', { type: 'button', class: 'btn qc-mode', text: '🔎 Placa' });
    const shutter = el('button', { type: 'button', class: 'qc-shutter', 'aria-label': 'Tomar foto' });
    const paintMode = () => { mFoto.classList.toggle('on', mode !== 'placa'); mPlaca.classList.toggle('on', mode === 'placa'); shutter.classList.toggle('placa', mode === 'placa'); };
    mFoto.onclick = () => { mode = null; paintMode(); };
    mPlaca.onclick = () => { mode = 'placa'; paintMode(); };
    const dlg = el('dialog', { class: 'qc', 'aria-label': 'Cámara rápida' },
      el('div', { class: 'qc-top' }, count, torch, done),
      el('div', { class: 'qc-stage' }, video, flash),
      msg,
      el('div', { class: 'qc-bottom' }, el('div', { class: 'qc-modes' }, mFoto, mPlaca), shutter));
    document.body.append(dlg);
    paintMode();

    const close = () => { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* ignore */ } if (dlg.open) dlg.close(); dlg.remove(); resolve(shots); };
    done.onclick = close;
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    torch.onclick = async () => {
      try { torchOn = !torchOn; await track.applyConstraints({ advanced: [{ torch: torchOn }] }); torch.classList.toggle('on', torchOn); } catch (_) { torch.hidden = true; }
    };
    shutter.onclick = async () => {
      if (busy) return;
      busy = true; shutter.disabled = true;
      flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
      try { navigator.vibrate?.(30); } catch (_) { /* ignore */ }
      try {
        let blob = null;
        if (capture) {
          try { blob = await capture.takePhoto(photoSize || undefined); } catch (_) {
            try { blob = await capture.takePhoto(); } catch (__) { blob = null; }
          }
        }
        if (!blob) blob = await grabFrame(video);
        const t = mode;
        onShot(new File([blob], `camara_${Date.now()}.jpg`, { type: blob.type || 'image/jpeg', lastModified: Date.now() }), t);
        shots++;
        count.textContent = `${shots} foto${shots === 1 ? '' : 's'}`;
        msg.textContent = '';
      } catch (e) {
        msg.textContent = 'No se pudo tomar la foto: ' + (e.message || e.name);
      } finally { busy = false; shutter.disabled = false; }
    };
    dlg.showModal();
    video.play().catch(() => {});
  });
}
