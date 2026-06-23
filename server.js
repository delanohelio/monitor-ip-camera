'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os     = require('os');

const PORT       = parseInt(process.env.PORT) || 3000;
const STREAMS_DIR = path.join(os.tmpdir(), 'ipcam-streams');
const PUBLIC_DIR  = path.join(__dirname, 'public');

/** In-memory state */
const cameras    = new Map(); // id -> { id, name, rtspUrl, process, hlsDir, transportIndex, forceTranscode }
let   cameraOrder = [];       // ordered array of ids

fs.mkdirSync(STREAMS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css',
  '.js'  : 'application/javascript',
  '.m3u8': 'application/x-mpegURL',
  '.ts'  : 'video/MP2T',
};

function mime(fp) {
  return MIME[path.extname(fp)] || 'application/octet-stream';
}

function sendFile(res, fp) {
  fs.stat(fp, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type' : mime(fp),
      'Cache-Control': 'no-cache, no-store',
    });
    fs.createReadStream(fp).pipe(res);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type'  : 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/** Basic UUID v4 regex */
function isValidUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
}

/** Allow IPv4 and simple hostnames */
function isValidHost(s) {
  return /^[\w.-]{1,253}$/.test(s) && !/\.\./.test(s);
}

// ---------------------------------------------------------------------------
// FFmpeg stream management
// ---------------------------------------------------------------------------

function startStream(camera) {
  const hlsDir = path.join(STREAMS_DIR, camera.id);
  fs.mkdirSync(hlsDir, { recursive: true });

  const transports = ['udp', 'tcp'];
  const transportIndex = Number.isInteger(camera.transportIndex) ? camera.transportIndex : 0;
  const transport = transports[((transportIndex % transports.length) + transports.length) % transports.length];
  const transcodeMode = !!camera.forceTranscode;

  const args = [
    '-rtsp_transport', transport,
    '-timeout', '30000000',
    '-fflags', '+genpts+discardcorrupt',
    '-use_wallclock_as_timestamps', '1',
    '-i', camera.rtspUrl,
  ];

  if (transcodeMode) {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-g', '30',
      '-keyint_min', '30',
      '-sc_threshold', '0'
    );
  } else {
    args.push('-c:v', 'copy');
  }

  args.push(
    '-c:a', 'aac',
    '-ar', '16000',
    '-ac', '1',
    '-b:a', '96k',
    '-af', 'aresample=async=1:first_pts=0',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_filename', path.join(hlsDir, 'seg%05d.ts'),
    path.join(hlsDir, 'stream.m3u8')
  );

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let shouldSwitchTransport = false;
  let transportErrorHint = '';
  let shouldEnableTranscode = false;
  let transcodeErrorHint = '';

  proc.stderr.on('data', (data) => {
    // Sanitise log — never print the rtsp URL (which contains credentials)
    const line = data.toString().replace(camera.rtspUrl, '[RTSP]');
    const lower = line.toLowerCase();
    if (lower.includes('nonmatching transport in server reply') ||
        lower.includes('461 unsupported transport') ||
        lower.includes('unsupported transport') ||
        lower.includes('server returned 400 bad request') ||
        (lower.includes('cseq') && lower.includes('expected'))) {
      shouldSwitchTransport = true;
      transportErrorHint = line.trim();
    }

    if (lower.includes('timestamps are unset in a packet') ||
        lower.includes('first pts and dts value must be set') ||
        lower.includes('error muxing a packet') ||
        lower.includes('error submitting a packet to the muxer')) {
      shouldEnableTranscode = true;
      transcodeErrorHint = line.trim();
    }

    process.stdout.write(`[cam:${camera.id.slice(0, 8)}] ${line}`);
  });

  proc.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('ERROR: ffmpeg not found. Install it: https://ffmpeg.org/download.html');
    } else {
      console.error(`[cam:${camera.id.slice(0, 8)}] spawn error:`, err.message);
    }
  });

  proc.on('close', (code) => {
    console.log(
      `[cam:${camera.id.slice(0, 8)}] ffmpeg exited (code=${code}, transport=${transport}, mode=${transcodeMode ? 'transcode' : 'copy'})`
    );
    // Auto-restart unless the camera was removed (camera.process cleared by stopStream)
    if (cameras.has(camera.id) && camera.process === proc && code !== null) {
      if (shouldEnableTranscode && !camera.forceTranscode) {
        camera.forceTranscode = true;
        console.log(`[cam:${camera.id.slice(0, 8)}] Erro de timestamps/mux detectado. Alternando para modo transcode (H.264).`);
        if (transcodeErrorHint) {
          console.log(`[cam:${camera.id.slice(0, 8)}] detalhe: ${transcodeErrorHint}`);
        }
        setTimeout(() => {
          if (cameras.has(camera.id)) startStream(camera);
        }, 1000);
        return;
      }

      if (shouldSwitchTransport) {
        camera.transportIndex = (transportIndex + 1) % transports.length;
        const nextTransport = transports[camera.transportIndex];
        console.log(
          `[cam:${camera.id.slice(0, 8)}] Falha RTSP no handshake/transporte. Alternando ${transport} -> ${nextTransport}.`
        );
        if (transportErrorHint) {
          console.log(`[cam:${camera.id.slice(0, 8)}] detalhe: ${transportErrorHint}`);
        }
        setTimeout(() => {
          if (cameras.has(camera.id)) startStream(camera);
        }, 1000);
        return;
      }
      console.log(`[cam:${camera.id.slice(0, 8)}] Reconnecting in 5 s…`);
      setTimeout(() => {
        if (cameras.has(camera.id)) startStream(camera);
      }, 5000);
    }
  });

  camera.process = proc;
  camera.hlsDir  = hlsDir;
}

