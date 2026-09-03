import { trace, context, propagation, Span, SpanStatusCode, Tracer } from '@opentelemetry/api';
import { config } from '@doplo/config';

export const TRACER_NAME = 'doplo-api';

/**
 * Returns standard OpenTelemetry Tracer for API
 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, '1.0.0');
}

export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
  [key: string]: any;
}

/**
 * Injects the active trace context into a carrier dictionary (e.g. BullMQ job data or outgoing HTTP headers)
 */
export function injectTraceContext(carrier: TraceCarrier = {}, ctx = context.active()): TraceCarrier {
  if (!config.telemetry.enabled) {
    return carrier;
  }
  try {
    propagation.inject(ctx, carrier);
  } catch {
    // Non-blocking fallback
  }
  return carrier;
}

/**
 * Extracts trace context from carrier dictionary and returns an OpenTelemetry Context
 */
export function extractTraceContext(carrier: TraceCarrier) {
  try {
    return propagation.extract(context.active(), carrier);
  } catch {
    return context.active();
  }
}

/**
 * Executes an async function inside a traced OpenTelemetry span
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {}
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err?.message || 'Operation failed',
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
