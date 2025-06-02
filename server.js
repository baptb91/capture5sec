const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post('/screenshot', async (req, res) => {
  const { videoUrl } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

  const inputPath = '/tmp/input.mp4';
  const outputPath = '/tmp/output.jpg';

  try {
    // Télécharge la vidéo temporairement
    const writer = fs.createWriteStream(inputPath);
    const response = await axios({ method: 'get', url: videoUrl, responseType: 'stream' });
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Extrait une image à 5 secondes
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -ss 00:00:05 -i ${inputPath} -frames:v 1 ${outputPath} -y`, (error, stdout, stderr) => {
        if (error) return reject(stderr);
        resolve();
      });
    });

    // Envoie l'image extraite
    res.setHeader('Content-Type', 'image/jpeg');
    fs.createReadStream(outputPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  } finally {
    // Nettoyage
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
});

app.get('/', (req, res) => res.send('FFmpeg Screenshot API is running!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
