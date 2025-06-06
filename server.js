const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// ⏱️ TIMEOUTS OPTIMISÉS POUR TRAITEMENT EN SÉRIE
const TIMEOUTS = {
  AXIOS_DOWNLOAD: 90000,         // 1.5 minutes (réduit drastiquement)
  DOWNLOAD_STREAM: 120000,       // 2 minutes max pour le stream
  FFMPEG_PROCESSING: 30000,      // 30 secondes pour FFmpeg
  FILE_WAIT: 15000,              // 15 secondes pour attendre fichier stable
  REQUEST_TIMEOUT: 300000,       // 5 minutes timeout total (réduit)
  CONNECTION_TIMEOUT: 10000,     // 10 secondes pour établir la connexion
  RESPONSE_TIMEOUT: 15000        // 15 secondes entre les chunks
};

// Configuration Express optimisée
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Middleware CORS pour Make
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Middleware optimisé pour le traitement en série
app.use((req, res, next) => {
  req.setTimeout(TIMEOUTS.REQUEST_TIMEOUT);
  res.setTimeout(TIMEOUTS.REQUEST_TIMEOUT);
  
  // Headers pour éviter la mise en cache
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`⏱️ Requête terminée en ${duration}ms`);
  });
  
  next();
});

// File d'attente optimisée pour le traitement en série
class OptimizedQueue {
  constructor(maxConcurrent = 1) { // UN SEUL traitement à la fois pour éviter la surcharge
    this.processing = new Set();
    this.maxConcurrent = maxConcurrent;
    this.stats = {
      processed: 0,
      errors: 0,
      totalTime: 0,
      avgTime: 0,
      lastProcessed: null
    };
  }
  
  canProcess() {
    return this.processing.size < this.maxConcurrent;
  }
  
  startProcessing(id) {
    this.processing.add(id);
    console.log(`🔄 [${id}] Début du traitement`);
  }
  
  finishProcessing(id, success = true, duration = 0) {
    this.processing.delete(id);
    this.stats.processed++;
    this.stats.totalTime += duration;
    this.stats.avgTime = Math.round(this.stats.totalTime / this.stats.processed);
    this.stats.lastProcessed = new Date().toISOString();
    
    if (!success) this.stats.errors++;
    
    console.log(`✅ [${id}] Fin (${success ? 'succès' : 'échec'}) - Moyenne: ${this.stats.avgTime}ms`);
  }
  
  getStats() {
    return {
      ...this.stats,
      currentLoad: this.processing.size,
      maxLoad: this.maxConcurrent,
      successRate: this.stats.processed > 0 ? 
        Math.round(((this.stats.processed - this.stats.errors) / this.stats.processed) * 100) : 0
    };
  }
}

const processingQueue = new OptimizedQueue(1); // UN SEUL traitement concurrent

// Vérification FFmpeg
exec('which ffmpeg', (error, stdout, stderr) => {
  if (error || !stdout.trim()) {
    console.error('❌ FFmpeg non trouvé. Installation requise.');
    process.exit(1);
  } else {
    console.log('✅ FFmpeg disponible:', stdout.trim());
  }
});

// Fonction pour attendre qu'un fichier soit stable (optimisée)
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
        return setTimeout(checkFile, 100); // Vérification plus rapide
      }
      
      try {
        const stats = fs.statSync(filePath);
        if (stats.size === lastSize && stats.size > 0) {
          stableCount++;
          if (stableCount >= 2) { // Stable pendant 200ms seulement
            return resolve(stats);
          }
        } else {
          stableCount = 0;
          lastSize = stats.size;
        }
      } catch (err) {
        // Fichier en cours d'écriture, continuer
      }
      
      setTimeout(checkFile, 100);
    };
    
    checkFile();
  });
}

// Nettoyage immédiat et synchrone
function cleanupFiles(files) {
  files.forEach(file => {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file); // Synchrone pour nettoyage immédiat
        console.log(`🗑️ Supprimé: ${path.basename(file)}`);
      }
    } catch (err) {
      console.error(`⚠️ Erreur suppression ${file}:`, err.message);
    }
  });
}

