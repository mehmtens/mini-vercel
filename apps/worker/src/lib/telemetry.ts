import { trace, context, propagation, Span, SpanStatusCode, Tracer } from '@opentelemetry/api';
import { config } from '@doplo/config';

export const WORKER_TRACER_NAME = 'doplo-worker';

/**
 * Returns standard OpenTelemetry Tracer for Worker
 */
export function getWorkerTracer(): Tracer {
  return trace.getTracer(WORKER_TRACER_NAME, '1.0.0');
}

export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
  [key: string]: any;
}

/**
 * Extracts trace context from job payload metadata
 */
export function extractTraceContext(carrier: TraceCarrier) {
  try {
    return propagation.extract(context.active(), carrier);
  } catch {
    return context.active();
  }
}

/**
 * Runs a worker task within an extracted parent trace span
 */
export async function withWorkerSpan<T>(
  name: string,
  carrier: TraceCarrier,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {}
): Promise<T> {
  const extractedContext = extractTraceContext(carrier);
  const tracer = getWorkerTracer();

  return context.with(extractedContext, () => {
    return tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err: any) {
        span.recordException(err);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err?.message || 'Worker task failed',
        });
        throw err;
      } finally {
        span.end();
      }
    });
  });
}
