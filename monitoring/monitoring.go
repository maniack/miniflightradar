// Package monitoring provides Prometheus metrics, OpenTelemetry tracing,
// and unified structured logging helpers for the application.
package monitoring

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	github_chi_mw "github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/semconv/v1.21.0"
	"go.opentelemetry.io/otel/trace"
)

var (
	// Common namespace for all metrics in the app
	namespace = "miniflightradar"

	// logging level: 0=info, 1=debug
	logLevel int32

	// Flight API metrics
	FlightRequests = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: "flight_api",
			Name:      "requests_total",
			Help:      "Total number of /api/flight requests",
		},
		[]string{"callsign"},
	)

	FlightErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: "flight_api",
			Name:      "errors_total",
			Help:      "Total number of errors processing /api/flight",
		},
		[]string{"callsign"},
	)

	FlightDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: namespace,
			Subsystem: "flight_api",
			Name:      "duration_seconds",
			Help:      "Duration of /api/flight requests",
			Buckets:   prometheus.DefBuckets,
		},
		[]string{"callsign"},
	)

	AircraftCount = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Namespace: namespace,
			Subsystem: "flight_api",
			Name:      "aircraft_count",
			Help:      "Number of aircraft returned in the last /api/flight response",
		},
		[]string{"callsign"},
	)

	LastStatus = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Namespace: namespace,
			Subsystem: "flight_api",
			Name:      "last_status",
			Help:      "HTTP status code of the last /api/flight request",
		},
		[]string{"callsign"},
	)

	// HTTP server metrics
	HTTPRequests = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: "http",
			Name:      "requests_total",
			Help:      "Total number of HTTP requests",
		},
		[]string{"method", "path", "status"},
	)

	HTTPDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: namespace,
			Subsystem: "http",
			Name:      "duration_seconds",
			Help:      "Duration of HTTP requests",
			Buckets:   prometheus.DefBuckets,
		},
		[]string{"method", "path"},
	)
)

func init() {
	prometheus.MustRegister(
		FlightRequests,
		FlightErrors,
		FlightDuration,
		AircraftCount,
		LastStatus,
		HTTPRequests,
		HTTPDuration,
	)

	// default log level
	SetLogLevel("info")
}

// Logging level helpers
func SetLogLevel(level string) {
	switch strings.ToLower(level) {
	case "debug":
		atomic.StoreInt32(&logLevel, 1)
		log.Printf("log_level=debug")
	case "info", "":
		atomic.StoreInt32(&logLevel, 0)
		log.Printf("log_level=info")
	default:
		// unknown -> info
		atomic.StoreInt32(&logLevel, 0)
		log.Printf("log_level=info (unknown level %q)", level)
	}
}

func IsDebug() bool { return atomic.LoadInt32(&logLevel) == 1 }

func Debugf(format string, args ...interface{}) {
	if IsDebug() {
		log.Printf("DEBUG "+format, args...)
	}
}

// ============ Helpers and middlewares for metrics ============

type responseRecorder struct {
	http.ResponseWriter
	status int
}

func (rr *responseRecorder) WriteHeader(code int) {
	rr.status = code
	rr.ResponseWriter.WriteHeader(code)
}

// InstrumentedFlightHandler wraps a specific flight handler with flight metrics.
func InstrumentedFlightHandler(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		callsign := r.URL.Query().Get("callsign")
		if callsign == "" {
			callsign = "unknown"
		}

		start := time.Now()
		FlightRequests.WithLabelValues(callsign).Inc()

		rr := &responseRecorder{ResponseWriter: w, status: 200}
		handler(rr, r)

		duration := time.Since(start).Seconds()
		FlightDuration.WithLabelValues(callsign).Observe(duration)
		LastStatus.WithLabelValues(callsign).Set(float64(rr.status))
	}
}