// Fonction de téléchargement ultra-optimisée
async function downloadVideo(videoUrl, outputPath, requestId) {
  return new Promise(async (resolve, reject) => {
    let downloadTimeout;
    let responseTimeout;
    let lastDataReceived = Date.now();
    let totalSize = 0;
    let writer;
    
    try {
      console.log(`📥 [${requestId}] Début téléchargement...`);
      
      // Configuration axios ultra-optimisée
      const axiosConfig = {
        method: 'GET',
        url: videoUrl,
        responseType: 'stream',
        timeout: TIMEOUTS.CONNECTION_TIMEOUT, // Court timeout de connexion
        maxRedirects: 3, // Réduit
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VideoProcessor/1.0)',
          'Accept': 'video/*,*/*;q=0.8',
          'Connection': 'close' // Évite les connexions persistantes
        },
        maxContentLength: 50 * 1024 * 1024, // 50MB max
        maxBodyLength: 50 * 1024 * 1024
      };
      
      const response = await axios(axiosConfig);
      writer = fs.createWriteStream(outputPath);
      
      // Timeout global de téléchargement
      downloadTimeout = setTimeout(() => {
        if (writer) writer.destroy();
        reject(new Error(`Timeout téléchargement global (${TIMEOUTS.DOWNLOAD_STREAM/1000}s)`));
      }, TIMEOUTS.DOWNLOAD_STREAM);
      
      // Timeout de réponse (pas de données reçues)
      const checkResponseTimeout = () => {
        responseTimeout = setTimeout(() => {
          if (Date.now() - lastDataReceived > TIMEOUTS.RESPONSE_TIMEOUT) {
            if (writer) writer.destroy();
            reject(new Error('Timeout - pas de données reçues'));
          } else {
            checkResponseTimeout();
          }
        }, TIMEOUTS.RESPONSE_TIMEOUT);
      };
      checkResponseTimeout();
      
      // Monitoring du téléchargement
      response.data.on('data', (chunk) => {
        lastDataReceived = Date.now();
        totalSize += chunk.length;
        
        // Log toutes les 5MB
        if (totalSize % (5 * 1024 * 1024) < chunk.length) {
          console.log(`📊 [${requestId}] ${Math.round(totalSize / 1024 / 1024)}MB`);
        }
      });
      
      response.data.on('end', () => {
        console.log(`✅ [${requestId}] Téléchargement terminé: ${Math.round(totalSize / 1024 / 1024)}MB`);
      });
      
      response.data.pipe(writer);
      
      writer.on('finish', () => {
        clearTimeout(downloadTimeout);
        clearTimeout(responseTimeout);
        resolve(totalSize);
      });
      
      writer.on('error', (err) => {
        clearTimeout(downloadTimeout);
        clearTimeout(responseTimeout);
        reject(err);
      });
      
    } catch (error) {
      clearTimeout(downloadTimeout);
      clearTimeout(responseTimeout);
      if (writer) writer.destroy();
      reject(new Error(`Erreur téléchargement: ${error.message}`));
    }
  });
}

// Fonction principale ultra-optimisée
async function extractScreenshot(videoUrl, timestamp = 5, id = null) {
  const requestId = id || uuidv4();
  const inputPath = `/tmp/input-${requestId}.mp4`;
  const outputPath = `/tmp/output-${requestId}.jpg`;
  const startTime = Date.now();
  
  try {
    console.log(`🚀 [${requestId}] URL: ${videoUrl.substring(0, 60)}...`);
    
    // 1. Téléchargement ultra-optimisé
    const downloadSize = await downloadVideo(videoUrl, inputPath, requestId);
    
    if (downloadSize < 1024) {
      throw new Error('Fichier vidéo trop petit ou corrompu');
    }
    
    console.log(`📁 [${requestId}] Fichier prêt: ${Math.round(downloadSize / 1024 / 1024)}MB`);
    
    // 2. Extraction FFmpeg ultra-rapide
    console.log(`🎬 [${requestId}] Extraction à ${timestamp}s...`);
    
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'panic', // Pas de logs du tout
      '-ss', `${timestamp}`,
      '-i', inputPath,
      '-frames:v', '1',
      '-q:v', '8', // Qualité réduite pour vitesse
      '-vf', 'scale=960:-1', // Résolution réduite
      '-f', 'image2',
      '-y',
      outputPath
    ];
    
    await new Promise((resolve, reject) => {
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'ignore', 'pipe']
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
          reject(new Error(`FFmpeg failed with code ${code}`));
        }
      });
      
      ffmpegProcess.on('error', (error) => {
        clearTimeout(ffmpegTimeout);
        reject(new Error(`FFmpeg spawn error: ${error.message}`));
      });
    });
    
    // 3. Lecture rapide du résultat
    const imageStats = await waitForFile(outputPath, 5000); // 5s max
    
    if (imageStats.size < 500) {
      throw new Error('Image générée trop petite');
    }
    
    const imageBuffer = fs.readFileSync(outputPath); // Synchrone pour rapidité
    
    // Nettoyage immédiat
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
    
    throw error;
  }
}

