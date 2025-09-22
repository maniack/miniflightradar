package app

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/maniack/miniflightradar/security"
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
	// Read flags using their canonical names to avoid alias lookup issues
	listen := c.String("server.listen")
	enableMetrics := c.Bool("metrics.enabled")
	tracingEndpoint := c.String("tracing.endpoint")
	retention := c.Duration("server.retention")
	poll := c.Duration("server.interval")
	proxy := c.String("server.proxy")

	// Logging level (override env if flag provided)
	if c.Bool("debug") {
		monitoring.SetLogLevel("debug")
	}

	// Tracing
	shutdownTracer := monitoring.InitTracer(tracingEndpoint, "mini-flightradar")
	defer shutdownTracer()

	// Initialize auth (loads/persists JWT secret) early so WS path can validate immediately
	security.InitAuth()

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

	r := chi.NewRouter()
	// Global minimal middlewares (must be added before any routes on this mux)
	// Keep only ones that don't wrap ResponseWriter in a way that breaks Hijacker.
	r.Use(middleware.Recoverer)
	// Global ETag over compressed bytes (Compress is applied on subrouter)
	r.Use(monitoring.ETagMiddleware) // placed outside of Compress (on subrouter) so ETag is over compressed bytes
	// Generate a unique request ID for each request and expose it via X-Request-ID
	r.Use(middleware.RequestID)

	// WebSocket endpoint on the root router without extra wrapping middlewares
	// to ensure http.Hijacker works during upgrade.
	r.Get("/ws/flights", backend.FlightsWSHandler)

	// Frontend OTEL proxy endpoint (bypass security middleware). Sends to tracing.endpoint
	r.HandleFunc("/otel/v1/traces", backend.OTLPTracesProxy(tracingEndpoint))

	// Subrouter for regular HTTP routes with full middleware stack
	api := chi.NewRouter()
	// Enable gzip/deflate compression for API and static responses
	api.Use(middleware.Compress(5))
	// Request timeout
	api.Use(middleware.Timeout(15 * time.Second))
	// Basic security headers
	api.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("Permissions-Policy", "geolocation=(self)")
			// Note: Content-Security-Policy can break map tiles if too strict; omitted intentionally.
			next.ServeHTTP(w, r)
		})
	})
	// Security: CORS + CSRF + JWT (also issues cookies for UI)
	api.Use(security.SecurityMiddleware)
	// Tracing before logging to ensure trace IDs are present
	api.Use(monitoring.TracingMiddleware)
	// Metrics and structured logging
	api.Use(monitoring.MetricsMiddleware)
	api.Use(monitoring.LoggingMiddleware)

	if enableMetrics {
		api.Handle("/metrics", monitoring.PrometheusHandler())
	}

	// HTTP fallback: all flights (frontend filters)
	api.Get("/api/flights", backend.AllFlightsHandler)
	// UI
	api.Handle("/*", ui.Handler())

	// Mount the API subrouter under root (after defining its middlewares and routes)
	r.Mount("/", api)

	log.Printf("Server listening on %s\n", listen)
	srv := &http.Server{
		Addr:              listen,
		Handler:           r,
		ReadTimeout:       10 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case <-ctx.Done():
		log.Printf("Shutdown signal received, shutting down...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		// Stop background ingestion
		close(stop)
		// Wait for the server goroutine to exit
		<-errCh
		// Close storage if opened
		if s := storage.Get(); s != nil {
			_ = s.Close()
		}
		return nil
	case err := <-errCh:
		// Server exited (error or nil). Stop ingestor and close storage.
		close(stop)
		if s := storage.Get(); s != nil {
			_ = s.Close()
		}
		return err
	}
}
