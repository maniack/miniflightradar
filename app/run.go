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
	"github.com/maniack/miniflightradar/ui"
)

// Run is the main CLI action that starts the HTTP server.
func Run(ctx context.Context, c *cli.Command) error {
	listen := c.String("listen")
	enableMetrics := c.Bool("enable-metrics")
	tracingEndpoint := c.String("tracing-endpoint")

	// Tracing
	shutdownTracer := monitoring.InitTracer(tracingEndpoint, "mini-flightradar")
	defer shutdownTracer()

	r := chi.NewRouter()
	// Use Recoverer early to ensure panics are caught
	r.Use(middleware.Recoverer)
	// Request timeout
	r.Use(middleware.Timeout(15 * time.Second))
	// Tracing before logging to ensure trace IDs are present
	r.Use(monitoring.TracingMiddleware)
	// Metrics and structured logging
	r.Use(monitoring.MetricsMiddleware)
	r.Use(monitoring.LoggingMiddleware)

	if enableMetrics {
		r.Handle("/metrics", monitoring.PrometheusHandler())
	}

	r.Get("/api/flight", monitoring.InstrumentedFlightHandler(backend.FlightHandler))
	r.Handle("/*", ui.Handler())

	log.Printf("Server listening on %s\n", listen)
	return http.ListenAndServe(listen, r)
}
