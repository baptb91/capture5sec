const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cluster = require('cluster');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 10000;

// ⏱️ TIMEOUTS OPTIMISÉS POUR MAKE.COM
const TIMEOUTS = {
  AXIOS_DOWNLOAD: 180000,        // 3 minutes pour télécharger (réduit)
  AXIOS_RESPONSE: 300000,        // 5 minutes timeout total axios
  FILE_WAIT: 30000,              // 30 secondes pour attendre fichier stable
  FFMPEG_PROCESSING: 60000,      // 1 minute pour FFmpeg (largement suffisant pour 5s)
  DOWNLOAD_STREAM: 240000,       // 4 minutes pour le stream
  REQUEST_TIMEOUT: 450000,       // 7.5 minutes timeout total (sous les 10 min de Make)
  BATCH_DELAY: 1000,             // 1 seconde entre vidéos (réduit)
  MAKE_TIMEOUT_BUFFER: 60000     // Buffer de 1 minute avant timeout Make
};

// Configuration Express optimisée
app.use(express.json({ limit: '10mb' })); // Réduit car on ne reçoit que des URLs

// Middleware de timeout optimisé pour Make.com
app.use((req, res, next) => {
  // Timeout plus court pour éviter les timeouts Make.com
  req.setTimeout(TIMEOUTS.REQUEST_TIMEOUT);
  res.setTimeout(TIMEOUTS.REQUEST_TIMEOUT);
  
  // Log de début de requête
  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`⏱️ Requête terminée en ${duration}ms`);
  });
  
  next();
});

// File d'attente avec priorité et limitation intelligente
class ProcessingQueue {
  constructor(maxConcurrent = 3) { // Augmenté à 3 pour plus de débit
    this.queue = new Map();
    this.processing = new Set();
    this.maxConcurrent = maxConcurrent;
    this.stats = {
      processed: 0,
      errors: 0,
      avgProcessingTime: 0
    };
  }
  
  canProcess() {
    return this.processing.size < this.maxConcurrent;
  }
  
  add(id, priority = 0) {
    this.queue.set(id, { id, priority, startTime: Date.now() });
    console.log(`📋 [${id}] Ajouté à la file (${this.queue.size} en attente, ${this.processing.size} en cours)`);
  }
  
  startProcessing(id) {
    this.processing.add(id);
    this.queue.delete(id);
    console.log(`🔄 [${id}] Début du traitement (${this.processing.size}/${this.maxConcurrent})`);
  }
  
  finishProcessing(id, success = true) {
    this.processing.delete(id);
    this.stats.processed++;
    if (!success) this.stats.errors++;
    console.log(`✅ [${id}] Fin du traitement (${this.processing.size}/${this.maxConcurrent})`);
  }
  
  getStats() {
    return {
      ...this.stats,
      currentLoad: this.processing.size,
      maxLoad: this.maxConcurrent,
      queueSize: this.queue.size
    };
  }
}

const processingQueue = new ProcessingQueue(3);

// Vérification FFmpeg optimisée
exec('which ffmpeg', (error, stdout, stderr) => {
  if (error || !stdout.trim()) {
    console.error('❌ FFmpeg non trouvé. Installation requise.');
    process.exit(1);
  } else {
    console.log('✅ FFmpeg disponible:', stdout.trim());
    // Test rapide de FFmpeg
    exec('ffmpeg -version | head -n 1', (err, out) => {
      if (out) console.log('🔧 Version FFmpeg:', out.trim());
    });
  }
});

