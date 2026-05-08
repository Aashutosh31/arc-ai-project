FROM node:20-bullseye-slim

ENV NODE_ENV=production
# Prevent puppeteer from downloading its own Chromium - we install system chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# Default path - entrypoint will detect the real binary and override if necessary
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_ARGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu --disable-extensions"

WORKDIR /app

# Install minimal dependencies required to run Chromium in a Debian slim image
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    wget \
    gnupg \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcb-dri3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libglib2.0-0 \
    libfontconfig1 \
    chromium \
    chromium-driver \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY . ./

EXPOSE 5000

# Entry point will detect actual Chromium binary and set env vars for Puppeteer
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh || true

ENTRYPOINT ["sh","/app/docker-entrypoint.sh"]
CMD ["node","index.js"]
