FROM python:3.12.13-slim-trixie

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Non-root: this container only ever receives HTTP payloads and never
# touches SQLite directly (§3.4) — no reason to run as root.
#
# /app/artifacts is the pdm_artifacts volume mount point (§15.1/D51's
# bootstrap artifact store, written by training.py, read by model.py) —
# created and chowned to pdm here, before USER switches away from root, so
# Docker seeds a freshly-created named volume with pdm-owned permissions
# instead of the root:root a bare mkdir under a volume mount would leave.
RUN useradd --create-home --shell /bin/false pdm \
    && mkdir -p /app/artifacts \
    && chown pdm:pdm /app/artifacts
USER pdm

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=3)" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
