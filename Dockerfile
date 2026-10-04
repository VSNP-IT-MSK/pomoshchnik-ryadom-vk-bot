FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# MAX's HTTPS certificate chain is issued by the Russian Trusted Root CA,
# which is not included in Debian's default CA bundle. Keep verification
# enabled while adding that public root certificate to Node's trust store.
COPY russian-trusted-root-ca.crt /usr/local/share/ca-certificates/russian-trusted-root-ca.crt
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

COPY package*.json ./
RUN npm ci --omit=dev

COPY assets ./assets
COPY index.js server.js brand-guidelines.md ./

EXPOSE 3000
CMD ["node", "server.js"]