// Fonction optimisée pour attendre qu'un fichier soit stable
function waitForFile(filePath, timeout = TIMEOUTS.FILE_WAIT) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let lastSize = 0;
    let stableCount = 0;
    
    const checkFile = () => {
      if (Date.now() - startTime > timeout) {
        return reject(new Error(`Timeout: fichier non stable après ${timeout/1000}s`));
      }
      
      if (!fs.existsSync(filePath)) {
        return setTimeout(checkFile, 200); // Vérification plus rapide
      }
      
      try {
        const stats = fs.statSync(filePath);
        if (stats.size === lastSize && stats.size > 0) {
          stableCount++;
          if (stableCount >= 3) { // Stable pendant 600ms seulement
            return resolve(stats);
          }
        } else {
          stableCount = 0;
          lastSize = stats.size;
        }
      } catch (err) {
        // Fichier en cours d'écriture, continuer
      }
      
      setTimeout(checkFile, 200);
    };
    
    checkFile();
  });
}

// Nettoyage optimisé et non-bloquant
function cleanupFiles(files) {
  // Nettoyage asynchrone pour ne pas bloquer
  setImmediate(() => {
    files.forEach(file => {
      try {
        if (fs.existsSync(file)) {
          fs.unlink(file, (err) => {
            if (err) {
              console.error(`⚠️ Erreur suppression ${file}:`, err.message);
            } else {
              console.log(`🗑️ Supprimé: ${path.basename(file)}`);
            }
          });
        }
      } catch (err) {
        console.error(`⚠️ Erreur lors du nettoyage de ${file}:`, err.message);
      }
    });
  });
}

