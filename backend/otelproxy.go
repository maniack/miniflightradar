package backend

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/maniack/miniflightradar/monitoring"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

// OTLPTracesProxy returns an http.HandlerFunc that proxies OTLP/HTTP trace export requests
// from the frontend to the configured OpenTelemetry collector endpoint.
//
// It expects the collector endpoint in form host:port (same as --tracing.endpoint flag),
// and will forward requests to http://host:port/v1/traces using the incoming request body
// and content headers. If the endpoint is empty, the handler returns 503.
func OTLPTracesProxy(collectorEndpoint string) http.HandlerFunc {
	// Normalize endpoint into a base URL string acceptable by http.NewRequest.
	var targetBase string
	if collectorEndpoint != "" {
		// If endpoint already has a scheme, use as-is, otherwise default to http.
		if strings.HasPrefix(collectorEndpoint, "http://") || strings.HasPrefix(collectorEndpoint, "https://") {
			targetBase = strings.TrimRight(collectorEndpoint, "/")
		} else {
			targetBase = "http://" + strings.TrimRight(collectorEndpoint, "/")
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}

	return func(w http.ResponseWriter, r *http.Request) {
		// Only allow POST as per OTLP/HTTP
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		if targetBase == "" {
			http.Error(w, "otel collector endpoint is not configured", http.StatusServiceUnavailable)
			return
		}

		// Construct target URL: base + /v1/traces
		targetURL := targetBase + "/v1/traces"
		if _, err := url.Parse(targetURL); err != nil {
			http.Error(w, "invalid collector endpoint", http.StatusInternalServerError)
			return
		}

		// Limit request body size to prevent abuse. Typical OTLP payloads are small.
		const maxBody = 5 << 20 // 5MB
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		defer r.Body.Close()

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}

		ctx, span := monitoring.StartClientSpan(r.Context(), "proxy otlp traces", targetURL, http.MethodPost)
		defer span.End()

		// Build outbound request
		outReq, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(body))
		if err != nil {
			http.Error(w, "failed to create request", http.StatusInternalServerError)
			return
		}

		// Copy relevant headers
		// Preserve content type and encoding for the collector
		if ct := r.Header.Get("Content-Type"); ct != "" {
			outReq.Header.Set("Content-Type", ct)
		}
		if ce := r.Header.Get("Content-Encoding"); ce != "" {
			outReq.Header.Set("Content-Encoding", ce)
		}
		// Propagate trace context using the global OTEL propagator configured in monitoring
		otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(outReq.Header))

		resp, err := client.Do(outReq)
		if err != nil {
			http.Error(w, "failed to reach collector", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		// Copy status code and body back to client
		for k, vv := range resp.Header {
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}
}

// Minimal wrappers to avoid importing otel directly here; leverage monitoring's propagator via interfaces.
// However, monitoring exposes only helper; here we can directly use the global otel propagator without adding extra deps.
// Implement a simple carrier backed by http.Header.

type propagationHeaderCarrier http.Header

func (c propagationHeaderCarrier) Get(key string) string      { return http.Header(c).Get(key) }
func (c propagationHeaderCarrier) Set(key string, val string) { http.Header(c).Set(key, val) }
func (c propagationHeaderCarrier) Keys() []string {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	return keys
}

// Adapter around global otel propagator
type otelPropagator struct{}

func (otelPropagator) Inject(ctx context.Context, carrier interface{}) {
	// Use the same propagator configured in monitoring.InitTracer
	prop := otel.GetTextMapPropagator()
	if hdr, ok := carrier.(propagation.TextMapCarrier); ok {
		prop.Inject(ctx, hdr)
	}
}
