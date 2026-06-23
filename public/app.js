'use strict';

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  cameras: [], // [{ id, name }]
};

/** hls.js instances keyed by camera id */
const hlsMap = new Map();
/** reconnect state keyed by camera id */
const reconnectState = new Map();
/** map of runtime camera id -> persisted config key */
const cameraConfigKeyById = new Map();

const STORAGE_CAMERAS_KEY = 'ipcam.saved-cameras.v1';
const STORAGE_POWER_KEY = 'ipcam.power-settings.v1';

const audioMonitor = {
  enabled: false,
  threshold: 18,
  blackout: false,
  peak: 0,
  peakUpdatedAt: 0,
  context: null,
  intervalId: null,
  nodes: new Map(), // cameraId -> { source, analyser, gain, dataArray, audible }
};

let mediaUnlocked = false;

// ── Utilities ─────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function sanitizeCameraConfig(data) {
  return {
    name: String(data.name || data.ip || '').trim().slice(0, 100),
    ip: String(data.ip || '').trim().slice(0, 253),
    login: String(data.login || '').trim().slice(0, 100),
    password: String(data.password || ''),
    port: String(data.port || '554').trim() || '554',
    path: String(data.path || '/onvif1').trim() || '/onvif1',
  };
}

function cameraConfigFingerprint(cfg) {
  return `${cfg.ip}|${cfg.login}|${cfg.port}|${cfg.path}`;
}

function getStoredCameraConfigs() {
  const list = loadJSON(STORAGE_CAMERAS_KEY, []);
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const config = sanitizeCameraConfig(item);
      if (!config.ip || !config.login || !config.password) return null;
      return {
        key: String(item.key || cameraConfigFingerprint(config)),
        ...config,
      };
    })
    .filter(Boolean);
}

function saveStoredCameraConfigs(list) {
  saveJSON(STORAGE_CAMERAS_KEY, list);
}

function upsertStoredCameraConfig(data) {
  const cfg = sanitizeCameraConfig(data);
  if (!cfg.ip || !cfg.login || !cfg.password) return null;

  const list = getStoredCameraConfigs();
  const fingerprint = cameraConfigFingerprint(cfg);
  const idx = list.findIndex((item) => cameraConfigFingerprint(item) === fingerprint);
  const key = idx >= 0 ? list[idx].key : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const entry = { key, ...cfg };

  if (idx >= 0) list[idx] = entry;
  else list.push(entry);

  saveStoredCameraConfigs(list);
  return key;
}

function removeStoredCameraConfigByKey(configKey) {
  if (!configKey) return;
  const list = getStoredCameraConfigs();
  const next = list.filter((item) => item.key !== configKey);
  if (next.length !== list.length) saveStoredCameraConfigs(next);
}

function loadPowerSettings() {
  const saved = loadJSON(STORAGE_POWER_KEY, {});
  return {
    enabled: !!saved.enabled,
    threshold: Number.isFinite(Number(saved.threshold)) ? Number(saved.threshold) : 18,
  };
}

function savePowerSettings() {
  saveJSON(STORAGE_POWER_KEY, {
    enabled: audioMonitor.enabled,
    threshold: audioMonitor.threshold,
  });
}

function setReconnectTimer(cameraId, timerId) {
  const meta = reconnectState.get(cameraId) || { retries: 0, timerId: null };
  if (meta.timerId) clearTimeout(meta.timerId);
  meta.timerId = timerId;
  reconnectState.set(cameraId, meta);
}

function clearReconnectTimer(cameraId) {
  const meta = reconnectState.get(cameraId);
  if (meta && meta.timerId) {
    clearTimeout(meta.timerId);
    meta.timerId = null;
  }
}

function resetReconnect(cameraId) {
  clearReconnectTimer(cameraId);
  reconnectState.set(cameraId, { retries: 0, timerId: null });
}

function incReconnect(cameraId) {
  const meta = reconnectState.get(cameraId) || { retries: 0, timerId: null };
  meta.retries += 1;
  reconnectState.set(cameraId, meta);
  return meta.retries;
}

function isCameraStillPresent(cameraId) {
  return !!state.cameras.find((c) => c.id === cameraId);
}

