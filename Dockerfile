# Imagen de Ndivepa.
#
# La versión anterior no arrancaba: copiaba `server.js` pero no `src/`, que es
# donde vive toda la aplicación desde la reestructuración, y tampoco instalaba
# dependencias, así que `graphql` faltaba. Aquí se corrige lo uno y lo otro, se
# ejecuta sin privilegios y se declara una sonda de vida.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=4300 \
    DATA_DIR=/app/data \
    SNAPSHOT_DIR=/app/backups/snapshots

WORKDIR /app

# Dependencias primero: mientras el manifiesto no cambie, esta capa se reutiliza.
# `npm ci` instala exactamente lo fijado en el lockfile y `--omit=dev` deja fuera
# lo que solo hace falta para desarrollar.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Código y activos. Cada ruta es explícita para que la imagen no arrastre
# `.git`, `data/` ni copias de seguridad locales.
COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY examples ./examples

# Volúmenes de datos con dueño `node`: el proceso no corre como root, así que
# necesita poder escribir el documento, los snapshots y las subidas.
RUN mkdir -p /app/data /app/exports /app/backups/snapshots /app/public/uploads \
    && chown -R node:node /app/data /app/exports /app/backups /app/public/uploads

USER node

EXPOSE 4300
VOLUME ["/app/data", "/app/exports", "/app/backups", "/app/public/uploads"]

# `/healthz` no toca el almacenamiento ni expone detalles internos.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4300)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
