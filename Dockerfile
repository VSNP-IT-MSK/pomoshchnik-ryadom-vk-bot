FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY assets ./assets
COPY index.js server.js brand-guidelines.md ./

EXPOSE 3000
CMD ["node", "server.js"]
