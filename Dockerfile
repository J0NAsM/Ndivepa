FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
COPY scripts ./scripts
COPY examples ./examples
COPY iniciar-ndivepa.ps1 ./iniciar-ndivepa.ps1
RUN mkdir -p /app/data /app/exports /app/backups /app/public/uploads
EXPOSE 4300
VOLUME ["/app/data", "/app/exports", "/app/backups", "/app/public/uploads"]
CMD ["node", "server.js"]
