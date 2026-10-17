FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 AEQE_DATA_DIR=/data
COPY requirements.txt requirements-real.txt ./
ARG WITH_REAL_DATA=false
RUN pip install --no-cache-dir -r requirements.txt && \
    if [ "$WITH_REAL_DATA" = "true" ]; then pip install --no-cache-dir -r requirements-real.txt; fi
COPY aeqe ./aeqe
COPY bench ./bench
COPY scripts ./scripts
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "aeqe.server:app", "--host", "0.0.0.0", "--port", "8000"]
