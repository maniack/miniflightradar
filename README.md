# Mini Flightradar PWA

Простой демонстрационный сервис для отслеживания рейсов через OpenSky API: backend на Go + PWA‑фронтенд (React), метрики Prometheus и трассировка OpenTelemetry. Документация обновлена согласно текущему коду.

## Требования

- Go 1.24+
- Node.js 20+
- Docker (опционально)

## Быстрый старт (Go)

Рекомендуется собирать через Makefile (включая фронтенд) и запускать бинарник:

```bash
make all
./bin/mini-flightradar --listen ":8080"
```

Альтернатива (по шагам):

```bash
# 1) собрать фронтенд и скопировать его в ui/build (для встраивания в бинарник)
make frontend
# 2) собрать бэкенд (включая встраивание статики из ui/build)
make backend
# 3) запустить
./bin/mini-flightradar --listen ":8080"
```

После запуска UI доступен на http://localhost:8080

## Сборка через Makefile

```bash
make all              # соберёт frontend и backend, положит бинарник в bin/
./bin/mini-flightradar --listen ":8080"
```

Полезные цели:
- make frontend — сборка фронтенда (React) и копирование в ui/build
- make backend  — сборка Go‑бинарника (использует vendoring)
- make docker   — сборка Docker‑образа
- make clean    — очистка артефактов (bin/, ui/build)

## Сборка и запуск через Docker

```bash
docker build -t miniflightradar .
docker run --rm -p 8080:8080 -v $(pwd)/data:/app/data --name minifr miniflightradar
```

Контейнер слушает на 8080. Статика фронтенда встроена в бинарник; в итоговый образ копируется только исполняемый файл. Для сохранения БД и секретов пробросьте том в /app/data (как в примере выше).

## Конфигурация: флаги и переменные окружения

Флаги CLI (алиасы в скобках):
- server.listen (--listen, -l) — адрес HTTP‑сервера, по умолчанию `:8080`.
- server.proxy  (--proxy,  -x) — прокси URL для исходящих запросов (http/https/socks5). Пример: `--proxy socks5://127.0.0.1:1080`.
- tracing.endpoint (--tracing, -t) — адрес OTEL‑коллектора для трейсинга (формат `host:port` или полный URL), например `otel-collector:4318`.
- storage.path (--db) — путь к файлу BuntDB, по умолчанию `./data/flight.buntdb`.
- opensky.interval (--interval, -i) — интервал опроса OpenSky, по умолчанию `60s`.
- opensky.retention (--retention, -r) — срок хранения истории, по умолчанию `168h` (1 неделя).
- opensky.user — имя пользователя OpenSky (опционально, для Basic Auth).
- opensky.pass — пароль OpenSky (опционально, для Basic Auth).
- debug (-d) — включить подробное логирование.

Прокси можно задавать и стандартными переменными окружения (Linux‑style):
- HTTP_PROXY / http_proxy
- HTTPS_PROXY / https_proxy
- ALL_PROXY / all_proxy
- NO_PROXY / no_proxy

Также предусмотрены скрытые флаги для управления секретом JWT:
- security.jwt.secret — явный секрет (HS256) для подписи cookies.
- security.jwt.file — путь к файлу секрета (по умолчанию `./data/jwt.secret`). Если секрет не задан флагом, он будет загружен из файла или сгенерирован и сохранён на диск.

## HTTP/WS‑эндпоинты

- GET /api/flight?callsign=ABC123 — последняя точка для рейса (массив из одной записи в OpenSky‑совместимой форме `states`).
- GET /api/flights?bbox=minLon,minLat,maxLon,maxLat — текущие точки в прямоугольнике (массив объектов с полями `icao24,callsign,lon,lat,alt,track,speed,ts`).
- GET /api/flights — все текущие точки (тот же формат, что и выше), используется UI для обзора.
- GET /api/track?callsign=ABC123 — текущий отрезок трека для рейса (JSON: `{callsign, icao24, points: [...]}`).
- GET /metrics — метрики Prometheus.
- WS /ws/flights — поток обновлений позиций (диффы) для всех текущих рейсов. Требуются cookies и CSRF (см. раздел Security). Клиент должен передать `?csrf=<значение cookie mfr_csrf>` и отправлять ACK `{"type":"ack","seq":N,"buffered":bytes}`. Сообщения `{"type":"viewport",...}` сервером игнорируются.
- POST /otel/v1/traces — прокси OTLP/HTTP для фронтенда; сервер пересылает запросы в коллектор, указанный в `--tracing.endpoint`.

## Наблюдаемость

- Prometheus: /metrics, счётчики/гистограммы для HTTP и полётных запросов.
- OpenTelemetry: сервер создаёт спаны для HTTP; в ответ добавляется заголовок `X-Trace-Id` для корреляции. Веб‑клиент отправляет трейсинг на `/otel/v1/traces` (см. выше).
- Логи: унифицированные строки с полями method, path, status, duration, remote, ua, trace_id, span_id, request_id.
- Кеширование: глобальный middleware добавляет сильные ETag для GET/HEAD и корректно обслуживает `If-None-Match`.
- Request ID: для каждого запроса добавляется и логируется `X-Request-ID`.

