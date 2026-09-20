# Qwen-Image-2.1 test UI — ships the UI only, no model, no weights, no server.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 appuser

COPY app ./app
RUN chown -R appuser:appuser /app

USER appuser
EXPOSE 8080

# /api/config also reports whether the model server is reachable, so this
# healthcheck fails when the container is up but cannot see its backend.
HEALTHCHECK --interval=30s --timeout=6s --start-period=10s --retries=3 \
    CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/config', timeout=5).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