// UpdateAircraftCount sets the gauge for the number of aircraft in last response.
func UpdateAircraftCount(callsign string, count int) {
	if callsign == "" {
		callsign = "unknown"
	}
	AircraftCount.WithLabelValues(callsign).Set(float64(count))
}

// MetricsMiddleware instruments all HTTP traffic.
func MetricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rr := &responseRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rr, r)

		duration := time.Since(start).Seconds()
		path := r.URL.Path

		HTTPDuration.WithLabelValues(r.Method, path).Observe(duration)
		HTTPRequests.WithLabelValues(r.Method, path, http.StatusText(rr.status)).Inc()
	})
}

// PrometheusHandler exposes registered metrics.
func PrometheusHandler() http.Handler { return promhttp.Handler() }

// ============ Client helpers (tracing + metrics) ============

// StartClientSpan starts an OpenTelemetry client span for an outbound HTTP request.
// It sets common attributes like http.method and url and returns the span for the caller to end.
func StartClientSpan(ctx context.Context, name, urlStr, method string) (context.Context, trace.Span) {
	if method == "" {
		method = "GET"
	}
	ctx, span := otel.Tracer("mini-flightradar-client").Start(ctx, name, trace.WithSpanKind(trace.SpanKindClient))
	span.SetAttributes(
		semconv.HTTPMethodKey.String(method),
		attribute.String("http.url", urlStr),
	)
	return ctx, span
}

// ============ Tracing ============

var tracer = otel.Tracer("mini-flightradar-http")

// InitTracer initializes OpenTelemetry exporter and provider.
func InitTracer(endpoint string, serviceName string) func() {
	ctx := context.Background()

	// Set propagator for W3C TraceContext + Baggage for both server and client.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))

	if endpoint == "" {
		// No remote exporter; still install a tracer provider with default settings
		tp := sdktrace.NewTracerProvider(
			sdktrace.WithResource(resource.NewWithAttributes(
				semconv.SchemaURL,
				semconv.ServiceName(serviceName),
			)),
		)
		otel.SetTracerProvider(tp)
		return func() {
			_ = tp.Shutdown(ctx)
		}
	}

	exp, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpoint(endpoint), otlptracehttp.WithInsecure())
	if err != nil {
		log.Printf("failed to create OTEL exporter: %v", err)
		return func() {}
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(serviceName),
		)),
	)

	otel.SetTracerProvider(tp)

	return func() {
		if err := tp.Shutdown(ctx); err != nil {
			log.Printf("error shutting down tracer: %v", err)
		}
	}
}

// TracingMiddleware creates a span for each HTTP request with context extraction.
func TracingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract incoming context (W3C TraceContext/Baggage)
		prop := otel.GetTextMapPropagator()
		ctx := prop.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

		// Start server span with useful attributes
		spanName := r.Method + " " + r.URL.Path
		ctx, span := tracer.Start(ctx, spanName, trace.WithSpanKind(trace.SpanKindServer))
		defer span.End()

		// Add some common attributes
		span.SetAttributes(
			semconv.HTTPSchemeKey.String(func() string {
				if r.TLS != nil {
					return "https"
				}
				return "http"
			}()),
			semconv.HTTPMethodKey.String(r.Method),
			semconv.URLPathKey.String(r.URL.Path),
		)
		// Attach request id as attribute when available
		if rid := github_chi_mw.GetReqID(r.Context()); rid != "" {
			span.SetAttributes(attribute.String("http.request_id", rid))
		}

		// Pass trace id to client for correlation
		if sc := span.SpanContext(); sc.IsValid() {
			w.Header().Set("X-Trace-Id", sc.TraceID().String())
		}

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// LoggingMiddleware writes structured logs for each HTTP request/response with trace correlation.
func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rr := &responseRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rr, r)

		dur := time.Since(start)
		traceID, spanID := "", ""
		if sc := trace.SpanFromContext(r.Context()).SpanContext(); sc.IsValid() {
			traceID = sc.TraceID().String()
			spanID = sc.SpanID().String()
		}
		remote := clientIP(r)
		ua := r.UserAgent()
		path := r.URL.Path
		query := r.URL.RawQuery
		if query != "" {
			path = path + "?" + query
		}
		// Correlate with request id if present
		rid := github_chi_mw.GetReqID(r.Context())

		log.Printf("http_request method=%s path=%q status=%d duration=%s remote=%s ua=%q trace_id=%s span_id=%s request_id=%s", r.Method, path, rr.status, dur, remote, ua, traceID, spanID, rid)
	})
}