async function waitForPlaylist(cameraId, timeoutMs = 25000, pollMs = 700) {
  const startedAt = Date.now();
  const src = `/hls/${cameraId}/stream.m3u8`;

  while (Date.now() - startedAt < timeoutMs) {
    if (!isCameraStillPresent(cameraId)) return false;

    try {
      const res = await fetch(src, { cache: 'no-store' });
      if (res.ok) {
        const text = await res.text();
        if (text.includes('#EXTM3U')) return true;
      }
    } catch {
      // Keep polling until timeout.
    }
    await sleep(pollMs);
  }

  return false;
}

function ensureAudioContext() {
  if (audioMonitor.context) return audioMonitor.context;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;

  const ctx = new AudioContextCtor();
  audioMonitor.context = ctx;
  return ctx;
}

async function resumeAudioContextIfNeeded() {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      // User gesture may be needed.
    }
  }
}

function setupAudioContextAutoResume() {
  const wake = () => {
    resumeAudioContextIfNeeded();
    unlockMediaPlayback();
  };
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('keydown', wake, { passive: true });
}

function unlockMediaPlayback() {
  if (mediaUnlocked) return;
  mediaUnlocked = true;

  document.querySelectorAll('.tile video').forEach((video) => {
    video.muted = false;
    video.play().catch(() => {});
  });
}

function ensureAudioNode(cameraId, video) {
  const ctx = ensureAudioContext();
  if (!ctx || audioMonitor.nodes.has(cameraId)) return;

  try {
    const source = ctx.createMediaElementSource(video);
    const analyser = ctx.createAnalyser();
    const gain = ctx.createGain();
    analyser.fftSize = 256;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0;

    audioMonitor.nodes.set(cameraId, { source, analyser, gain, dataArray, audible: false });
  } catch {
    // Some browsers may refuse duplicate media element source or blocked context.
  }
}

function setCameraAudible(cameraId, audible) {
  const node = audioMonitor.nodes.get(cameraId);
  if (!node || !audioMonitor.context) return false;
  const target = audible ? 1 : 0;
  node.audible = !!audible;
  node.gain.gain.setTargetAtTime(target, audioMonitor.context.currentTime, 0.03);
  return true;
}

function removeAudioNode(cameraId) {
  const node = audioMonitor.nodes.get(cameraId);
  if (!node) return;
  try {
    node.source.disconnect();
  } catch {}
  try {
    node.analyser.disconnect();
  } catch {}
  try {
    node.gain.disconnect();
  } catch {}
  audioMonitor.nodes.delete(cameraId);
}

function getCurrentAudioLevelPercent() {
  let maxLevel = 0;

  for (const node of audioMonitor.nodes.values()) {
    node.analyser.getByteTimeDomainData(node.dataArray);
    let sum = 0;
    for (let i = 0; i < node.dataArray.length; i++) {
      const centered = (node.dataArray[i] - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / node.dataArray.length);
    const level = Math.min(100, Math.round(rms * 260));
    if (level > maxLevel) maxLevel = level;
  }

  return maxLevel;
}

function setBlackout(active) {
  const overlay = document.getElementById('blackout-overlay');
  const btn = document.getElementById('blackout-btn');
  audioMonitor.blackout = !!active;
  overlay.hidden = !audioMonitor.blackout;
  btn.textContent = audioMonitor.blackout ? 'Desativar Tela Preta' : 'Ativar Tela Preta';
}

function ensureAudioWatchLoop() {
  if (audioMonitor.intervalId) return;
  audioMonitor.intervalId = setInterval(() => {
    const level = getCurrentAudioLevelPercent();
    const now = Date.now();

    if (level >= audioMonitor.peak) {
      audioMonitor.peak = level;
      audioMonitor.peakUpdatedAt = now;
    } else if (now - audioMonitor.peakUpdatedAt > 1200) {
      audioMonitor.peak = Math.max(level, audioMonitor.peak - 1);
      audioMonitor.peakUpdatedAt = now;
    }

    updateNoiseUI(level, audioMonitor.peak);

    if (audioMonitor.enabled && audioMonitor.blackout && level >= audioMonitor.threshold) {
      setBlackout(false);
      toast(`Audio detectado (${level}%)`, 'success');
    }
  }, 300);
}

function updateNoiseUI(level, peak = 0) {
  const sidebarFill = document.getElementById('noise-level-fill');
  const sidebarText = document.getElementById('noise-level-text');
  const sidebarPeakText = document.getElementById('noise-peak-text');
  const overlayFill = document.getElementById('noise-level-fill-overlay');
  const overlayText = document.getElementById('noise-level-text-overlay');
  const overlayPeakText = document.getElementById('noise-peak-text-overlay');

  if (sidebarFill) sidebarFill.style.width = `${level}%`;
  if (overlayFill) overlayFill.style.width = `${level}%`;
  if (sidebarText) sidebarText.textContent = `${level}%`;
  if (overlayText) overlayText.textContent = `${level}%`;
  if (sidebarPeakText) sidebarPeakText.textContent = `${peak}%`;
  if (overlayPeakText) overlayPeakText.textContent = `${peak}%`;
}

// ── Grid layout ───────────────────────────────────────────────────────────

/**
 * Compute an optimal grid (cols × rows) for `n` tiles so each cell is as
 * close to a 16:9 ratio as possible given the current window size.
 */
function gridLayout(n) {
  if (n <= 0) return { cols: 1, rows: 1 };
  const W = window.innerWidth - 290; // subtract sidebar approx
  const H = window.innerHeight;
  let bestCols = 1, bestScore = Infinity;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const tileW = W / c;
    const tileH = H / r;
    const ratio = tileW / tileH;
    const score = Math.abs(ratio - 16 / 9);
    if (score < bestScore) { bestScore = score; bestCols = c; }
  }
  return { cols: bestCols, rows: Math.ceil(n / bestCols) };
}