// Fonction pour extraire les paramètres
function extractParameters(req) {
  const params = {
    videoUrl: null,
    timestamp: 5,
    returnBase64: false
  };
  
  const sources = [req.body, req.query, req.params];
  
  for (const source of sources) {
    if (source) {
      const urlVariants = ['videoUrl', 'video_url', 'url', 'video', 'link', 'videoLink'];
      const timestampVariants = ['timestamp', 'time', 'seconds', 'sec', 't'];
      const base64Variants = ['returnBase64', 'return_base64', 'base64', 'asBase64'];
      
      if (!params.videoUrl) {
        for (const variant of urlVariants) {
          if (source[variant]) {
            params.videoUrl = source[variant];
            break;
          }
        }
      }
      
      for (const variant of timestampVariants) {
        if (source[variant] !== undefined) {
          const ts = parseFloat(source[variant]);
          if (!isNaN(ts) && ts >= 0) {
            params.timestamp = ts;
            break;
          }
        }
      }
      
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

// Endpoint de test simple pour Make
app.post('/test-make', (req, res) => {
  console.log('🧪 Test Make - Body reçu:', req.body);
  console.log('🧪 Test Make - Headers:', req.headers);
  
  res.json({
    success: true,
    message: 'Test Make réussi',
    receivedData: req.body,
    timestamp: new Date().toISOString(),
    requestId: uuidv4()
  });
});

// Endpoint principal optimisé pour traitement en série + Make
app.post('/screenshot', async (req, res) => {
  const requestId = uuidv4();
  const requestStart = Date.now();
  
  // Log détaillé pour debugging Make
  console.log(`🎯 [${requestId}] Nouvelle requête Make`);
  console.log(`📝 [${requestId}] Headers:`, JSON.stringify(req.headers, null, 2));
  console.log(`📝 [${requestId}] Body:`, JSON.stringify(req.body, null, 2));
  
  try {
    const { videoUrl, timestamp, returnBase64 } = extractParameters(req);
    
    // Validation plus stricte pour Make
    if (!videoUrl) {
      console.log(`❌ [${requestId}] videoUrl manquant`);
      return res.status(400).json({ 
        error: 'videoUrl required',
        requestId,
        success: false,
        receivedData: {
          body: req.body,
          query: req.query,
          params: req.params
        }
      });
    }
    
    // Log de la configuration extraite
    console.log(`⚙️ [${requestId}] Config:`, { 
      videoUrl: videoUrl.substring(0, 50) + '...', 
      timestamp, 
      returnBase64 
    });
    
    // Validation URL améliorée
    try {
      const urlObj = new URL(videoUrl);
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        throw new Error('Protocole non supporté');
      }
    } catch (urlError) {
      console.log(`❌ [${requestId}] URL invalide:`, urlError.message);
      return res.status(400).json({
        error: `URL invalide: ${urlError.message}`,
        requestId,
        success: false,
        providedUrl: videoUrl
      });
    }
    
    // Vérification de la charge avec plus de détails
    if (!processingQueue.canProcess()) {
      console.log(`⏸️ [${requestId}] Serveur occupé - Stats:`, processingQueue.getStats());
      return res.status(429).json({
        error: 'Serveur occupé, réessayez dans 10 secondes',
        requestId,
        success: false,
        retryAfter: 10,
        stats: processingQueue.getStats(),
        suggestion: 'Attendez quelques secondes avant de relancer la requête'
      });
    }
    
    processingQueue.startProcessing(requestId);
    
    // Traitement avec gestion d'erreur améliorée
    let result;
    try {
      result = await extractScreenshot(videoUrl, timestamp, requestId);
    } catch (extractError) {
      console.error(`💥 [${requestId}] Erreur extraction:`, extractError.message);
      processingQueue.finishProcessing(requestId, false, Date.now() - requestStart);
      
      // Classification des erreurs pour Make
      const isTimeout = extractError.message.includes('timeout') || extractError.message.includes('Timeout');
      const isConnection = extractError.message.includes('ECONNRESET') || extractError.message.includes('ENOTFOUND') || extractError.message.includes('ECONNREFUSED');
      const isFFmpegError = extractError.message.includes('FFmpeg');
      const isDownloadError = extractError.message.includes('téléchargement');
      
      const errorType = isTimeout ? 'TIMEOUT' : 
                       isConnection ? 'CONNECTION' :
                       isFFmpegError ? 'FFMPEG' :
                       isDownloadError ? 'DOWNLOAD' : 'UNKNOWN';
      
      const statusCode = isTimeout ? 408 : 
                        isConnection ? 502 :
                        extractError.message.includes('invalid') ? 400 : 500;
      
      return res.status(statusCode).json({
        success: false,
        error: extractError.message,
        errorType,
        requestId,
        timestamp: new Date().toISOString(),
        processingTime: Date.now() - requestStart,
        retryable: isTimeout || isConnection,
        serverStats: processingQueue.getStats(),
        debugging: {
          videoUrl: videoUrl.substring(0, 50) + '...',
          timestamp,
          serverLoad: processingQueue.getStats().currentLoad
        }
      });
    }
    
    processingQueue.finishProcessing(requestId, true, Date.now() - requestStart);
    
    const totalTime = Date.now() - requestStart;
    
    // Réponse optimisée pour Make
    if (returnBase64) {
      const response = {
        success: true,
        requestId,
        image: result.image.toString('base64'),
        size: result.size,
        mimeType: 'image/jpeg',
        timestamp: new Date().toISOString(),
        processingTime: totalTime,
        serverStats: processingQueue.getStats(),
        config: {
          videoUrl: videoUrl.substring(0, 50) + '...',
          timestamp,
          returnBase64
        }
      };
      
      console.log(`🚀 [${requestId}] Succès Make en ${totalTime}ms - Taille: ${result.size} bytes`);
      return res.json(response);
    } else {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', result.size);
      res.setHeader('X-Request-ID', requestId);
      res.setHeader('X-Success', 'true');
      res.setHeader('X-Processing-Time', totalTime);
      res.setHeader('X-Video-URL', videoUrl.substring(0, 50) + '...');
      console.log(`🚀 [${requestId}] Succès Make (image) en ${totalTime}ms`);
      return res.send(result.image);
    }
    
  } catch (error) {
    processingQueue.finishProcessing(requestId, false, Date.now() - requestStart);
    
    const totalTime = Date.now() - requestStart;
    console.error(`💥 [${requestId}] Erreur globale Make après ${totalTime}ms:`, error.message);
    
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: `Erreur serveur: ${error.message}`,
        requestId,
        timestamp: new Date().toISOString(),
        processingTime: totalTime,
        retryable: true,
        serverStats: processingQueue.getStats()
      });
    }
  }
});