// Fonction principale optimisée pour la vitesse
async function extractScreenshot(videoUrl, timestamp = 5, id = null) {
  const requestId = id || uuidv4();
  const inputPath = `/tmp/input-${requestId}.mp4`;
  const outputPath = `/tmp/output-${requestId}.jpg`;
  const startTime = Date.now();
  
  try {
    console.log(`🚀 [${requestId}] Début: ${videoUrl.substring(0, 80)}...`);
    
    // 1. Téléchargement optimisé avec progress tracking
    console.log(`📥 [${requestId}] Téléchargement...`);
    
    const axiosConfig = {
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      timeout: TIMEOUTS.AXIOS_DOWNLOAD,
      maxRedirects: 5, // Réduit
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
        'Accept': 'video/*,*/*;q=0.8',
        'Range': 'bytes=0-52428800' // Limite à 50MB pour accélérer
      },
      maxContentLength: 100 * 1024 * 1024, // 100MB max (réduit)
      maxBodyLength: 100 * 1024 * 1024
    };
    
    const response = await axios(axiosConfig);
    const writer = fs.createWriteStream(inputPath);
    
    // Pipe avec timeout et monitoring
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      let downloadTimeout;
      let lastProgress = Date.now();
      
      const progressMonitor = setInterval(() => {
        if (fs.existsSync(inputPath)) {
          const currentSize = fs.statSync(inputPath).size;
          if (currentSize > 0) {
            lastProgress = Date.now();
            console.log(`📊 [${requestId}] ${(currentSize / 1024 / 1024).toFixed(1)}MB`);
          }
        }
        
        // Timeout si pas de progrès depuis 30s
        if (Date.now() - lastProgress > 30000) {
          clearInterval(progressMonitor);
          writer.destroy();
          reject(new Error('Téléchargement bloqué - pas de progrès'));
        }
      }, 5000);
      
      writer.on('finish', () => {
        clearTimeout(downloadTimeout);
        clearInterval(progressMonitor);
        resolve();
      });
      
      writer.on('error', (err) => {
        clearTimeout(downloadTimeout);
        clearInterval(progressMonitor);
        reject(err);
      });
      
      downloadTimeout = setTimeout(() => {
        clearInterval(progressMonitor);
        writer.destroy();
        reject(new Error(`Timeout téléchargement (${TIMEOUTS.DOWNLOAD_STREAM/1000}s)`));
      }, TIMEOUTS.DOWNLOAD_STREAM);
    });
    
    // Vérification rapide du fichier
    const videoStats = fs.statSync(inputPath);
    console.log(`✅ [${requestId}] Téléchargé: ${(videoStats.size / 1024 / 1024).toFixed(2)}MB`);
    
    if (videoStats.size < 1024) { // Moins de 1KB = problème
      throw new Error('Fichier vidéo trop petit ou corrompu');
    }
    
    // 2. Extraction FFmpeg ultra-optimisée
    console.log(`🎬 [${requestId}] Extraction à ${timestamp}s...`);
    
    // Commande FFmpeg optimisée pour la vitesse
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error', // Moins de logs
      '-ss', `${timestamp}`, // Seek avant input pour plus de vitesse
      '-i', inputPath,
      '-frames:v', '1',
      '-q:v', '5', // Qualité légèrement réduite pour la vitesse
      '-vf', 'scale=1280:-1', // Résolution réduite pour la vitesse
      '-f', 'image2',
      '-y',
      outputPath
    ];
    
    await new Promise((resolve, reject) => {
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stderr = '';
      ffmpegProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      const ffmpegTimeout = setTimeout(() => {
        ffmpegProcess.kill('SIGKILL');
        reject(new Error(`FFmpeg timeout (${TIMEOUTS.FFMPEG_PROCESSING/1000}s)`));
      }, TIMEOUTS.FFMPEG_PROCESSING);
      
      ffmpegProcess.on('close', (code) => {
        clearTimeout(ffmpegTimeout);
        
        if (code === 0) {
          resolve();
        } else {
          console.error(`❌ [${requestId}] FFmpeg stderr:`, stderr);
          reject(new Error(`FFmpeg failed with code ${code}`));
        }
      });
      
      ffmpegProcess.on('error', (error) => {
        clearTimeout(ffmpegTimeout);
        reject(new Error(`FFmpeg spawn error: ${error.message}`));
      });
    });
    
    // 3. Vérification et lecture du résultat
    const imageStats = await waitForFile(outputPath, 10000); // 10s max
    console.log(`📸 [${requestId}] Image: ${(imageStats.size / 1024).toFixed(1)}KB`);
    
    if (imageStats.size < 1024) { // Moins de 1KB = problème
      throw new Error('Image générée trop petite');
    }
    
    // Lecture asynchrone non-bloquante
    const imageBuffer = await new Promise((resolve, reject) => {
      fs.readFile(outputPath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
    
    // Nettoyage immédiat et non-bloquant
    cleanupFiles([inputPath, outputPath]);
    
    const processingTime = Date.now() - startTime;
    console.log(`🎉 [${requestId}] Terminé en ${processingTime}ms`);
    
    return {
      success: true,
      image: imageBuffer,
      size: imageBuffer.length,
      requestId,
      processingTime
    };
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`💥 [${requestId}] Erreur après ${processingTime}ms:`, error.message);
    
    // Nettoyage en cas d'erreur
    cleanupFiles([inputPath, outputPath]);
    
    throw new Error(`Processing failed: ${error.message}`);
  }
}

