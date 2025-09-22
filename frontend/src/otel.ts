// Frontend OpenTelemetry (APM) bootstrap for the UI
// This file is imported for side-effects from index.tsx

import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { ZoneContextManager } from '@opentelemetry/context-zone';

// Send web traces to backend proxy endpoint; backend forwards to OTEL collector configured via --tracing.endpoint
const exporterUrl = '/otel/v1/traces';

const provider = new WebTracerProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'miniflightradar-ui',
  }),
});

// Only register OTLP exporter if URL is provided
if (exporterUrl) {
  const exporter = new OTLPTraceExporter({ url: exporterUrl });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
}

provider.register({
  // Ensure async context is preserved across tasks
  contextManager: new ZoneContextManager(),
  // propagator: default W3C tracecontext is fine
});

// Flush pending spans on page unload to improve delivery
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    try { provider.forceFlush(); } catch (_) { /* noop */ }
  });
}

// Note: auto-instrumentations removed to avoid npm ETARGET issues.
// You can manually create spans around important actions if needed.
