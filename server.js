const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// ⏱️ TIMEOUTS MAXIMAUX CONFIGURÉS
const TIMEOUTS = {
  AXIOS_DOWNLOAD: 300000,        // 5 minutes pour télécharger
  AXIOS_RESPONSE: 600000,        // 10 minutes timeout total axios
  FILE_WAIT: 60000,              // 1 minute pour attendre fichier stable
  FFMPEG_PROCESSING: 180000,     // 3 minutes pour FFmpeg
  DOWNLOAD_STREAM: 600000,       // 10 minutes pour le stream de téléchargement
  REQUEST_TIMEOUT: 900000,       // 15 minutes timeout total par requête
  BATCH_DELAY: 2000              // 2 secondes entre chaque vidéo en batch
};

// Configuration Express avec timeouts maximaux
app.use(express.json({ limit: '50mb' }));

// Augmenter les timeouts du serveur
app.use((req, res, next) => {
  // Timeout de 15 minutes par requête
  req.setTimeout(TIMEOUTS.REQUEST_TIMEOUT);
  res.setTimeout(TIMEOUTS.REQUEST_TIMEOUT);
  next();
});

// File d'attente pour limiter le nombre de traitements simultanés
const processingQueue = new Map();
const MAX_CONCURRENT_PROCESSING = 2; // Réduit pour éviter surcharge

// Vérifier la présence de ffmpeg au démarrage
exec('which ffmpeg', (error, stdout, stderr) => {
  if (error || !stdout.trim()) {
    console.error('FFmpeg n\'est pas installé ou pas dans le PATH.');
    process.exit(1);
  } else {
    console.log('FFmpeg trouvé :', stdout.trim());
  }
});

// Fonction utilitaire pour attendre qu'un fichier existe et soit stable
function waitForFile(filePath, timeout = TIMEOUTS.FILE_WAIT) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let lastSize = 0;
    let stableCount = 0;
    
    const checkFile = () => {
      if (Date.now() - startTime > timeout) {
        return reject(new Error(`Timeout waiting for file: ${filePath} (${timeout/1000}s)`));
      }
      
      if (!fs.existsSync(filePath)) {
        return setTimeout(checkFile, 500); // Vérification moins fréquente
      }
      
      const stats = fs.statSync(filePath);
      if (stats.size === lastSize) {
        stableCount++;
        if (stableCount >= 5) { // Fichier stable pendant 2.5s
          return resolve(stats);
        }
      } else {
        stableCount = 0;
        lastSize = stats.size;
      }
      
      setTimeout(checkFile, 500);
    };
    
    checkFile();
  });
}

// Fonction pour nettoyer les fichiers temporaires
function cleanupFiles(files) {
  files.forEach(file => {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log(`✅ Fichier supprimé: ${file}`);
      }
    } catch (err) {
      console.error(`❌ Erreur lors de la suppression de ${file}:`, err.message);
    }
  });
}

