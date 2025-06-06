// server.js
const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- CONFIGURATION ---
const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB
const DOWNLOAD_TIMEOUT = 45000; // 45s
const FFMPEG_TIMEOUT = 12000; // 12s
const REQUEST_TIMEOUT = 70000; // 70s
const MAX_CONCURRENT = 1; // 1 à la fois (free plan)
const TMP_DIR = '/tmp/videos'; // Render autorise /tmp

// --- FILE QUEUE ---
let queue = [];
let running = 0;

// --- UTILS ---
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function cleanupFiles(...files) {
  for (const file of files) {
    try { await fs.remove(file); } catch {}
  }
}

function checkMemoryUsage() {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  if (used > 400) console.warn(`⚠️ Mémoire utilisée: ${Math.round(used)}MB`);
}

// --- TÉLÉCHARGEMENT VIDÉO ---
async function downloadVideo(url, dest, requestId) {
  const writer = fs.createWriteStream(dest);
  let downloaded = 0;
  const source = axios.CancelToken.source();

  const timeout = setTimeout(() => {
    source.cancel(`Timeout téléchargement vidéo (${DOWNLOAD_TIMEOUT}ms)`);
  }, DOWNLOAD_TIMEOUT);

  try {
    const response = await axios({
      method: 'get',
      url,
      responseType: 'stream',
      timeout: 8000,
      maxContentLength: MAX_VIDEO_SIZE,
      cancelToken: source.token,
      headers: { 'User-Agent': 'VideoProcessor/1.0' }
    });

    return await new Promise((resolve, reject) => {
      response.data.on('data', chunk => {
        downloaded += chunk.length;
        if (downloaded > MAX_VIDEO_SIZE) {
          reject(new Error('Vidéo trop volumineuse'));
          source.cancel();
        }
      });
      response.data.pipe(writer);
      writer.on('finish', () => resolve());
      writer.on('error', reject);
      response.data.on('error', reject);
    });
  } finally {
    clearTimeout(timeout);
  }
}

// --- CAPTURE IMAGE AVEC FFMPEG ---
async function extractFrame(videoPath, imagePath, requestId) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ff = ffmpeg(videoPath)
      .inputOptions('-ss', '5')
      .outputOptions('-frames:v', '1', '-q:v', '12', '-vf', 'scale=640:-1', '-y')
      .output(imagePath)
      .on('end', () => { done = true; resolve(); })
      .on('error', err => { if (!done) reject(err); });

    // Timeout FFmpeg
    const timeout = setTimeout(() => {
      ff.kill('SIGKILL');
      reject(new Error('Timeout FFmpeg'));
    }, FFMPEG_TIMEOUT);

    ff.run();
  });
}

// --- TRAITEMENT PRINCIPAL ---
async function processVideo({ videoUrl, requestId }, res) {
  const tmpId = uuidv4();
  const videoPath = path.join(TMP_DIR, `${tmpId}.mp4`);
  const imagePath = path.join(TMP_DIR, `${tmpId}.jpg`);

  try {
    await fs.ensureDir(TMP_DIR);

    // 1. Téléchargement vidéo
    await downloadVideo(videoUrl, videoPath, requestId);

    // 2. Capture image à 5s
    await extractFrame(videoPath, imagePath, requestId);

    // 3. Retourne l'image
    const img = await fs.readFile(imagePath);
    res.set('Content-Type', 'image/jpeg');
    res.send(img);
  } catch (err) {
    res.status(408).json({
      success: false,
      error: err.message,
      errorType: err.message.includes('Timeout') ? 'TIMEOUT' : 'PROCESSING',
      requestId,
      timestamp: new Date().toISOString()
    });
  } finally {
    await cleanupFiles(videoPath, imagePath);
    checkMemoryUsage();
    running--;
    processQueue();
  }
}

// --- FILE D'ATTENTE ---
function processQueue() {
  if (running >= MAX_CONCURRENT || queue.length === 0) return;
  const { params, res } = queue.shift();
  running++;
  processVideo(params, res);
}

// --- ENDPOINT ---
app.post('/extract-frame', async (req, res) => {
  const { videoUrl } = req.body;
  const requestId = uuidv4();

  if (!videoUrl || typeof videoUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'URL manquante', requestId });
  }

  // Ajoute à la file d'attente
  queue.push({ params: { videoUrl, requestId }, res });
  processQueue();
});

// --- SERVER ---
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
server.setTimeout(REQUEST_TIMEOUT); // timeout global par requête

// --- GESTION ERREURS GLOBALES ---
process.on('uncaughtException', err => {
  console.error('Erreur non capturée:', err);
});
process.on('unhandledRejection', err => {
  console.error('Promesse non gérée:', err);
});
