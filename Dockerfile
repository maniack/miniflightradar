# === Stage 1: Build frontend ===
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

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
COPY app/ app/
COPY storage/ storage/
COPY security/ security/
COPY ui/ ui/
COPY cmd/ cmd/
COPY monitoring/ monitoring/

# Копируем собранный фронтенд
COPY --from=frontend-builder /app/frontend/build ui/build

# Собираем статический Go бинарник с использованием vendoring
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags "-s -w" -mod=vendor -o mini-flightradar ./cmd/miniflightradar

# === Stage 3: Final image ===
FROM alpine:3.20
WORKDIR /app

# Устанавливаем CA сертификаты для HTTPS запросов (OpenSky API)
RUN apk add --no-cache ca-certificates

# Создаём директорию данных и пользователя без прав суперпользователя
RUN adduser -D -H -u 10001 appuser && \
    mkdir -p /app/data && \
    chown -R appuser:appuser /app

# Копируем только бинарник (статические файлы фронтенда уже вшиты в него)
COPY --from=backend-builder /app/mini-flightradar ./

# Экспонируем порт сервера и настраиваем том для данных
EXPOSE 8080
VOLUME ["/app/data"]

USER 10001:10001

# Команда запуска
CMD ["./mini-flightradar", "--listen", ":8080"]