// Fonction pour extraire une capture d'écran avec timeouts maximaux
async function extractScreenshot(videoUrl, timestamp = 5, id = null) {
  const requestId = id || uuidv4();
  const inputPath = `/tmp/input-${requestId}.mp4`;
  const outputPath = `/tmp/output-${requestId}.jpg`;
  
  try {
    console.log(`🚀 [${requestId}] Début du traitement pour: ${videoUrl}`);
    console.log(`⏱️ [${requestId}] Timeouts configurés: Download=${TIMEOUTS.AXIOS_DOWNLOAD/1000}s, FFmpeg=${TIMEOUTS.FFMPEG_PROCESSING/1000}s`);
    
    // 1. Télécharger la vidéo avec timeout maximal
    console.log(`📥 [${requestId}] Téléchargement de la vidéo...`);
    
    const axiosConfig = {
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      timeout: TIMEOUTS.AXIOS_DOWNLOAD,
      maxRedirects: 10,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'video/mp4,video/*,*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      },
      // Configuration pour gérer les gros fichiers
      maxContentLength: 500 * 1024 * 1024, // 500MB max
      maxBodyLength: 500 * 1024 * 1024
    };
    
    const response = await axios(axiosConfig);
    
    const writer = fs.createWriteStream(inputPath);
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      let downloadTimeout;
      
      writer.on('finish', () => {
        clearTimeout(downloadTimeout);
        resolve();
      });
      
      writer.on('error', (err) => {
        clearTimeout(downloadTimeout);
        reject(err);
      });
      
      // Timeout pour le téléchargement du stream
      downloadTimeout = setTimeout(() => {
        writer.destroy();
        reject(new Error(`Timeout de téléchargement stream (${TIMEOUTS.DOWNLOAD_STREAM/1000}s)`));
      }, TIMEOUTS.DOWNLOAD_STREAM);
      
      // Log du progrès de téléchargement
      let bytesWritten = 0;
      writer.on('pipe', () => {
        const interval = setInterval(() => {
          if (fs.existsSync(inputPath)) {
            const currentSize = fs.statSync(inputPath).size;
            if (currentSize > bytesWritten) {
              console.log(`📊 [${requestId}] Téléchargé: ${(currentSize / 1024 / 1024).toFixed(2)} MB`);
              bytesWritten = currentSize;
            }
          }
        }, 5000); // Log toutes les 5 secondes
        
        writer.on('finish', () => clearInterval(interval));
        writer.on('error', () => clearInterval(interval));
      });
    });
    
    // Attendre que la vidéo soit complètement écrite
    console.log(`⏳ [${requestId}] Attente de la finalisation de la vidéo...`);
    await waitForFile(inputPath, TIMEOUTS.FILE_WAIT);
    
    // Vérifier que la vidéo est bien téléchargée
    const videoStats = fs.statSync(inputPath);
    console.log(`✅ [${requestId}] Vidéo téléchargée: ${(videoStats.size / 1024 / 1024).toFixed(2)} MB`);
    
    if (videoStats.size === 0) {
      throw new Error('Fichier vidéo vide');
    }
    
    // 2. Extraire la capture d'écran avec FFmpeg et timeout maximal
    console.log(`🎬 [${requestId}] Extraction de la capture à ${timestamp}s...`);
    
    // Commande FFmpeg optimisée avec options robustes
    const ffmpegCommand = [
      'ffmpeg',
      '-hide_banner',
      '-loglevel', 'warning',
      '-ss', `${timestamp}`,
      '-i', `"${inputPath}"`,
      '-frames:v', '1',
      '-q:v', '2', // Meilleure qualité
      '-vf', 'scale=1920:-1', // Redimensionner si nécessaire
      '-f', 'image2',
      `"${outputPath}"`,
      '-y' // Overwrite
    ].join(' ');
    
    console.log(`🔧 [${requestId}] Commande FFmpeg: ${ffmpegCommand}`);
    
    await new Promise((resolve, reject) => {
      const ffmpegProcess = exec(ffmpegCommand, { 
        timeout: TIMEOUTS.FFMPEG_PROCESSING,
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
      }, (error, stdout, stderr) => {
        if (stdout) console.log(`📋 [${requestId}] FFmpeg stdout:`, stdout);
        if (stderr) console.log(`⚠️ [${requestId}] FFmpeg stderr:`, stderr);
        
        if (error) {
          console.error(`❌ [${requestId}] Erreur FFmpeg:`, error.message);
          return reject(new Error(`FFmpeg error: ${error.message}`));
        }
        resolve();
      });
      
      // Log du progrès FFmpeg
      ffmpegProcess.on('spawn', () => {
        console.log(`🔄 [${requestId}] Processus FFmpeg démarré (PID: ${ffmpegProcess.pid})`);
      });
    });
    
    // 3. Attendre que le fichier image soit complètement écrit
    console.log(`⏳ [${requestId}] Attente de la finalisation de l'image...`);
    const imageStats = await waitForFile(outputPath, TIMEOUTS.FILE_WAIT);
    console.log(`✅ [${requestId}] Image créée: ${(imageStats.size / 1024).toFixed(2)} KB`);
    
    if (imageStats.size === 0) {
      throw new Error('Image générée vide');
    }
    
    // 4. Lire le fichier image
    const imageBuffer = fs.readFileSync(outputPath);
    
    // 5. Nettoyer les fichiers temporaires
    console.log(`🧹 [${requestId}] Nettoyage des fichiers temporaires...`);
    cleanupFiles([inputPath, outputPath]);
    
    console.log(`🎉 [${requestId}] Traitement terminé avec succès !`);
    
    return {
      success: true,
      image: imageBuffer,
      size: imageBuffer.length,
      requestId,
      processingTime: Date.now() - (processingQueue.get(requestId) || Date.now())
    };
    
  } catch (error) {
    console.error(`💥 [${requestId}] Erreur:`, error.message);
    
    // Nettoyer en cas d'erreur
    cleanupFiles([inputPath, outputPath]);
    
    throw error;
  }
}

