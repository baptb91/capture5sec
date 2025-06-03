# Utiliser une image Node.js avec FFmpeg pré-installé
FROM node:20-bullseye-slim

# Installer FFmpeg et les dépendances système nécessaires
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Créer le répertoire de l'application
WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./

# Installer les dépendances Node.js - CORRECTION ICI
RUN npm install --only=production && npm cache clean --force

# Copier le code source
COPY . .

# Créer le répertoire temp avec les bonnes permissions
RUN mkdir -p /tmp && chmod 777 /tmp

# Exposer le port
EXPOSE 10000

# Variables d'environnement
ENV NODE_ENV=production
ENV PORT=10000

# Vérifier que FFmpeg est installé
RUN ffmpeg -version

# Utilisateur non-root pour la sécurité
RUN groupadd -r appuser && useradd -r -g appuser appuser
RUN chown -R appuser:appuser /app /tmp
USER appuser

# Commande de démarrage
CMD ["node", "server.js"]
