const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// Vérifier la présence de ffmpeg au démarrage
exec('which ffmpeg', (error, stdout, stderr) => {
  if (error || !stdout.trim()) {
    console.error('FFmpeg n\'est pas installé ou pas dans le PATH.');
    process.exit(1);
  } else {
    console.log('FFmpeg trouvé :', stdout.trim());
  }
});

app.post('/screenshot', async (req, res) => {
  const { videoUrl } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

  const inputPath = '/tmp/input.mp4';
  const outputPath = '/tmp/output.jpg';

  try {
    // Télécharger la vidéo
    const writer = fs.createWriteStream(inputPath);
    const response = await axios({ method: 'get', url: videoUrl, responseType: 'stream' });
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Vérifier que la vidéo est bien téléchargée
    if (!fs.existsSync(inputPath)) {
      return res.status(500).json({ error: 'Échec du téléchargement de la vidéo.' });
    }
    console.log('Vidéo téléchargée :', inputPath);

    // Extraire une image à 5 secondes
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -ss 00:00:05 -i ${inputPath} -frames:v 1 ${outputPath} -y`,
        (error, stdout, stderr) => {
          console.log('FFmpeg stdout:', stdout);
          console.log('FFmpeg stderr:', stderr);
          if (error) return reject(stderr || error.message);
          resolve();
        }
      );
    });

    // Vérifier que l'image a bien été créée
    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'FFmpeg n\'a pas créé l\'image de sortie.' });
    }
    console.log('Image extraite :', outputPath);

    // Envoyer l'image extraite
    res.setHeader('Content-Type', 'image/jpeg');
    fs.createReadStream(outputPath).pipe(res);
  } catch (err) {
    console.error('Erreur:', err);
    res.status(500).json({ error: err.toString() });
  } finally {
    // Nettoyage des fichiers temporaires
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
});

app.get('/', (req, res) => res.send('FFmpeg Screenshot API is running!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
