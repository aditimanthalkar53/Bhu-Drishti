# Bhu-Drishti in ONE container: website + API (Node) + AEQE engine (Python).
#   docker build -t bhu-drishti . && docker run -p 7860:7860 bhu-drishti   →  http://localhost:7860
# Runs as-is on Hugging Face Spaces (free Docker Space, port 7860). See DEPLOY.md.

# ---------- website
FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- API
FROM node:22-bookworm-slim AS api
WORKDIR /src
COPY backend/package*.json backend/tsconfig.json ./
RUN npm ci
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime: Python for the engine, plus the Node binary for the API
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 NODE_ENV=production
# rasterio/GDAL wheels need libexpat at runtime; slim images do not ship it
# (APT_FLAGS="-o Acquire::Check-Date=false" helps only on a machine whose clock is behind; leave empty normally)
ARG APT_FLAGS=""
RUN apt-get $APT_FLAGS update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

# Hugging Face Spaces runs containers as uid 1000; use the same user everywhere
RUN useradd --create-home --uid 1000 user
WORKDIR /home/user/app

COPY engine/requirements.txt engine/requirements-real.txt engine/
RUN pip install -r engine/requirements.txt -r engine/requirements-real.txt

COPY --chown=user engine/aeqe engine/aeqe
COPY --chown=user --from=api /src/dist backend/dist
COPY --chown=user --from=api /src/node_modules backend/node_modules
COPY --chown=user --from=api /src/package.json backend/package.json
COPY --chown=user --from=web /src/dist web
COPY --chown=user start.sh start.sh
RUN chmod 755 start.sh && mkdir -p /home/user/data && chown user /home/user/data

USER user
ENV PORT=7860 DATA_DIR=/home/user/data
EXPOSE 7860
VOLUME /home/user/data
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["./start.sh"]