// ── HLS player management ─────────────────────────────────────────────────

function initPlayer(cameraId, video) {
  const src = `/hls/${cameraId}/stream.m3u8`;

  // Tear down any prior instance
  if (hlsMap.has(cameraId)) {
    hlsMap.get(cameraId).destroy();
    hlsMap.delete(cameraId);
  }

  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    const hls = new Hls({
      enableWorker:    true,
      lowLatencyMode:  true,
      backBufferLength: 0,
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    hlsMap.set(cameraId, hls);
    return hls;
  }

  // Native HLS (Safari)
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
  }
  return null;
}

function destroyPlayer(cameraId) {
  clearReconnectTimer(cameraId);
  removeAudioNode(cameraId);
  if (hlsMap.has(cameraId)) {
    hlsMap.get(cameraId).destroy();
    hlsMap.delete(cameraId);
  }
}

// ── Camera tile ───────────────────────────────────────────────────────────

function showLoading(tile) {
  const ld = tile.querySelector('.tile-loading');
  const er = tile.querySelector('.tile-error');
  if (ld) ld.style.display = 'flex';
  if (er) er.remove();
}

function hideLoading(tile) {
  const ld = tile.querySelector('.tile-loading');
  if (ld) ld.style.display = 'none';
}

function showError(tile, video, camera, detail) {
  hideLoading(tile);
  const existing = tile.querySelector('.tile-error');
  if (existing) existing.remove();

  const er = document.createElement('div');
  er.className = 'tile-error';
  er.innerHTML = `
    <div class="err-icon">⚠️</div>
    <p>Falha na conexão</p>
    <small>${esc(detail || '')}</small>
    <button class="retry-btn">Reconectar</button>
  `;
  er.querySelector('.retry-btn').addEventListener('click', () => {
    er.remove();
    showLoading(tile);
    startTileStream(camera, tile, video);
  });
  // Insert before the bar overlay
  tile.insertBefore(er, tile.querySelector('.tile-bar'));
}

function scheduleReconnect(camera, tile, video, reason) {
  if (!isCameraStillPresent(camera.id)) return;

  const tries = incReconnect(camera.id);
  const delay = Math.min(12000, 1000 * Math.pow(2, Math.min(tries, 4)));
  showLoading(tile);

  setReconnectTimer(camera.id, setTimeout(() => {
    if (!isCameraStillPresent(camera.id)) return;
    startTileStream(camera, tile, video);
  }, delay));

  if (tries === 1) {
    toast(`Reconectando ${camera.name}… ${reason ? `(${reason})` : ''}`, 'error');
  }
}

async function attachHls(camera, tile, video) {
  const ready = await waitForPlaylist(camera.id);
  if (!ready) {
    if (isCameraStillPresent(camera.id)) {
      showError(tile, video, camera, 'Timeout aguardando stream HLS');
      scheduleReconnect(camera, tile, video, 'timeout');
    }
    return;
  }

  const hls = initPlayer(camera.id, video);

  if (hls) {
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      resetReconnect(camera.id);
      hideLoading(tile);
      video.play().catch(() => { /* autoplay blocked — user must unmute */ });
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;

      destroyPlayer(camera.id);
      showError(tile, video, camera, data.details);

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR || data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        scheduleReconnect(camera, tile, video, data.details || data.type);
      }
    });
  } else {
    // Safari native path
    video.addEventListener('loadedmetadata', () => {
      resetReconnect(camera.id);
      hideLoading(tile);
      video.play().catch(() => {});
    }, { once: true });
    video.addEventListener('error', () => {
      showError(tile, video, camera, 'Erro de stream');
      scheduleReconnect(camera, tile, video, 'native error');
    }, { once: true });
  }
}