// ETagMiddleware adds strong ETag handling for cacheable responses.
// It buffers GET/HEAD responses (when no ETag already set), computes a SHA-256-based ETag
// over the final response body (after compression if any), and serves 304 if If-None-Match matches.
func ETagMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip WebSocket upgrade requests
		if strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") || strings.ToLower(r.Header.Get("Upgrade")) == "websocket" {
			next.ServeHTTP(w, r)
			return
		}
		// Only for idempotent cacheable methods
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}
		// If handler explicitly sets ETag or Cache-Control: no-store, skip
		if et := w.Header().Get("ETag"); et != "" {
			next.ServeHTTP(w, r)
			return
		}
		if cc := strings.ToLower(w.Header().Get("Cache-Control")); strings.Contains(cc, "no-store") {
			next.ServeHTTP(w, r)
			return
		}

		// Record response
		rec := &etagRecorder{w: w, header: make(http.Header), status: http.StatusOK}
		next.ServeHTTP(rec, r)

		// If non-200 or empty body (and not HEAD), just pass through
		if rec.status != http.StatusOK || (r.Method != http.MethodHead && rec.buf.Len() == 0) {
			copyHeaders(w.Header(), rec.header)
			w.WriteHeader(rec.status)
			if r.Method != http.MethodHead {
				_, _ = w.Write(rec.buf.Bytes())
			}
			return
		}

		// Compute strong ETag over body we are going to send to client
		sum := sha256.Sum256(rec.buf.Bytes())
		etag := "\"" + hex.EncodeToString(sum[:]) + "\""

		// Compare If-None-Match
		if inm := r.Header.Get("If-None-Match"); inm != "" {
			for _, cand := range strings.Split(inm, ",") {
				if strings.TrimSpace(cand) == etag {
					// Not modified
					copyHeaders(w.Header(), rec.header)
					w.Header().Set("ETag", etag)
					w.Header().Add("Vary", "Accept-Encoding")
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
		}

		// Send with ETag
		copyHeaders(w.Header(), rec.header)
		w.Header().Set("ETag", etag)
		w.Header().Add("Vary", "Accept-Encoding")
		w.Header().Set("Content-Length", strconv.Itoa(rec.buf.Len()))
		w.WriteHeader(rec.status)
		if r.Method != http.MethodHead {
			_, _ = w.Write(rec.buf.Bytes())
		}
	})
}

// etagRecorder captures response for ETag computation.
type etagRecorder struct {
	w           http.ResponseWriter
	header      http.Header
	buf         bytes.Buffer
	status      int
	wroteHeader bool
}

func (r *etagRecorder) Header() http.Header { return r.header }

func (r *etagRecorder) WriteHeader(code int) {
	if r.wroteHeader {
		return
	}
	r.wroteHeader = true
	r.status = code
}

func (r *etagRecorder) Write(p []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	return r.buf.Write(p)
}

// copyHeaders copies header kv pairs from src to dst (preserving existing ones)
func copyHeaders(dst, src http.Header) {
	for k, vv := range src {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

// clientIP tries to determine the real client IP.
func clientIP(r *http.Request) string {
	// Check X-Forwarded-For first
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	// Then X-Real-Ip
	if xr := r.Header.Get("X-Real-Ip"); xr != "" {
		return xr
	}
	// Fallback to RemoteAddr
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
