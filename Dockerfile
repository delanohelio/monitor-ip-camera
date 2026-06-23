FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# ffmpeg is required to convert RTSP to HLS inside the container
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./

# Keep this step so future dependencies are installed automatically
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
