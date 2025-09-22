import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';

// Centralized tracer for UI
export function getUITracer() {
  return trace.getTracer('miniflightradar-ui');
}

// Start a span with common attributes; returns span and a convenience end() function
export function startUISpan(name: string, attrs?: Record<string, any>) {
  const tracer = getUITracer();
  const span = tracer.startSpan(name);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined && v !== null && v !== '') span.setAttribute(k, v as any);
    }
  }
  return {
    span,
    end: (moreAttrs?: Record<string, any>) => {
      if (moreAttrs) {
        for (const [k, v] of Object.entries(moreAttrs)) {
          if (v !== undefined && v !== null && v !== '') span.setAttribute(k, v as any);
        }
      }
      span.end();
    },
  };
}

// Run function within a span and end it automatically, capturing errors
export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T, attrs?: Record<string, any>): Promise<T> {
  const { span } = startUISpan(name, attrs);
  try {
    const res = await fn(span);
    span.end();
    return res;
  } catch (e: any) {
    recordException(span, e);
    span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message || String(e) });
    span.end();
    throw e;
  }
}

export function addEvent(span: Span | null | undefined, name: string, attrs?: Record<string, any>) {
  if (!span) return;
  if (attrs) span.addEvent(name, attrs as any);
  else span.addEvent(name);
}

export function recordException(span: Span | null | undefined, err: any) {
  if (!span) return;
  const message = err?.message || String(err);
  const stack = (err?.stack || '') as string;
  span.recordException({ name: err?.name || 'Error', message, stack });
}

// Helper to bind callback into active context (so child span can link to current trace)
export function bind<T extends (...args: any[]) => any>(fn: T): T {
  return trace.getTracerProvider() ? context.bind(context.active(), fn) : fn;
}
