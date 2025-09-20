package app

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/urfave/cli/v3"

	"github.com/maniack/miniflightradar/backend"
	"github.com/maniack/miniflightradar/monitoring"
	"github.com/maniack/miniflightradar/storage"
	"github.com/maniack/miniflightradar/ui"
)

// Run is the main CLI action that starts the HTTP server.
// It wires up monitoring, storage, background ingestion and HTTP routing.
// Security hardening: the server enables timeouts and sets basic security headers.
func Run(ctx context.Context, c *cli.Command) error {
	listen := c.String("listen")
	enableMetrics := c.Bool("metrics")
	tracingEndpoint := c.String("tracing")
	retention := c.Duration("retention")
	poll := c.Duration("interval")
	proxy := c.String("proxy")

	// Logging level (override env if flag provided)
	if c.Bool("debug") {
		monitoring.SetLogLevel("debug")
	}

	// Tracing
	shutdownTracer := monitoring.InitTracer(tracingEndpoint, "mini-flightradar")
	defer shutdownTracer()

	// Open storage and start ingestor
	if _, err := storage.Open(retention); err != nil {
		log.Printf("failed to open storage: %v", err)
	}
	// Configure poll interval
	backend.SetPollInterval(poll)
	// Configure proxy for backend HTTP client
	backend.SetProxy(proxy)

	stop := make(chan struct{})
	go backend.IngestLoop(stop)
	defer close(stop)

	r := chi.NewRouter()
	// Use Recoverer early to ensure panics are caught
	r.Use(middleware.Recoverer)
	// Request timeout
	r.Use(middleware.Timeout(15 * time.Second))
	// Basic security headers
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("Permissions-Policy", "geolocation=(self)")
			// Note: Content-Security-Policy can break map tiles if too strict; omitted intentionally.
			next.ServeHTTP(w, r)
		})
	})
	// Tracing before logging to ensure trace IDs are present
	r.Use(monitoring.TracingMiddleware)
	// Metrics and structured logging
	r.Use(monitoring.MetricsMiddleware)
	r.Use(monitoring.LoggingMiddleware)

	if enableMetrics {
		r.Handle("/metrics", monitoring.PrometheusHandler())
	}

	r.Get("/api/flight", monitoring.InstrumentedFlightHandler(backend.FlightHandler))
	r.Get("/api/flights", backend.FlightsInBBoxHandler)
	r.Get("/api/track", backend.TrackHandler)
	r.Handle("/*", ui.Handler())

	log.Printf("Server listening on %s\n", listen)
	srv := &http.Server{
		Addr:              listen,
		Handler:           r,
		ReadTimeout:       10 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	return srv.ListenAndServe()
}
