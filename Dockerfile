FROM node:24-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/tsconfig*.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/src ./src
COPY frontend/public ./public
RUN npm run build

FROM python:3.12-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp
WORKDIR /app/backend
COPY backend/requirements-runtime.txt /tmp/requirements-runtime.txt
RUN pip install --no-cache-dir -r /tmp/requirements-runtime.txt
COPY backend/app ./app
COPY backend/migrations ./migrations
COPY --from=frontend /build/dist /app/frontend/dist
RUN mkdir -p /data
# Root bootstrap only fixes /data ownership, then drops to uid/gid 10001.
# Never run Uvicorn directly: this entrypoint rejects missing preview settings.
CMD ["python", "-m", "app.preview"]