// Endpoint principal pour les captures d'écran
app.post('/screenshot', async (req, res) => {
  const { videoUrl, timestamp = 5, returnBase64 = false } = req.body;
  const requestId = uuidv4();
  
  console.log(`🎯 [${requestId}] Nouvelle requête depuis Make.com pour: ${videoUrl}`);
  console.log(`⏱️ [${requestId}] Timeout configuré: ${TIMEOUTS.REQUEST_TIMEOUT/1000/60} minutes`);
  
  if (!videoUrl) {
    return res.status(400).json({ 
      error: 'videoUrl is required',
      requestId,
      success: false
    });
  }
  
  // Vérifier la file d'attente
  if (processingQueue.size >= MAX_CONCURRENT_PROCESSING) {
    console.log(`⏸️ [${requestId}] File d'attente pleine (${processingQueue.size}/${MAX_CONCURRENT_PROCESSING})`);
    return res.status(429).json({
      error: 'Trop de requêtes en cours, réessayez plus tard',
      requestId,
      success: false,
      retryAfter: 60,
      queueSize: processingQueue.size
    });
  }
  
  processingQueue.set(requestId, Date.now());
  console.log(`📋 [${requestId}] Ajouté à la file d'attente (${processingQueue.size}/${MAX_CONCURRENT_PROCESSING})`);
  
  try {
    const result = await extractScreenshot(videoUrl, timestamp, requestId);
    
    // Pour Make.com, on peut retourner soit l'image directement, soit en base64
    if (returnBase64) {
      res.json({
        success: true,
        requestId,
        image: result.image.toString('base64'),
        size: result.size,
        mimeType: 'image/jpeg',
        timestamp: new Date().toISOString(),
        processingTime: result.processingTime
      });
    } else {
      // Retour direct de l'image (pour téléchargement)
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', result.size);
      res.setHeader('X-Request-ID', requestId);
      res.setHeader('X-Success', 'true');
      res.setHeader('X-Processing-Time', result.processingTime);
      
      res.send(result.image);
    }
    
    console.log(`🚀 [${requestId}] Capture envoyée avec succès à Make.com (${result.processingTime}ms)`);
    
  } catch (error) {
    console.error(`💥 [${requestId}] Erreur finale:`, error.message);
    
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message,
        requestId,
        timestamp: new Date().toISOString(),
        troubleshooting: {
          message: "Si l'erreur persiste, vérifiez la qualité de la connexion internet et la validité de l'URL vidéo",
          timeouts: TIMEOUTS
        }
      });
    }
  } finally {
    processingQueue.delete(requestId);
    console.log(`🏁 [${requestId}] Retiré de la file d'attente`);
  }
});

