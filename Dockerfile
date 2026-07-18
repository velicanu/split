FROM node:22-alpine AS pwa
WORKDIR /pwa
COPY pwa/package.json ./
RUN npm install
COPY pwa/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ ./
COPY --from=pwa /pwa/dist ./static
ENV DB_PATH=/data/split.db
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
