const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// ⏱️ TIMEOUTS OPTIMISÉS POUR MAKE.COM
const TIMEOUTS = {
  AXIOS_DOWNLOAD: 180000,        // 3 minutes pour télécharger
  AXIOS_RESPONSE: 300000,        // 5 minutes timeout total axios
  FILE_WAIT: 30000,              // 30 secondes pour attendre fichier stable
  FFMPEG_PROCESSING: 60000,      // 1 minute pour FFmpeg
  DOWNLOAD_STREAM: 240000,       // 4 minutes pour le stream
  REQUEST_TIMEOUT: 450000,       // 7.5 minutes timeout total
  BATCH_DELAY: 1000,             // 1 seconde entre vidéos
  MAKE_TIMEOUT_BUFFER: 60000     // Buffer de 1 minute avant timeout Make
};

// Configuration Express avec middleware de débogage
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Ajout pour form-data

// Middleware de débogage pour Make.com
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.path}`);
  console.log('📋 Headers:', JSON.stringify(req.headers, null, 2));
  console.log('📦 Body:', JSON.stringify(req.body, null, 2));
  console.log('🔍 Query:', JSON.stringify(req.query, null, 2));
  
  req.setTimeout(TIMEOUTS.REQUEST_TIMEOUT);
  res.setTimeout(TIMEOUTS.REQUEST_TIMEOUT);
  
  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`⏱️ Requête terminée en ${duration}ms`);
  });
  
  next();
});

// File d'attente avec priorité et limitation intelligente
class ProcessingQueue {
  constructor(maxConcurrent = 3) {
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

// Vérification FFmpeg
exec('which ffmpeg', (error, stdout, stderr) => {
  if (error || !stdout.trim()) {
    console.error('❌ FFmpeg non trouvé. Installation requise.');
    process.exit(1);
  } else {
    console.log('✅ FFmpeg disponible:', stdout.trim());
  }
});

// Fonction pour attendre qu'un fichier soit stable
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
        return setTimeout(checkFile, 200);
      }
      
      try {
        const stats = fs.statSync(filePath);
        if (stats.size === lastSize && stats.size > 0) {
          stableCount++;
          if (stableCount >= 3) {
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

// Fonction principale optimisée
async function extractScreenshot(videoUrl, timestamp = 5, id = null) {
  const requestId = id || uuidv4();
  const inputPath = `/tmp/input-${requestId}.mp4`;
  const outputPath = `/tmp/output-${requestId}.jpg`;
  const startTime = Date.now();
  
  try {
    console.log(`🚀 [${requestId}] Début: ${videoUrl.substring(0, 80)}...`);
    
    // 1. Téléchargement optimisé
    console.log(`📥 [${requestId}] Téléchargement...`);
    
    const axiosConfig = {
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      timeout: TIMEOUTS.AXIOS_DOWNLOAD,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
        'Accept': 'video/*,*/*;q=0.8'
      },
      maxContentLength: 100 * 1024 * 1024, // 100MB max
      maxBodyLength: 100 * 1024 * 1024
    };
    
    const response = await axios(axiosConfig);
    const writer = fs.createWriteStream(inputPath);
    
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
    
    const videoStats = fs.statSync(inputPath);
    console.log(`✅ [${requestId}] Téléchargé: ${(videoStats.size / 1024 / 1024).toFixed(2)}MB`);
    
    if (videoStats.size < 1024) {
      throw new Error('Fichier vidéo trop petit ou corrompu');
    }
    
    // 2. Extraction FFmpeg
    console.log(`🎬 [${requestId}] Extraction à ${timestamp}s...`);
    
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', `${timestamp}`,
      '-i', inputPath,
      '-frames:v', '1',
      '-q:v', '5',
      '-vf', 'scale=1280:-1',
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
    const imageStats = await waitForFile(outputPath, 10000);
    console.log(`📸 [${requestId}] Image: ${(imageStats.size / 1024).toFixed(1)}KB`);
    
    if (imageStats.size < 1024) {
      throw new Error('Image générée trop petite');
    }
    
    const imageBuffer = await new Promise((resolve, reject) => {
      fs.readFile(outputPath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
    
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
    
    cleanupFiles([inputPath, outputPath]);
    
    throw new Error(`Processing failed: ${error.message}`);
  }
}

// Fonction pour extraire les paramètres de différentes sources
function extractParameters(req) {
  const params = {
    videoUrl: null,
    timestamp: 5,
    returnBase64: false
  };
  
  // Essayer différentes sources de paramètres
  const sources = [req.body, req.query, req.params];
  
  for (const source of sources) {
    if (source) {
      // Différentes variantes de noms de paramètres
      const urlVariants = ['videoUrl', 'video_url', 'url', 'video', 'link', 'videoLink'];
      const timestampVariants = ['timestamp', 'time', 'seconds', 'sec', 't'];
      const base64Variants = ['returnBase64', 'return_base64', 'base64', 'asBase64'];
      
      // Chercher videoUrl
      if (!params.videoUrl) {
        for (const variant of urlVariants) {
          if (source[variant]) {
            params.videoUrl = source[variant];
            break;
          }
        }
      }
      
      // Chercher timestamp
      for (const variant of timestampVariants) {
        if (source[variant] !== undefined) {
          const ts = parseFloat(source[variant]);
          if (!isNaN(ts) && ts >= 0) {
            params.timestamp = ts;
            break;
          }
        }
      }
      
      // Chercher returnBase64
      for (const variant of base64Variants) {
        if (source[variant] !== undefined) {
          params.returnBase64 = Boolean(source[variant]);
          break;
        }
      }
    }
  }
  
  return params;
}

// Endpoint principal corrigé pour Make.com
app.post('/screenshot', async (req, res) => {
  const requestId = uuidv4();
  const requestStart = Date.now();
  
  console.log(`🎯 [${requestId}] Nouvelle requête Make.com`);
  
  try {
    // Extraction flexible des paramètres
    const { videoUrl, timestamp, returnBase64 } = extractParameters(req);
    
    console.log(`📋 [${requestId}] Paramètres extraits:`, { videoUrl: videoUrl?.substring(0, 50) + '...', timestamp, returnBase64 });
    
    // Validation
    if (!videoUrl) {
      console.error(`❌ [${requestId}] Aucune URL vidéo trouvée`);
      return res.status(400).json({ 
        error: 'videoUrl required. Accepted parameter names: videoUrl, video_url, url, video, link, videoLink',
        requestId,
        success: false,
        receivedParams: Object.keys(req.body || {}).concat(Object.keys(req.query || {}))
      });
    }
    
    // Validation URL
    try {
      new URL(videoUrl);
    } catch {
      console.error(`❌ [${requestId}] URL invalide:`, videoUrl);
      return res.status(400).json({
        error: 'URL invalide',
        requestId,
        success: false,
        receivedUrl: videoUrl
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
    
    // Timeout de sécurité pour Make.com
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

// Endpoint GET pour tests faciles
app.get('/screenshot', (req, res) => {
  const { url, timestamp = 5 } = req.query;
  
  if (!url) {
    return res.status(400).json({
      error: 'URL parameter required',
      example: '/screenshot?url=https://example.com/video.mp4&timestamp=5'
    });
  }
  
  // Rediriger vers POST avec les mêmes paramètres
  req.body = { videoUrl: url, timestamp: parseFloat(timestamp) };
  return app._router.handle(Object.assign(req, { method: 'POST', url: '/screenshot' }), res);
});

// Endpoint de test simple
app.get('/test', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Serveur opérationnel',
    timestamp: new Date().toISOString(),
    endpoints: {
      'POST /screenshot': 'Capture d\'écran (JSON body)',
      'GET /screenshot': 'Capture d\'écran (URL params)',
      'GET /health': 'État du serveur',
      'GET /test': 'Test de connexion'
    },
    examples: {
      postBody: {
        videoUrl: 'https://example.com/video.mp4',
        timestamp: 5,
        returnBase64: false
      },
      getUrl: '/screenshot?url=https://example.com/video.mp4&timestamp=5'
    }
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
      <p><strong>📊 Charge actuelle:</strong> ${stats.currentLoad}/${stats.maxLoad}</p>
      <p><strong>📈 Statistiques:</strong> ${stats.processed} traitées, ${stats.errors} erreurs</p>
      
      <h2>🔗 Endpoints</h2>
      <ul>
        <li><code>POST /screenshot</code> - Capture unique (JSON body)</li>
        <li><code>GET /screenshot</code> - Capture unique (URL params)</li>
        <li><code>GET /test</code> - Test de connexion</li>
        <li><code>GET /health</code> - État du serveur</li>
      </ul>
      
      <h2>📝 Exemple Make.com</h2>
      <pre>
POST /screenshot
Content-Type: application/json

{
  "videoUrl": "https://example.com/video.mp4",
  "timestamp": 5,
  "returnBase64": true
}
      </pre>
      
      <h2>🔧 Paramètres acceptés</h2>
      <ul>
        <li><strong>URL vidéo:</strong> videoUrl, video_url, url, video, link, videoLink</li>
        <li><strong>Timestamp:</strong> timestamp, time, seconds, sec, t</li>
        <li><strong>Base64:</strong> returnBase64, return_base64, base64, asBase64</li>
      </ul>
    </div>
  `);
});

// Nettoyage automatique
setInterval(() => {
  console.log('🧹 Nettoyage automatique...');
  exec('find /tmp -name "input-*.mp4" -mmin +10 -delete', () => {});
  exec('find /tmp -name "output-*.jpg" -mmin +10 -delete', () => {});
  
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

// Configuration serveur HTTP
server.timeout = TIMEOUTS.REQUEST_TIMEOUT;
server.headersTimeout = TIMEOUTS.REQUEST_TIMEOUT + 5000;
server.requestTimeout = TIMEOUTS.REQUEST_TIMEOUT;
server.keepAliveTimeout = 5000;
