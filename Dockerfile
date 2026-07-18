FROM node:22-alpine AS pwa
WORKDIR /pwa
COPY pwa/package.json ./
RUN npm install
COPY pwa/ ./
RUN npm run build

FROM python:3.14-slim
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
ENV PATH="/app/.venv/bin:$PATH"
COPY server/ ./
COPY --from=pwa /pwa/dist ./static
ENV DB_PATH=/data/split.db
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