// Endpoint principal optimisé pour Make.com
app.post('/screenshot', async (req, res) => {
  const { videoUrl, timestamp = 5, returnBase64 = false } = req.body;
  const requestId = uuidv4();
  const requestStart = Date.now();
  
  console.log(`🎯 [${requestId}] Nouvelle requête Make.com`);
  
  if (!videoUrl) {
    return res.status(400).json({ 
      error: 'videoUrl required',
      requestId,
      success: false
    });
  }
  
  // Validation URL rapide
  try {
    new URL(videoUrl);
  } catch {
    return res.status(400).json({
      error: 'URL invalide',
      requestId,
      success: false
    });
  }
  
  // Vérification de la charge
  if (!processingQueue.canProcess()) {
    console.log(`⏸️ [${requestId}] Serveur surchargé`);
    return res.status(429).json({
      error: 'Serveur surchargé, réessayez dans 30 secondes',
      requestId,
      success: false,
      retryAfter: 30,
      stats: processingQueue.getStats()
    });
  }
  
  processingQueue.add(requestId);
  processingQueue.startProcessing(requestId);
  
  try {
    // Timeout de sécurité pour Make.com (8 minutes max)
    const makeTimeout = setTimeout(() => {
      throw new Error('Timeout Make.com - traitement interrompu');
    }, 480000); // 8 minutes
    
    const result = await extractScreenshot(videoUrl, timestamp, requestId);
    clearTimeout(makeTimeout);
    
    processingQueue.finishProcessing(requestId, true);
    
    const totalTime = Date.now() - requestStart;
    
    if (returnBase64) {
      res.json({
        success: true,
        requestId,
        image: result.image.toString('base64'),
        size: result.size,
        mimeType: 'image/jpeg',
        timestamp: new Date().toISOString(),
        processingTime: totalTime,
        serverStats: processingQueue.getStats()
      });
    } else {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', result.size);
      res.setHeader('X-Request-ID', requestId);
      res.setHeader('X-Success', 'true');
      res.setHeader('X-Processing-Time', totalTime);
      res.send(result.image);
    }
    
    console.log(`🚀 [${requestId}] Succès Make.com en ${totalTime}ms`);
    
  } catch (error) {
    processingQueue.finishProcessing(requestId, false);
    
    const totalTime = Date.now() - requestStart;
    console.error(`💥 [${requestId}] Échec après ${totalTime}ms:`, error.message);
    
    if (!res.headersSent) {
      // Réponse d'erreur adaptée à Make.com
      const errorResponse = {
        success: false,
        error: error.message,
        requestId,
        timestamp: new Date().toISOString(),
        processingTime: totalTime,
        retryable: !error.message.includes('Timeout') && !error.message.includes('invalid'),
        serverStats: processingQueue.getStats()
      };
      
      const statusCode = error.message.includes('Timeout') ? 408 : 
                        error.message.includes('invalid') ? 400 : 500;
      
      res.status(statusCode).json(errorResponse);
    }
  }
});

// Endpoint de batch optimisé
app.post('/batch-screenshot', async (req, res) => {
  const { videos, timestamp = 5 } = req.body;
  const batchId = uuidv4();
  
  if (!Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({
      error: 'videos array required',
      batchId
    });
  }
  
  // Limite adaptée à Make.com (max 3 pour éviter timeouts)
  if (videos.length > 3) {
    return res.status(400).json({
      error: 'Maximum 3 vidéos par batch pour éviter les timeouts Make.com',
      batchId,
      suggestion: 'Utilisez plusieurs appels séparés'
    });
  }
  
  console.log(`📦 [${batchId}] Batch de ${videos.length} vidéos`);
  
  const results = [];
  const batchStart = Date.now();
  
  // Traitement séquentiel optimisé
  for (let i = 0; i < videos.length; i++) {
    const videoUrl = videos[i];
    const requestId = `${batchId}-${i + 1}`;
    
    // Vérification timeout global du batch
    if (Date.now() - batchStart > 400000) { // 6.5 minutes max pour le batch
      console.log(`⏰ [${batchId}] Timeout batch, arrêt à la vidéo ${i + 1}`);
      break;
    }
    
    try {
      const result = await extractScreenshot(videoUrl, timestamp, requestId);
      results.push({
        index: i,
        videoUrl: videoUrl.substring(0, 80) + '...',
        success: true,
        image: result.image.toString('base64'),
        size: result.size,
        processingTime: result.processingTime
      });
    } catch (error) {
      results.push({
        index: i,
        videoUrl: videoUrl.substring(0, 80) + '...',
        success: false,
        error: error.message
      });
    }
    
    // Pause courte entre vidéos
    if (i < videos.length - 1) {
      await new Promise(resolve => setTimeout(resolve, TIMEOUTS.BATCH_DELAY));
    }
  }
  
  const batchTime = Date.now() - batchStart;
  const successful = results.filter(r => r.success).length;
  
  console.log(`🏁 [${batchId}] Terminé en ${batchTime}ms: ${successful}/${videos.length} succès`);
  
  res.json({
    batchId,
    total: videos.length,
    successful,
    failed: results.length - successful,
    results,
    batchProcessingTime: batchTime,
    serverStats: processingQueue.getStats()
  });
});

