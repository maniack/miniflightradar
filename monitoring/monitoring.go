// Package monitoring provides Prometheus metrics, OpenTelemetry tracing,
// and unified structured logging helpers for the application.
package monitoring

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
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

	// default from env
	ConfigureLogLevelFromEnv()
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

func ConfigureLogLevelFromEnv() {
	if lvl := os.Getenv("LOG_LEVEL"); lvl != "" {
		SetLogLevel(lvl)
		return
	}
	if d := strings.ToLower(os.Getenv("DEBUG")); d == "1" || d == "true" || d == "yes" {
		SetLogLevel("debug")
		return
	}
	SetLogLevel("info")
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

		log.Printf("http_request method=%s path=%q status=%d duration=%s remote=%s ua=%q trace_id=%s span_id=%s", r.Method, path, rr.status, dur, remote, ua, traceID, spanID)
	})
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
