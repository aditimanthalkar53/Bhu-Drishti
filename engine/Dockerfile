FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 AEQE_DATA_DIR=/data
# rasterio/GDAL wheels need libexpat at runtime; slim images do not ship it
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt requirements-real.txt ./
ARG WITH_REAL_DATA=true
RUN pip install --no-cache-dir -r requirements.txt && \
    if [ "$WITH_REAL_DATA" = "true" ]; then pip install --no-cache-dir -r requirements-real.txt; fi
COPY aeqe ./aeqe
COPY bench ./bench
COPY scripts ./scripts
# the engine runs as the unprivileged user 'aeqe' (docker-entrypoint.sh drops root after fixing /data ownership);
# /data holds saved jobs, traces and the tile cache (a named volume)
RUN groupadd --system --gid 10001 aeqe && useradd --system --uid 10001 --gid 10001 --home-dir /app aeqe && mkdir -p /data && chown 10001:10001 /data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "aeqe.server:app", "--host", "0.0.0.0", "--port", "8000"]