function startTileStream(camera, tile, video) {
  if (!isCameraStillPresent(camera.id)) return;
  attachHls(camera, tile, video).catch((err) => {
    showError(tile, video, camera, err?.message || 'Erro inesperado');
    scheduleReconnect(camera, tile, video, 'erro inesperado');
  });
}

async function reconnectCamera(id) {
  const camera = state.cameras.find((c) => c.id === id);
  if (!camera) return;

  const tile = document.querySelector(`.tile[data-id="${id}"]`);
  const video = tile ? tile.querySelector('video') : null;

  try {
    await apiFetch('POST', `/api/cameras/${id}/reconnect`);
    resetReconnect(id);
    destroyPlayer(id);
    if (tile && video) {
      showLoading(tile);
      startTileStream(camera, tile, video);
    }
    toast(`Reconectando ${camera.name}...`);
  } catch (err) {
    toast(`Falha ao reconectar: ${err.message}`, 'error');
  }
}

function createTile(camera) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = camera.id;

  tile.innerHTML = `
    <video autoplay muted playsinline></video>
    <div class="tile-loading"><div class="spinner"></div><p>Conectando…</p></div>
    <div class="tile-bar">
      <span class="tile-name">${esc(camera.name)}</span>
      <button class="tile-btn btn-reconnect" title="Reconectar">↻</button>
      <button class="tile-btn btn-mute" title="Som">🔇</button>
      <button class="tile-btn btn-fs"   title="Tela cheia">⛶</button>
    </div>
  `;

  const video   = tile.querySelector('video');
  const btnReconnect = tile.querySelector('.btn-reconnect');
  const btnMute = tile.querySelector('.btn-mute');
  const btnFs   = tile.querySelector('.btn-fs');

  // Start muted to satisfy autoplay policy; first user gesture will unlock playback.
  video.volume = 1;
  video.muted = true;
  btnReconnect.addEventListener('click', () => {
    reconnectCamera(camera.id);
  });


  video.addEventListener('canplay', () => {
    ensureAudioNode(camera.id, video);
    setCameraAudible(camera.id, false);
    if (mediaUnlocked) {
      video.muted = false;
      video.play().catch(() => {});
    }
  });

  // Mute toggle
  btnMute.addEventListener('click', () => {
    resumeAudioContextIfNeeded();
    unlockMediaPlayback();

    const node = audioMonitor.nodes.get(camera.id);
    if (node) {
      const nextAudible = !node.audible;
      setCameraAudible(camera.id, nextAudible);
      btnMute.textContent = nextAudible ? '🔊' : '🔇';
      btnMute.title = nextAudible ? 'Silenciar' : 'Ativar som';
      return;
    }

    // Fallback when WebAudio node is unavailable.
    if (video.volume === 0) {
      video.muted = false;
      video.volume = 1;
      btnMute.textContent = '🔊';
      btnMute.title = 'Silenciar';
    } else {
      video.muted = false;
      video.volume = 0;
      btnMute.textContent = '🔇';
      btnMute.title = 'Ativar som';
    }
  });

  // Fullscreen
  btnFs.addEventListener('click', () => {
    const req = tile.requestFullscreen || tile.webkitRequestFullscreen;
    if (req) req.call(tile);
  });

  startTileStream(camera, tile, video);
  return tile;
}

// ── Status dots ───────────────────────────────────────────────────────────

function updateDots() {
  state.cameras.forEach(({ id }) => {
    const item = document.querySelector(`.cam-item[data-id="${id}"]`);
    const tile = document.querySelector(`.tile[data-id="${id}"]`);
    if (!item || !tile) return;

    const dot   = item.querySelector('.cam-dot');
    const video = tile.querySelector('video');
    const hasErr = !!tile.querySelector('.tile-error');
    const isLive  = video && !video.paused && video.readyState >= 3;

    dot.className = `cam-dot ${hasErr ? 'error' : isLive ? 'live' : 'connecting'}`;
  });
}
setInterval(updateDots, 2000);

