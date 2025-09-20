# === Stage 1: Build frontend ===
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# Optional APM exporter URL for UI (build-time)
ARG REACT_APP_OTEL_EXPORTER_URL=""
ENV REACT_APP_OTEL_EXPORTER_URL=${REACT_APP_OTEL_EXPORTER_URL}

# Копируем package.json и package-lock.json
COPY frontend/package*.json ./
RUN npm ci

# Копируем исходники и билдим
COPY frontend/ ./
RUN npm run build

# === Stage 2: Build backend ===
FROM golang:1.24-alpine AS backend-builder
WORKDIR /app

# Копируем go.mod, go.sum и vendor для офлайн сборки
COPY go.mod go.sum ./
COPY vendor/ vendor/

# Копируем исходники
COPY backend/ backend/
COPY ui/ ui/
COPY cmd/ cmd/
COPY monitoring/ monitoring/

# Копируем собранный фронтенд
COPY --from=frontend-builder /app/frontend/build ui/build

# Собираем Go бинарник с использованием vendoring
RUN go build -mod=vendor -o mini-flightradar cmd/miniflightradar/main.go

# === Stage 3: Final image ===
FROM alpine:3.18
WORKDIR /app

# Копируем только бинарник (статические файлы фронтенда уже вшиты в него)
COPY --from=backend-builder /app/mini-flightradar ./

# Устанавливаем CA сертификаты для HTTPS запросов (OpenSky API)
RUN apk add --no-cache ca-certificates

# Экспонируем порт сервера
EXPOSE 8080

# Команда запуска
CMD ["./mini-flightradar", "--listen", ":8080"]