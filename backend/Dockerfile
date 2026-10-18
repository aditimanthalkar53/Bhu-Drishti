FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# the server runs as the unprivileged 'node' user (docker-entrypoint.sh drops root after fixing /data ownership);
# /data holds the SQLite database (a named volume)
RUN apk add --no-cache su-exec && mkdir -p /data && chown node:node /data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
EXPOSE 4000
CMD ["node", "dist/index.js"]
