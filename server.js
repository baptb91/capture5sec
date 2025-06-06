// Ajoutez ces améliorations à votre server.js

// 1. Middleware CORS (ajoutez après les autres middlewares)
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

// 2. Endpoint de test simple (ajoutez avant l'endpoint /screenshot)
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

// 3. Amélioration de l'endpoint /screenshot pour debugging
app.post('/screenshot', async (req, res) => {
  const requestId = uuidv4();
  const requestStart = Date.now();
  
  // Log détaillé pour debugging Make
  console.log(`🎯 [${requestId}] Nouvelle requête Make`);
  console.log(`📝 [${requestId}] Headers:`, JSON.stringify(req.headers, null, 2));
  console.log(`📝 [${requestId}] Body:`, JSON.stringify(req.body, null, 2));
  console.log(`📝 [${requestId}] Query:`, JSON.stringify(req.query, null, 2));
  
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
    console.log(`⚙️ [${requestId}] Config:`, { videoUrl: videoUrl.substring(0, 50) + '...', timestamp, returnBase64 });
    
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
    console.error(`💥 [${requestId}] Stack:`, error.stack);
    
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: `Erreur serveur: ${error.message}`,
        requestId,
        timestamp: new Date().toISOString(),
        processingTime: totalTime,
        retryable: true,
        serverStats: processingQueue.getStats(),
        debugging: {
          errorType: 'GLOBAL_ERROR',
          stack: error.stack?.split('\n').slice(0, 3).join('\n')
        }
      });
    }
  }
});

// 4. Endpoint de diagnostic pour Make
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
