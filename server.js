const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
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

  // Générer des chemins uniques pour chaque requête
  const id = uuidv4();
  const inputPath = `/tmp/input-${id}.mp4`;
  const outputPattern = `/tmp/output-${id}-%d.jpg`;
  const outputPath = `/tmp/output-${id}-1.jpg`;

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
    const stats = fs.statSync(inputPath);
    console.log(`[${id}] Vidéo téléchargée :`, inputPath, 'Taille :', stats.size, 'octets');

    // Extraire une image à 5 secondes
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -ss 00:00:05 -i ${inputPath} -frames:v 1 ${outputPattern} -y`,
        (error, stdout, stderr) => {
          console.log(`[${id}] FFmpeg stdout:`, stdout);
          console.log(`[${id}] FFmpeg stderr:`, stderr);
          if (error) {
            console.error(`[${id}] Erreur FFmpeg:`, error);
            return reject(stderr || error.message);
          }
          resolve();
        }
      );
    });

    // Vérifier que l'image a bien été créée
    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'FFmpeg n\'a pas créé l\'image de sortie.' });
    }
    const imgStats = fs.statSync(outputPath);
    console.log(`[${id}] Image extraite :`, outputPath, 'Taille :', imgStats.size, 'octets');

    // Envoyer l'image extraite puis nettoyer
    res.setHeader('Content-Type', 'image/jpeg');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      console.log(`[${id}] Fichiers temporaires supprimés.`);
    });
    stream.on('error', (err) => {
      console.error(`[${id}] Erreur stream:`, err);
      res.status(500).end();
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    });
    return; // On sort pour ne pas passer dans le catch
  } catch (err) {
    console.error('Erreur:', err);
    res.status(500).json({ error: err.toString() });
    // Nettoyage en cas d'erreur
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
});

app.get('/', (req, res) => res.send('FFmpeg Screenshot API is running!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