// ── Render grid ───────────────────────────────────────────────────────────

function renderGrid() {
  const grid   = document.getElementById('grid');
  const n      = state.cameras.length;

  // Remove stale tiles
  grid.querySelectorAll('.tile').forEach((tile) => {
    if (!state.cameras.find((c) => c.id === tile.dataset.id)) {
      destroyPlayer(tile.dataset.id);
      reconnectState.delete(tile.dataset.id);
      tile.remove();
    }
  });

  // Empty state
  let empty = document.getElementById('empty');
  if (n === 0) {
    if (!empty) {
      empty = document.createElement('div');
      empty.id = 'empty';
      empty.innerHTML = `
        <div class="empty-icon">📷</div>
        <p>Nenhuma câmera adicionada</p>
        <small>Use o painel lateral para adicionar câmeras</small>
      `;
      document.getElementById('main').appendChild(empty);
    }
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows    = '';
    return;
  }
  if (empty) empty.remove();

  // Grid dimensions
  const { cols, rows } = gridLayout(n);
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows    = `repeat(${rows}, 1fr)`;

  // Add tiles in state order, ensuring DOM order matches
  state.cameras.forEach((camera, idx) => {
    let tile = grid.querySelector(`.tile[data-id="${camera.id}"]`);
    if (!tile) {
      tile = createTile(camera);
      grid.appendChild(tile);
    }
    // Fix DOM order
    const tiles = [...grid.querySelectorAll('.tile')];
    if (tiles[idx] !== tile) grid.insertBefore(tile, tiles[idx] || null);
  });
}

// ── Render sidebar list ───────────────────────────────────────────────────

function renderList() {
  const list  = document.getElementById('cam-list');
  const count = document.getElementById('cam-count');

  count.textContent = `(${state.cameras.length})`;
  list.innerHTML = '';

  state.cameras.forEach((camera, idx) => {
    const li = document.createElement('li');
    li.className = 'cam-item';
    li.draggable = true;
    li.dataset.id    = camera.id;
    li.dataset.index = idx;

    li.innerHTML = `
      <span class="drag-handle" title="Arrastar para reordenar">⠿</span>
      <span class="cam-dot connecting"></span>
      <span class="cam-name" title="${esc(camera.name)}">${esc(camera.name)}</span>
      <button class="cam-remove" title="Remover">✕</button>
    `;

    li.querySelector('.cam-remove').addEventListener('click', () => removeCamera(camera.id));

    li.addEventListener('dragstart', onDragStart);
    li.addEventListener('dragover',  onDragOver);
    li.addEventListener('dragleave', onDragLeave);
    li.addEventListener('drop',      onDrop);
    li.addEventListener('dragend',   onDragEnd);

    list.appendChild(li);
  });
}

// ── Drag & drop reorder ───────────────────────────────────────────────────

let dragIdx = null;

function onDragStart(e) {
  dragIdx = parseInt(this.dataset.index);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('drag-over');
}
function onDragLeave() { this.classList.remove('drag-over'); }
function onDragEnd()   { this.classList.remove('dragging'); }

function onDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  const targetIdx = parseInt(this.dataset.index);
  if (dragIdx === null || dragIdx === targetIdx) return;

  const next = [...state.cameras];
  const [moved] = next.splice(dragIdx, 1);
  next.splice(targetIdx, 0, moved);
  state.cameras = next;

  renderList();
  renderGrid();

  fetch('/api/cameras/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: next.map((c) => c.id) }),
  }).catch(() => toast('Erro ao salvar ordem', 'error'));
}

// ── API helpers ───────────────────────────────────────────────────────────

