FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Non-root: this container only ever receives HTTP payloads and never
# touches SQLite directly (§3.4) — no reason to run as root.
RUN useradd --create-home --shell /bin/false pdm
USER pdm

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
