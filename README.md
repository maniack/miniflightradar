# Mini Flightradar PWA

Простой демонстрационный сервис для отслеживания рейсов через OpenSky API: backend на Go + PWA фронтенд (React), метрики Prometheus и трассировка OpenTelemetry.

## Требования

- Go 1.22+
- Node.js 20+
- Docker (опционально)

## Быстрый старт (Go)

Рекомендуется: собрать всё через Makefile (включая фронтенд) и запустить:

```bash
make all
./bin/mini-flightradar --listen ":8080"
```

Либо собрать вручную (сначала фронтенд, затем бинарник; статика будет вшита в бинарник):

```bash
make build-ui
go build -mod=vendor -o bin/mini-flightradar ./cmd/miniflightradar
./bin/mini-flightradar --listen ":8080"
```

После запуска фронтенд доступен на http://localhost:8080

## Сборка через Makefile

```bash
make all              # соберёт backend и фронтенд, разместит бинарник в bin/
./bin/mini-flightradar --listen ":8080"
```

Полезные цели:
- make build-backend — сборка Go пакетов (использует vendoring)
- make build-ui — сборка фронтенда (CRA) в ui/build
- make clean — очистка артефактов

## Сборка и запуск через Docker

```bash
docker build -t mini-flightradar .
docker run --rm -p 8080:8080 --name minifr mini-flightradar
```

Контейнер слушает на 8080. Статика фронтенда встроена в бинарник; в итоговый образ копируется только исполняемый файл.

## Переменные окружения и флаги

- --listen или LISTEN — адрес для HTTP-сервера (по умолчанию :8080)
- --enable-metrics — включить экспонирование метрик Prometheus (по умолчанию true), доступны на /metrics
- --tracing-endpoint или OTEL_ENDPOINT — адрес OTEL-коллектора для отправки трейсинга (опционально)

## Что есть внутри

- /api/flight?callsign=ABC123 — демо-эндпоинт (заглушка), который фильтрует рейсы по позывному
- /metrics — метрики Prometheus (если включено)
- PWA фронтенд на React (OpenLayers карта)

## UI/UX

- Управляющие элементы расположены поверх карты (по центру сверху), как в Google Maps.
- В правом нижнем углу — вертикальная колонка кнопок: центрирование по текущему местоположению и переключатель темы (иконки Font Awesome). Карта автоматически центрируется на вас при старте (после разрешения геолокации в браузере), а также по нажатию кнопки.
- Кнопки зума (OpenLayers) перенесены в правый нижний угол, располагаются над фаб‑кнопками и оформлены в едином стиле (круглые FAB с тенью), чтобы соответствовать остальным элементам управления.
- Переключатель темы синхронизирован с картой: в режиме OSM подложка светлая/тёмная в зависимости от темы приложения. Также доступен слой Satellite (Esri World Imagery).
- Поиск запускается только по кнопке "Search" (или клавишей Enter) — запросы не отправляются на каждый ввод.
- Иконки Font Awesome поставляются локально через npm (@fortawesome/fontawesome-free), внешние CDN не используются.
- Адаптивная верстка на Flexbox: интерфейс удобно использовать и на десктопе, и на мобильных устройствах.

## Известные ограничения

- Запрос к OpenSky API сейчас заглушен (возвращает пустой список). Для реальной интеграции реализуйте функцию backend.FetchOpenSkyData().

## Разработка

- Фронтенд: `cd frontend && npm start`
- Бэкенд: `go run ./cmd/miniflightradar --listen :8080`

Фронтенд стучится к /api/flight на том же хосте/порту.

## Траблшутинг

- Если сборка через Docker падает из‑за зависимостей, убедитесь, что используется vendoring (в Dockerfile он включён). 
- Если не видите статику, проверьте, что каталог ui/build существует: `make build-ui`. 
- На dev-машине можно собрать только backend: `make build-backend`. 

## APM и трассировка (OpenTelemetry)

В проект встроен трейсинг как на бэкенде (Go), так и во фронтенде (JS). Трейсы могут сходиться в одном OTEL‑коллекторе при корректной настройке.

- Бэкенд (Go):
  - Флаг `--tracing-endpoint` или переменная окружения `OTEL_ENDPOINT` — адрес OTLP/HTTP коллектора, например `otel-collector:4318`.
  - Пример запуска: `./bin/mini-flightradar --tracing-endpoint otel-collector:4318`.
  - Все HTTP‑запросы оборачиваются спанами; в ответ добавляется заголовок `X-Trace-Id` для корреляции.
  - Логи теперь унифицированные и включают trace_id/span_id.

- Фронтенд (JS):
  - Трейсинг включается на этапе сборки через переменную `REACT_APP_OTEL_EXPORTER_URL`, указывающую полный URL экспортёра OTLP/HTTP, например `http://localhost:4318/v1/traces`.
  - Makefile: `REACT_APP_OTEL_EXPORTER_URL=http://localhost:4318/v1/traces make all`.
  - Docker: `docker build --build-arg REACT_APP_OTEL_EXPORTER_URL=http://otel-collector:4318/v1/traces -t mini-flightradar .`
  - В демо-сборке включён провайдер трейсинга с OTLP/HTTP экспортёром. Автоинструментации отключены для стабильной сборки UI. При необходимости вы можете добавить пакеты `@opentelemetry/instrumentation-*` и зарегистрировать их в `frontend/src/otel.ts`.

Замечание: адреса для бэкенда и фронтенда отличаются по формату:
- Бэкенд — `host:port` (без пути), например `otel-collector:4318`.
- Фронтенд — полный URL до маршрута `/v1/traces`, например `http://otel-collector:4318/v1/traces`.