async function apiFetch(method, url, body) {
  const opts = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body:    body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ── Add / Remove cameras ──────────────────────────────────────────────────

async function addCamera(data) {
  const btn = document.getElementById('add-btn');
  btn.disabled = true;
  btn.textContent = 'Adicionando…';
  try {
    const cam = await apiFetch('POST', '/api/cameras', data);
    state.cameras.push(cam);
    const storedKey = upsertStoredCameraConfig(data);
    if (storedKey) cameraConfigKeyById.set(cam.id, storedKey);
    renderList();
    renderGrid();
    toast(`"${cam.name}" adicionada`, 'success');
    return true;
  } catch (err) {
    toast(`Erro: ${err.message}`, 'error');
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = '+ Adicionar';
  }
}

async function removeCamera(id) {
  const cam = state.cameras.find((c) => c.id === id);
  if (!cam) return;
  if (!confirm(`Remover câmera "${cam.name}"?`)) return;

  try {
    await apiFetch('DELETE', `/api/cameras/${id}`);
    destroyPlayer(id);
    removeStoredCameraConfigByKey(cameraConfigKeyById.get(id));
    cameraConfigKeyById.delete(id);
    reconnectState.delete(id);
    state.cameras = state.cameras.filter((c) => c.id !== id);
    renderList();
    renderGrid();
    toast('Câmera removida');
  } catch (err) {
    toast(`Erro ao remover: ${err.message}`, 'error');
  }
}

// ── Form ──────────────────────────────────────────────────────────────────

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const ip       = document.getElementById('f-ip').value.trim();
  const login    = document.getElementById('f-login').value.trim();
  const password = document.getElementById('f-pass').value;
  const name     = document.getElementById('f-name').value.trim();
  const port     = document.getElementById('f-port').value;
  const rtspPath = document.getElementById('f-path').value.trim() || '/onvif1';

  if (!ip || !login || !password) {
    toast('Preencha IP, login e senha', 'error');
    return;
  }

  const ok = await addCamera({ name: name || ip, ip, login, password, port, path: rtspPath });
  if (ok) {
    e.target.reset();
    document.getElementById('f-ip').value = '192.168.1.';
    document.getElementById('f-login').value = 'admin';
    document.getElementById('f-port').value = '554';
    document.getElementById('f-path').value = '/onvif1';
  }
});

document.getElementById('blackout-btn').addEventListener('click', async () => {
  if (!audioMonitor.blackout) {
    await resumeAudioContextIfNeeded();
  }
  setBlackout(!audioMonitor.blackout);
});

document.getElementById('blackout-exit-btn').addEventListener('click', () => {
  setBlackout(false);
});

document.getElementById('audio-watch-enabled').addEventListener('change', async (e) => {
  audioMonitor.enabled = !!e.target.checked;
  if (audioMonitor.enabled) await resumeAudioContextIfNeeded();
  savePowerSettings();
});

document.getElementById('audio-threshold').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  audioMonitor.threshold = value;
  document.getElementById('audio-threshold-value').textContent = String(value);
  savePowerSettings();
});

async function restoreSavedCameras() {
  const saved = getStoredCameraConfigs();
  if (!saved.length) return;

  for (const cfg of saved) {
    const ok = await addCamera(cfg);
    if (ok) {
      const added = state.cameras[state.cameras.length - 1];
      if (added) cameraConfigKeyById.set(added.id, cfg.key);
    }
  }
}

function applyPowerSettingsUI() {
  const settings = loadPowerSettings();
  audioMonitor.enabled = settings.enabled;
  audioMonitor.threshold = Math.min(80, Math.max(2, settings.threshold));
  audioMonitor.blackout = false;

  document.getElementById('audio-watch-enabled').checked = audioMonitor.enabled;
  document.getElementById('audio-threshold').value = String(audioMonitor.threshold);
  document.getElementById('audio-threshold-value').textContent = String(audioMonitor.threshold);

  setBlackout(false);
  audioMonitor.peak = 0;
  audioMonitor.peakUpdatedAt = Date.now();
  updateNoiseUI(0, 0);
  setupAudioContextAutoResume();
  ensureAudioWatchLoop();
}

// ── Sidebar collapse ──────────────────────────────────────────────────────

document.getElementById('collapse-btn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.add('collapsed');
  document.getElementById('expand-btn').hidden = false;
});
document.getElementById('expand-btn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('collapsed');
  document.getElementById('expand-btn').hidden = true;
  renderGrid(); // recalculate grid after sidebar reappears
});

window.addEventListener('resize', () => {
  if (state.cameras.length > 0) renderGrid();
});

// ── Boot ──────────────────────────────────────────────────────────────────

(async function init() {
  applyPowerSettingsUI();
  try {
    const cameras = await apiFetch('GET', '/api/cameras');
    state.cameras = cameras;
    renderList();
    renderGrid();
    if (state.cameras.length === 0) {
      await restoreSavedCameras();
    }
  } catch {
    toast('Não foi possível carregar as câmeras', 'error');
    renderGrid(); // show empty state
    await restoreSavedCameras();
  }
})();