// Health check optimisé
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
      download: TIMEOUTS.DOWNLOAD_STREAM / 1000 + 's',
      ffmpeg: TIMEOUTS.FFMPEG_PROCESSING / 1000 + 's'
    },
    optimizedForBatch: true,
    makeReady: true
  });
});

// Endpoint de diagnostic pour Make
app.get('/make-diagnostic', (req, res) => {
  const stats = processingQueue.getStats();
  const memoryUsage = process.memoryUsage();
  
  res.json({
    status: 'DIAGNOSTIC_MAKE',
    timestamp: new Date().toISOString(),
    server: {
      uptime: Math.round(process.uptime()),
      memory: {
        used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB'
      },
      processing: stats,
      canAcceptRequests: processingQueue.canProcess()
    },
    configuration: {
      maxConcurrent: 1,
      timeouts: {
        request: TIMEOUTS.REQUEST_TIMEOUT / 1000 + 's',
        download: TIMEOUTS.DOWNLOAD_STREAM / 1000 + 's',
        ffmpeg: TIMEOUTS.FFMPEG_PROCESSING / 1000 + 's'
      }
    },
    makeIntegration: {
      recommendedTimeout: '300 seconds',
      retryStatusCodes: [408, 429, 500, 502, 503, 504],
      bestPractices: [
        'Utilisez returnBase64: true pour Make',
        'Ajoutez un délai de 2-3s entre les requêtes',
        'Configurez le Resume avec les codes d\'erreur appropriés'
      ]
    }
  });
});

