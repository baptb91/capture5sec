const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json({ limit: '50mb' }));

// File d'attente pour limiter le nombre de traitements simultanés
const processingQueue = new Map();
const MAX_CONCURRENT_PROCESSING = 3;

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
function waitForFile(filePath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let lastSize = 0;
    let stableCount = 0;
    
    const checkFile = () => {
      if (Date.now() - startTime > timeout) {
        return reject(new Error(`Timeout waiting for file: ${filePath}`));
      }
      
      if (!fs.existsSync(filePath)) {
        return setTimeout(checkFile, 100);
      }
      
      const stats = fs.statSync(filePath);
      if (stats.size === lastSize) {
        stableCount++;
        if (stableCount >= 3) { // Fichier stable pendant 300ms
          return resolve(stats);
        }
      } else {
        stableCount = 0;
        lastSize = stats.size;
      }
      
      setTimeout(checkFile, 100);
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
        console.log(`Fichier supprimé: ${file}`);
      }
    } catch (err) {
      console.error(`Erreur lors de la suppression de ${file}:`, err.message);
    }
  });
}

// Fonction pour extraire une capture d'écran
async function extractScreenshot(videoUrl, timestamp = 5, id = null) {
  const requestId = id || uuidv4();
  const inputPath = `/tmp/input-${requestId}.mp4`;
  const outputPath = `/tmp/output-${requestId}.jpg`;
  
  try {
    console.log(`[${requestId}] Début du traitement pour: ${videoUrl}`);
    
    // 1. Télécharger la vidéo
    console.log(`[${requestId}] Téléchargement de la vidéo...`);
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const writer = fs.createWriteStream(inputPath);
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      
      // Timeout pour le téléchargement
      setTimeout(() => reject(new Error('Timeout de téléchargement')), 60000);
    });
    
    // Vérifier que la vidéo est bien téléchargée
    const videoStats = fs.statSync(inputPath);
    console.log(`[${requestId}] Vidéo téléchargée: ${videoStats.size} octets`);
    
    if (videoStats.size === 0) {
      throw new Error('Fichier vidéo vide');
    }
    
    // 2. Extraire la capture d'écran avec FFmpeg
    console.log(`[${requestId}] Extraction de la capture à ${timestamp}s...`);
    
    const ffmpegCommand = [
      'ffmpeg',
      '-ss', `00:00:${timestamp.toString().padStart(2, '0')}`,
      '-i', `"${inputPath}"`,
      '-frames:v', '1',
      '-q:v', '2', // Meilleure qualité
      '-f', 'image2',
      `"${outputPath}"`,
      '-y' // Overwrite
    ].join(' ');
    
    await new Promise((resolve, reject) => {
      exec(ffmpegCommand, { timeout: 30000 }, (error, stdout, stderr) => {
        console.log(`[${requestId}] FFmpeg stdout:`, stdout);
        if (stderr) console.log(`[${requestId}] FFmpeg stderr:`, stderr);
        
        if (error) {
          console.error(`[${requestId}] Erreur FFmpeg:`, error.message);
          return reject(new Error(`FFmpeg error: ${error.message}`));
        }
        resolve();
      });
    });
    
    // 3. Attendre que le fichier soit complètement écrit
    console.log(`[${requestId}] Attente de la finalisation du fichier...`);
    const imageStats = await waitForFile(outputPath);
    console.log(`[${requestId}] Image créée: ${imageStats.size} octets`);
    
    if (imageStats.size === 0) {
      throw new Error('Image générée vide');
    }
    
    // 4. Lire le fichier image
    const imageBuffer = fs.readFileSync(outputPath);
    
    // 5. Nettoyer les fichiers temporaires
    cleanupFiles([inputPath, outputPath]);
    
    return {
      success: true,
      image: imageBuffer,
      size: imageBuffer.length,
      requestId
    };
    
  } catch (error) {
    console.error(`[${requestId}] Erreur:`, error.message);
    
    // Nettoyer en cas d'erreur
    cleanupFiles([inputPath, outputPath]);
    
    throw error;
  }
}

// Endpoint principal pour les captures d'écran
app.post('/screenshot', async (req, res) => {
  const { videoUrl, timestamp = 5 } = req.body;
  const requestId = uuidv4();
  
  if (!videoUrl) {
    return res.status(400).json({ 
      error: 'videoUrl is required',
      requestId 
    });
  }
  
  // Vérifier la file d'attente
  if (processingQueue.size >= MAX_CONCURRENT_PROCESSING) {
    return res.status(429).json({
      error: 'Trop de requêtes en cours, réessayez plus tard',
      requestId
    });
  }
  
  processingQueue.set(requestId, Date.now());
  
  try {
    const result = await extractScreenshot(videoUrl, timestamp, requestId);
    
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', result.size);
    res.setHeader('X-Request-ID', requestId);
    
    res.send(result.image);
    
    console.log(`[${requestId}] Capture envoyée avec succès`);
    
  } catch (error) {
    console.error(`[${requestId}] Erreur finale:`, error.message);
    
    if (!res.headersSent) {
      res.status(500).json({
        error: error.message,
        requestId
      });
    }
  } finally {
    processingQueue.delete(requestId);
  }
});

// Endpoint pour traitement par lots
app.post('/batch-screenshot', async (req, res) => {
  const { videos, timestamp = 5 } = req.body;
  const batchId = uuidv4();
  
  if (!Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({
      error: 'videos array is required',
      batchId
    });
  }
  
  if (videos.length > 10) {
    return res.status(400).json({
      error: 'Maximum 10 videos per batch',
      batchId
    });
  }
  
  console.log(`[${batchId}] Traitement par lots de ${videos.length} vidéos`);
  
  const results = [];
  
  // Traiter les vidéos séquentiellement pour éviter la surcharge
  for (let i = 0; i < videos.length; i++) {
    const videoUrl = videos[i];
    const requestId = `${batchId}-${i + 1}`;
    
    try {
      const result = await extractScreenshot(videoUrl, timestamp, requestId);
      results.push({
        index: i,
        videoUrl,
        success: true,
        image: result.image.toString('base64'),
        size: result.size
      });
    } catch (error) {
      results.push({
        index: i,
        videoUrl,
        success: false,
        error: error.message
      });
    }
    
    // Petite pause entre les traitements
    if (i < videos.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  res.json({
    batchId,
    total: videos.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results
  });
});

// Endpoint de santé
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    processing: processingQueue.size,
    uptime: process.uptime()
  });
});

// Endpoint racine
app.get('/', (req, res) => {
  res.send('FFmpeg Screenshot API is running!');
});

// Gestion des erreurs globales
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Nettoyage périodique des fichiers temporaires
setInterval(() => {
  exec('find /tmp -name "input-*.mp4" -mtime +1 -delete', () => {});
  exec('find /tmp -name "output-*.jpg" -mtime +1 -delete', () => {});
}, 3600000); // Chaque heure

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Max concurrent processing: ${MAX_CONCURRENT_PROCESSING}`);
});