function stopStream(camera) {
  if (camera.process) {
    camera.process.kill('SIGTERM');
    camera.process = null;
  }
  fs.rmSync(path.join(STREAMS_DIR, camera.id), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const urlObj   = new URL(req.url, 'http://localhost');
  const pathname = urlObj.pathname;
  const method   = req.method;

  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Static assets ───────────────────────────────────────────────────────
  if (method === 'GET') {
    const safe = { '/': 'index.html', '/index.html': 'index.html',
                   '/style.css': 'style.css', '/app.js': 'app.js' };
    if (safe[pathname]) {
      return sendFile(res, path.join(PUBLIC_DIR, safe[pathname]));
    }
  }

  // ── HLS segments  GET /hls/:id/:file ────────────────────────────────────
  if (method === 'GET' && pathname.startsWith('/hls/')) {
    const parts = pathname.split('/').filter(Boolean); // ['hls', id, filename]
    if (parts.length !== 3) { res.writeHead(400); res.end(); return; }

    const [, cameraId, filename] = parts;

    if (!isValidUUID(cameraId) || !/^[\w.-]+$/.test(filename)) {
      res.writeHead(400); res.end('Bad request'); return;
    }
    if (!cameras.has(cameraId)) {
      res.writeHead(404); res.end('Camera not found'); return;
    }

    const camera   = cameras.get(cameraId);
    const filePath = path.resolve(camera.hlsDir, filename);

    // Path-traversal guard
    if (!filePath.startsWith(path.resolve(camera.hlsDir) + path.sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    return sendFile(res, filePath);
  }

  // ── GET /api/cameras ────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/api/cameras') {
    const list = cameraOrder
      .filter((id) => cameras.has(id))
      .map((id) => { const c = cameras.get(id); return { id: c.id, name: c.name }; });
    return sendJSON(res, 200, list);
  }

  // ── POST /api/cameras ───────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/cameras') {
    const body = await readBody(req);
    const { name, ip, login, password, port, path: streamPath } = body;

    if (!ip || typeof ip !== 'string' ||
        !login || typeof login !== 'string' ||
        !password || typeof password !== 'string') {
      return sendJSON(res, 400, { error: 'ip, login e password são obrigatórios' });
    }
    if (!isValidHost(ip)) {
      return sendJSON(res, 400, { error: 'IP/host inválido' });
    }

    const rtspPort = parseInt(port) || 554;
    if (rtspPort < 1 || rtspPort > 65535) {
      return sendJSON(res, 400, { error: 'Porta inválida' });
    }

    const rtspPath = (streamPath || '/onvif1').trim();
    if (!/^\/[\w/.@-]*$/.test(rtspPath)) {
      return sendJSON(res, 400, { error: 'Caminho de stream inválido' });
    }

    const id   = crypto.randomUUID();
    // Encode credentials to handle special chars in the URL
    const rtspUrl = `rtsp://${encodeURIComponent(login)}:${encodeURIComponent(password)}@${ip}:${rtspPort}${rtspPath}`;
    const camName = String(name || ip).slice(0, 100);

    const camera = { id, name: camName, rtspUrl, transportIndex: 0, forceTranscode: false };
    cameras.set(id, camera);
    cameraOrder.push(id);
    startStream(camera);

    return sendJSON(res, 201, { id, name: camName });
  }

  // ── POST /api/cameras/:id/reconnect ─────────────────────────────────────
  if (method === 'POST') {
    const m = pathname.match(/^\/api\/cameras\/([^/]+)\/reconnect$/);
    if (m) {
      const id = m[1];
      if (!isValidUUID(id) || !cameras.has(id)) {
        return sendJSON(res, 404, { error: 'Câmera não encontrada' });
      }

      const camera = cameras.get(id);
      stopStream(camera);
      startStream(camera);
      return sendJSON(res, 200, { success: true });
    }
  }

  // ── DELETE /api/cameras/:id ─────────────────────────────────────────────
  if (method === 'DELETE') {
    const m = pathname.match(/^\/api\/cameras\/([^/]+)$/);
    if (m) {
      const id = m[1];
      if (!isValidUUID(id) || !cameras.has(id)) {
        return sendJSON(res, 404, { error: 'Câmera não encontrada' });
      }
      stopStream(cameras.get(id));
      cameras.delete(id);
      cameraOrder = cameraOrder.filter((cid) => cid !== id);
      return sendJSON(res, 200, { success: true });
    }
  }

  // ── PUT /api/cameras/reorder ─────────────────────────────────────────────
  if (method === 'PUT' && pathname === '/api/cameras/reorder') {
    const body = await readBody(req);
    const { order } = body;

    if (!Array.isArray(order) || order.length !== cameras.size) {
      return sendJSON(res, 400, { error: 'Array de ordem inválido' });
    }
    if (!order.every((id) => isValidUUID(id) && cameras.has(id))) {
      return sendJSON(res, 400, { error: 'IDs inválidos na ordem' });
    }

    cameraOrder = order;
    return sendJSON(res, 200, { success: true });
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  IP Camera Monitor  →  http://localhost:${PORT}\n`);
  console.log('  Certifique-se que o ffmpeg está instalado.\n');
});

// Graceful shutdown
function shutdown() {
  console.log('\nEncerrando…');
  cameras.forEach((cam) => stopStream(cam));
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