// Endpoint de test
app.get('/test', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Serveur optimisé pour traitement en série',
    timestamp: new Date().toISOString(),
    stats: processingQueue.getStats(),
    config: {
      maxConcurrent: 1,
      downloadTimeout: TIMEOUTS.DOWNLOAD_STREAM / 1000 + 's',
      ffmpegTimeout: TIMEOUTS.FFMPEG_PROCESSING / 1000 + 's'
    },
    makeIntegration: 'Ready'
  });
});

// Page d'accueil
app.get('/', (req, res) => {
  const stats = processingQueue.getStats();
  res.send(`
    <h1>🎬 FFmpeg Screenshot API - Optimisé Série + Make</h1>
    <div style="font-family: monospace; background: #f5f5f5; padding: 20px; border-radius: 8px;">
      <p><strong>🟢 Status:</strong> Opérationnel (traitement séquentiel + Make ready)</p>
      <p><strong>📊 Statistiques:</strong></p>
      <ul>
        <li>Traitées: ${stats.processed}</li>
        <li>Erreurs: ${stats.errors}</li>
        <li>Taux de succès: ${stats.successRate}%</li>
        <li>Temps moyen: ${stats.avgTime}ms</li>
        <li>En cours: ${stats.currentLoad}/${stats.maxLoad}</li>
      </ul>
      
      <p><strong>⚡ Optimisations:</strong></p>
      <ul>
        <li>Timeouts réduits (2min téléchargement, 30s FFmpeg)</li>
        <li>Un seul traitement concurrent</li>
        <li>Nettoyage immédiat des fichiers</li>
        <li>Qualité réduite pour vitesse</li>
        <li>Intégration Make optimisée</li>
      </ul>
      
      <p><strong>🔗 Usage Make:</strong></p>
      <pre>POST /screenshot
{
  "videoUrl": "https://example.com/video.mp4",
  "timestamp": 5,
  "returnBase64": true
}</pre>
      
      <p><strong>🧪 Test Make:</strong> <a href="/test-make">POST /test-make</a></p>
      <p><strong>🩺 Diagnostic:</strong> <a href="/make-diagnostic">/make-diagnostic</a></p>
    </div>
  `);
});

// Nettoyage automatique plus fréquent
setInterval(() => {
  console.log('🧹 Nettoyage automatique...');
  exec('find /tmp -name "input-*.mp4" -mmin +5 -delete', () => {});
  exec('find /tmp -name "output-*.jpg" -mmin +5 -delete', () => {});
  
  const stats = processingQueue.getStats();
  const memUsage = process.memoryUsage();
  console.log(`📊 Stats: ${stats.processed} traitées (${stats.successRate}% succès), RAM ${Math.round(memUsage.heapUsed/1024/1024)}MB`);
}, 300000); // Toutes les 5 minutes

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('💥 Exception non gérée:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Promesse rejetée:', reason);
});

// Force garbage collection plus fréquente
if (global.gc) {
  setInterval(() => {
    global.gc();
    console.log('🗑️ Garbage collection forcée');
  }, 120000); // Toutes les 2 minutes
}

// Démarrage du serveur
const server = app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`⚡ Optimisé pour traitement en série + Make:`);
  console.log(`   - Téléchargement: ${TIMEOUTS.DOWNLOAD_STREAM/1000} sec max`);
  console.log(`   - FFmpeg: ${TIMEOUTS.FFMPEG_PROCESSING/1000} sec max`);
  console.log(`   - Traitement séquentiel: 1 vidéo à la fois`);
  console.log(`   - Intégration Make: ✅ Prêt`);
  console.log(`✅ Prêt pour traitement en série + Make !`);
});

// Configuration serveur HTTP optimisée
server.timeout = TIMEOUTS.REQUEST_TIMEOUT;
server.headersTimeout = TIMEOUTS.REQUEST_TIMEOUT + 5000;
server.requestTimeout = TIMEOUTS.REQUEST_TIMEOUT;
server.keepAliveTimeout = 2000; // Connexions courtes
