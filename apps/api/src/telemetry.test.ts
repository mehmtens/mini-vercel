import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { trace, context, ROOT_CONTEXT, propagation } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { injectTraceContext, extractTraceContext } from './lib/telemetry';

describe('OpenTelemetry Distributed Tracing & InMemorySpanExporter Verification', () => {
  let memoryExporter: InMemorySpanExporter;
  let tracerProvider: BasicTracerProvider;

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
    });
    trace.setGlobalTracerProvider(tracerProvider);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  afterEach(() => {
    memoryExporter.reset();
  });

  it('1. Generates API root span and propagates W3C traceparent carrier to Worker', async () => {
    const apiTracer = tracerProvider.getTracer('doplo-api');
    const workerTracer = tracerProvider.getTracer('doplo-worker');

    // 1. API receives webhook and initiates root span
    const apiSpan = apiTracer.startSpan('api.webhook.receive', {}, ROOT_CONTEXT);
    const apiCtx = trace.setSpan(ROOT_CONTEXT, apiSpan);

    const carrier: Record<string, string> = {};
    injectTraceContext(carrier, apiCtx);

    expect(carrier.traceparent).toBeDefined();
    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const expectedTraceId = apiSpan.spanContext().traceId;
    const expectedParentSpanId = apiSpan.spanContext().spanId;

    // 2. Worker extracts trace context carrier from BullMQ job payload
    const workerExtractedCtx = extractTraceContext(carrier);

    const workerSpan = workerTracer.startSpan(
      'worker.build.compile',
      { attributes: { 'build.framework': 'vite', 'build.platform': 'docker' } },
      workerExtractedCtx
    );

    // Complete spans
    workerSpan.end();
    apiSpan.end();

    // 3. Inspect exported spans in InMemorySpanExporter
    const exportedSpans = memoryExporter.getFinishedSpans();
    expect(exportedSpans.length).toBe(2);

    const exportedApiSpan = exportedSpans.find((s) => s.name === 'api.webhook.receive');
    const exportedWorkerSpan = exportedSpans.find((s) => s.name === 'worker.build.compile');

    expect(exportedApiSpan).toBeDefined();
    expect(exportedWorkerSpan).toBeDefined();

    // Trace Lineage Assertions:
    // a) Both spans share the exact same trace ID
    expect(exportedWorkerSpan?.spanContext().traceId).toBe(expectedTraceId);
    expect(exportedApiSpan?.spanContext().traceId).toBe(expectedTraceId);

    // b) Worker span's parentSpanId points directly to API span's spanId
    expect(exportedWorkerSpan?.parentSpanContext?.spanId).toBe(expectedParentSpanId);

    // c) Worker attributes are recorded accurately
    expect(exportedWorkerSpan?.attributes['build.framework']).toBe('vite');
    expect(exportedWorkerSpan?.attributes['build.platform']).toBe('docker');
  });

  it('2. Traceparent formatting strictly follows W3C recommendation', () => {
    const tracer = tracerProvider.getTracer('test-tracer');
    const span = tracer.startSpan('sample.span');
    const ctx = trace.setSpan(ROOT_CONTEXT, span);

    const carrier: Record<string, string> = {};
    injectTraceContext(carrier, ctx);

    const parts = carrier.traceparent.split('-');
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe('00'); // Version
    expect(parts[1].length).toBe(32); // TraceId
    expect(parts[2].length).toBe(16); // ParentSpanId
    expect(parts[3]).toBe('01'); // TraceFlags sampled

    span.end();
  });
});