// Endpoint pour traitement par lots avec timeouts maximaux
app.post('/batch-screenshot', async (req, res) => {
  const { videos, timestamp = 5 } = req.body;
  const batchId = uuidv4();
  
  if (!Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({
      error: 'videos array is required',
      batchId
    });
  }
  
  if (videos.length > 5) { // Réduit pour éviter timeouts
    return res.status(400).json({
      error: 'Maximum 5 videos per batch (réduit pour éviter les timeouts)',
      batchId
    });
  }
  
  console.log(`📦 [${batchId}] Traitement par lots de ${videos.length} vidéos`);
  console.log(`⏱️ [${batchId}] Délai entre vidéos: ${TIMEOUTS.BATCH_DELAY/1000}s`);
  
  const results = [];
  
  // Traiter les vidéos séquentiellement pour éviter la surcharge
  for (let i = 0; i < videos.length; i++) {
    const videoUrl = videos[i];
    const requestId = `${batchId}-${i + 1}`;
    
    console.log(`🎯 [${requestId}] Traitement vidéo ${i + 1}/${videos.length}`);
    
    try {
      const result = await extractScreenshot(videoUrl, timestamp, requestId);
      results.push({
        index: i,
        videoUrl,
        success: true,
        image: result.image.toString('base64'),
        size: result.size,
        processingTime: result.processingTime
      });
      console.log(`✅ [${requestId}] Succès`);
    } catch (error) {
      console.error(`❌ [${requestId}] Échec:`, error.message);
      results.push({
        index: i,
        videoUrl,
        success: false,
        error: error.message
      });
    }
    
    // Pause entre les traitements
    if (i < videos.length - 1) {
      console.log(`⏸️ [${batchId}] Pause de ${TIMEOUTS.BATCH_DELAY/1000}s avant la prochaine vidéo...`);
      await new Promise(resolve => setTimeout(resolve, TIMEOUTS.BATCH_DELAY));
    }
  }
  
  console.log(`🏁 [${batchId}] Batch terminé: ${results.filter(r => r.success).length}/${videos.length} succès`);
  
  res.json({
    batchId,
    total: videos.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
    timeouts: TIMEOUTS
  });
});

// Endpoint de santé amélioré
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    processing: {
      current: processingQueue.size,
      max: MAX_CONCURRENT_PROCESSING
    },
    uptime: process.uptime(),
    timeouts: TIMEOUTS,
    memory: process.memoryUsage()
  });
});

// Endpoint racine
app.get('/', (req, res) => {
  res.send(`
    <h1>🎬 FFmpeg Screenshot API</h1>
    <p><strong>Status:</strong> Running with MAXIMUM TIMEOUTS</p>
    <ul>
      <li>Download timeout: ${TIMEOUTS.AXIOS_DOWNLOAD/1000/60} minutes</li>
      <li>FFmpeg timeout: ${TIMEOUTS.FFMPEG_PROCESSING/1000/60} minutes</li>
      <li>Total request timeout: ${TIMEOUTS.REQUEST_TIMEOUT/1000/60} minutes</li>
    </ul>
    <p><strong>Queue:</strong> ${processingQueue.size}/${MAX_CONCURRENT_PROCESSING}</p>
    <p><a href="/health">Health Check</a></p>
  `);
});

// Gestion des erreurs globales
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Nettoyage périodique des fichiers temporaires (plus fréquent)
setInterval(() => {
  console.log('🧹 Nettoyage périodique des fichiers temporaires...');
  exec('find /tmp -name "input-*.mp4" -mmin +30 -delete', () => {}); // 30 min au lieu de 1 jour
  exec('find /tmp -name "output-*.jpg" -mmin +30 -delete', () => {});
}, 1800000); // Toutes les 30 minutes

// Configuration du serveur avec timeout maximal
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`⏱️ Max timeouts configured:`);
  console.log(`   - Download: ${TIMEOUTS.AXIOS_DOWNLOAD/1000/60} minutes`);
  console.log(`   - FFmpeg: ${TIMEOUTS.FFMPEG_PROCESSING/1000/60} minutes`);
  console.log(`   - Total request: ${TIMEOUTS.REQUEST_TIMEOUT/1000/60} minutes`);
  console.log(`📋 Max concurrent processing: ${MAX_CONCURRENT_PROCESSING}`);
});

// Configuration timeout serveur HTTP
server.timeout = TIMEOUTS.REQUEST_TIMEOUT; // 15 minutes
server.headersTimeout = TIMEOUTS.REQUEST_TIMEOUT + 5000; // 15 minutes + 5s
server.requestTimeout = TIMEOUTS.REQUEST_TIMEOUT; // 15 minutes

console.log(`⏱️ Server HTTP timeouts configured: ${server.timeout/1000/60} minutes`);