## Security

- Cookies: при первом обращении сервер выпускает две cookies — `mfr_jwt` (JWT HS256 с сроком ~30 дней, HttpOnly, SameSite=Lax) и `mfr_csrf` (токен для CSRF, доступен из JS).
- Защита API: для маршрутов `/api/*` (кроме `/metrics`) требуется совпадение заголовка `X-CSRF-Token` со значением cookie `mfr_csrf` и валидный `mfr_jwt`.
- WebSocket `/ws/flights`: проверяет валидность `mfr_jwt` и токен CSRF из query‑параметра `csrf`.
- Секрет JWT: задаётся флагом `security.jwt.secret` либо хранится/генерируется в файле `security.jwt.file` (по умолчанию `./data/jwt.secret`).

## Данные и персистентность

- Хранилище — BuntDB (ключ/значение). Файл по умолчанию: `./data/flight.buntdb`.
- Очистка старых точек — автоматически по TTL (флаг `--opensky.retention`, по умолчанию 1 неделя).
- Рекомендуется монтировать том с каталогом `data/` в Docker для сохранения состояния между перезапусками.

## OpenSky: частота опроса и бэкофф

- Базовый интервал опроса задаётся флагом `--opensky.interval` (по умолчанию 60s).
- При ответах 429/503 применяется бэкофф: следующий запрос откладывается согласно `Retry-After` либо не меньше базового интервала. Текущие точки «продлеваются», чтобы метки не пропадали во время бэкоффа.
- При указании `opensky.user`/`opensky.pass` используется Basic Auth (лимиты могут отличаться).

## UI/UX

- Сверху — поле поиска (позывной) и кнопка Search. При активном фильтре показывается только выбранный рейс и его трек.
- Слева снизу — переключатель слоя карты: OSM (следует теме light/dark) и Hybrid (спутник + подписи).
- Без фильтра UI показывает все доступные рейсы в текущем окне карты; данные поступают через WebSocket‑диффы.
- Иконки поставляются локально (@fortawesome/fontawesome-free), внешние CDN не используются. Адаптивная верстка на Flexbox.

## Разработка

- Фронтенд: `cd frontend && npm start`
- Бэкенд: `go run ./cmd/miniflightradar --listen :8080`

UI обращается к API/WS на том же хосте/порту.

## Траблшутинг

- Если не видите статику, соберите фронтенд: `make frontend` (в результате появится `ui/build`).
- Для быстрой проверки бэкенда можно собрать только его: `make backend` (предварительно соберите UI, если хотите встраивание).
- В Docker пробросьте том `-v $(pwd)/data:/app/data`, чтобы база и секреты не терялись.

## Security and dependency hygiene

- Frontend dependencies are pinned and production builds use `npm ci`; UI встраивается в Go‑бинарник, Node‑инструменты не входят в образ.
- Current audit status: no critical/high production vulnerabilities; dev‑сервер CRA может иметь moderate‑адвайзори, относящиеся только к локальной разработке.
- Run an audit locally: `cd frontend && npm audit --omit=dev`.

## License

This project is licensed under the MIT License. See the LICENSE file for details.

## Third‑party licenses and attributions

The project uses the following third‑party software and data. Please review and comply with their licenses and terms when deploying this application:

- OpenLayers (package `ol`) — BSD 2‑Clause license.
  - Copyright © OpenLayers Contributors.
  - https://openlayers.org/
  - https://github.com/openlayers/openlayers/blob/main/LICENSE.md

- Font Awesome Free (`@fortawesome/fontawesome-free`) — Code under MIT, icons under CC BY 4.0.
  - https://github.com/FortAwesome/Font-Awesome/blob/6.x/LICENSE.txt

- OpenStreetMap data and tiles — © OpenStreetMap contributors, ODbL 1.0 for data; tile usage subject to provider terms.
  - https://www.openstreetmap.org/copyright
  - Attribution is shown in the map UI as required.

- CARTO Basemaps (Dark Matter OSM tiles) — usage subject to CARTO terms; attribution required (shown in UI).
  - https://carto.com/basemaps/

- Esri World Imagery and reference overlays — usage subject to Esri Terms of Use; attribution required (shown in UI).
  - https://www.esri.com/en-us/legal/terms/full-master-agreement
  - https://www.esri.com/en-us/legal/terms/data-attributions

- OpenSky Network API — subject to OpenSky Network Terms of Use and API limitations.
  - https://opensky-network.org/
  - https://openskynetwork.github.io/opensky-api/
  - We respect rate limits and include attribution in the UI.

Notes:
- This application fetches map tiles from external providers (OSM/CARTO/Esri). Ensure your deployment complies with their usage policies (e.g., fair use, API keys if required, proper attribution).
- The backend may use your OpenSky credentials (opensky.user/opensky.pass flags) if provided; ensure your use complies with OpenSky’s ToS.