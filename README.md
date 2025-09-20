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
- --metrics — включить экспонирование метрик Prometheus (по умолчанию true), метрики на /metrics
- --tracing (или -t) либо переменная OTEL_ENDPOINT — адрес OTEL-коллектора для отправки трейсинга (опционально)
- --history.retention (или --retention) — период хранения истории полётов в BuntDB, формат duration (по умолчанию 168h = 1 неделя)
- --server.interval (или --interval) — интервал опроса OpenSky API, формат duration (по умолчанию 10s)
- --server.proxy (или --proxy, -x) — URL прокси для запросов к внешним API (OpenSky). Поддерживаются схемы http, https, socks5. Пример: `--proxy socks5://127.0.0.1:1080`. Если флаг не задан, используются стандартные переменные окружения: `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy` (как в curl).
- --debug (или переменная окружения DEBUG=true) — включить подробное debug‑логирование по всему приложению

## Что есть внутри

- /api/flight?callsign=ABC123 — возвращает последнюю известную позицию рейса из локального хранилища (совместимый с OpenSky формат одной записи в массиве)
- /api/flights?bbox=minLon,minLat,maxLon,maxLat — возвращает текущие позиции всех рейсов в указанном прямоугольнике (lon/lat)
- /api/track?callsign=ABC123 — возвращает исторический трек выбранного рейса за период хранения (по умолчанию неделя)
- /metrics — метрики Prometheus (если включено)
- PWA фронтенд на React (OpenLayers карта)

## UI/UX

- Управляющие элементы расположены поверх карты (по центру сверху), как в Google Maps.
- В правом нижнем углу — вертикальная колонка кнопок: центрирование по текущему местоположению и переключатель темы (иконки Font Awesome). Карта автоматически центрируется на вас при старте (после разрешения геолокации в браузере), а также по нажатию кнопки.
- Кнопки зума (OpenLayers) перенесены в правый нижний угол, располагаются над фаб‑кнопками и оформлены в едином стиле (круглые FAB с тенью), чтобы соответствовать остальным элементам управления.
- Переключатель темы синхронизирован с картой: в режиме OSM подложка светлая/тёмная в зависимости от темы приложения. Также доступен слой Hybrid (Esri World Imagery + Labels).
- Поиск запускается только по кнопке "Search" (или клавишей Enter). При введённом позывном отображается только выбранный рейс и его исторический трек (из локального хранилища), позиция обновляется в реальном времени.
- Без фильтра по позывному показываются все доступные рейсы в текущем видимом участке карты; данные берутся из локального кэша (не нагружая OpenSky), список обновляется каждые ~12 секунд и при перемещении карты.
- Иконки Font Awesome поставляются локально через npm (@fortawesome/fontawesome-free), внешние CDN не используются.
- Адаптивная верстка на Flexbox: интерфейс удобно использовать и на десктопе, и на мобильных устройствах.

## Известные ограничения

- Интеграция с OpenSky API реализована. Для бесплатного доступа действует ограничение по частоте обновлений; приложение опрашивает бэкенд примерно раз в 12 секунд (с учётом внутреннего кэша). При указании переменных окружения OPENSKY_USER/OPENSKY_PASS опрос ускоряется (кэш ~2 секунды).

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
  - Флаг `--tracing` (или `-t`) либо переменная окружения `OTEL_ENDPOINT` — адрес OTLP/HTTP коллектора, например `otel-collector:4318`.
  - Пример запуска: `./bin/mini-flightradar --tracing otel-collector:4318`.
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


## Данные и персистентность

- Локальное хранилище — BuntDB (key/value). База сохраняется на диск в каталоге `./data/flight.buntdb` и переживает перезапуски приложения.
- Очистка старых данных происходит автоматически по TTL (по умолчанию 1 неделя; настраивается флагом `--retention`).
- В Docker рекомендуется пробросить том для сохранения базы между перезапусками:
  - `docker run -v $(pwd)/data:/app/data -p 8080:8080 mini-flightradar`

## Ограничения OpenSky и бэкофф

- Частота опроса OpenSky задаётся флагом `--server.interval` (по умолчанию 10s).
- При превышении лимита запросов сервер обрабатывает ответы `429 Too Many Requests`/`503 Service Unavailable` и автоматически откладывает следующий запрос согласно заголовку `Retry-After` (если есть) или на разумный интервал по умолчанию.
- При наличии учётных данных (`OPENSKY_USER`/`OPENSKY_PASS`) используется Basic Auth, что может повысить доступные лимиты.

## Изменения UI

- Маркер отслеживаемого рейса заменён на значок самолёта; цвет и «ореол» подстраиваются под выбранную тему.
- Если фильтр по позывному не задан, по умолчанию на карте показываются все доступные рейсы в текущем видимом участке (режим обзора).

## Security and dependency hygiene

- Frontend dependencies are pinned and patched using npm overrides to address known advisories in transitive packages (e.g., nth-check>=2.0.1, svgo>=2.8.0, postcss>=8.4.31).
- Production builds use a clean, reproducible install via `npm ci` and the UI is embedded into the Go binary; Node tooling is not shipped to production.
- Current audit status: no critical or high vulnerabilities in production dependencies. Two moderate advisories remain tied to `webpack-dev-server` via `react-scripts`; they apply only to the local development server and are not used in production builds. We track these upstream; eliminating them completely would require migrating off CRA.
- Run an audit locally: `cd frontend && npm audit --omit=dev`.
- If the lockfile ever drifts, refresh it with `npm install` (not `ci`) to re-resolve overrides, then re-run `npm ci` for reproducible installs.

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
- The backend may use your OpenSky credentials (OPENSKY_USER/OPENSKY_PASS) if provided, which may affect allowed request rates. Ensure your use complies with OpenSky’s ToS.