// Health check amélioré
app.get('/health', (req, res) => {
  const memoryUsage = process.memoryUsage();
  const stats = processingQueue.getStats();
  
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    memory: {
      used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB'
    },
    processing: stats,
    timeouts: {
      request: TIMEOUTS.REQUEST_TIMEOUT / 1000 + 's',
      download: TIMEOUTS.AXIOS_DOWNLOAD / 1000 + 's',
      ffmpeg: TIMEOUTS.FFMPEG_PROCESSING / 1000 + 's'
    },
    makeCompatible: true
  });
});

// Page d'accueil informative
app.get('/', (req, res) => {
  const stats = processingQueue.getStats();
  res.send(`
    <h1>🎬 FFmpeg Screenshot API - Optimisé Make.com</h1>
    <div style="font-family: monospace; background: #f5f5f5; padding: 20px; border-radius: 8px;">
      <p><strong>🟢 Status:</strong> Opérationnel</p>
      <p><strong>⏱️ Timeouts:</strong></p>
      <ul>
        <li>Requête totale: ${TIMEOUTS.REQUEST_TIMEOUT/1000/60} min</li>
        <li>Téléchargement: ${TIMEOUTS.AXIOS_DOWNLOAD/1000/60} min</li>
        <li>FFmpeg: ${TIMEOUTS.FFMPEG_PROCESSING/1000} sec</li>
      </ul>
      <p><strong>📊 Charge actuelle:</strong> ${stats.currentLoad}/${stats.maxLoad}</p>
      <p><strong>📈 Statistiques:</strong> ${stats.processed} traitées, ${stats.errors} erreurs</p>
      <p><strong>🔗 Endpoints:</strong></p>
      <ul>
        <li><code>POST /screenshot</code> - Capture unique</li>
        <li><code>POST /batch-screenshot</code> - Batch (max 3)</li>
        <li><code>GET /health</code> - État du serveur</li>
      </ul>
    </div>
  `);
});

// Nettoyage automatique plus agressif
setInterval(() => {
  console.log('🧹 Nettoyage automatique...');
  exec('find /tmp -name "input-*.mp4" -mmin +10 -delete', () => {}); // 10 min
  exec('find /tmp -name "output-*.jpg" -mmin +10 -delete', () => {});
  
  // Log des stats périodiques
  const stats = processingQueue.getStats();
  const memUsage = process.memoryUsage();
  console.log(`📊 Stats: ${stats.processed} traitées, charge ${stats.currentLoad}/${stats.maxLoad}, RAM ${Math.round(memUsage.heapUsed/1024/1024)}MB`);
}, 600000); // Toutes les 10 minutes

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('💥 Exception non gérée:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Promesse rejetée:', reason);
});

// Démarrage du serveur
const server = app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`⏱️ Timeouts optimisés pour Make.com:`);
  console.log(`   - Requête totale: ${TIMEOUTS.REQUEST_TIMEOUT/1000/60} min`);
  console.log(`   - Téléchargement: ${TIMEOUTS.AXIOS_DOWNLOAD/1000} sec`);
  console.log(`   - FFmpeg: ${TIMEOUTS.FFMPEG_PROCESSING/1000} sec`);
  console.log(`📋 Traitement concurrent: ${processingQueue.maxConcurrent}`);
  console.log(`✅ Prêt pour Make.com !`);
});

// Configuration serveur HTTP optimisée
server.timeout = TIMEOUTS.REQUEST_TIMEOUT;
server.headersTimeout = TIMEOUTS.REQUEST_TIMEOUT + 5000;
server.requestTimeout = TIMEOUTS.REQUEST_TIMEOUT;
server.keepAliveTimeout = 5000; // Connexions keep-alive courtes
