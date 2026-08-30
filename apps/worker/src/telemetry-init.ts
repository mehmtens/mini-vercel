import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { config } from '@mini-vercel/config';

let workerSdk: NodeSDK | null = null;

export function initWorkerTelemetry(): NodeSDK | null {
  if (workerSdk) return workerSdk;

  if (config.telemetry.enabled || process.env.NODE_ENV === 'production') {
    try {
      workerSdk = new NodeSDK({
        resource: new Resource({
          [SemanticResourceAttributes.SERVICE_NAME]: 'mini-vercel-worker',
          [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
          [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: config.env,
        }),
        instrumentations: [
          getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-fs': { enabled: false },
          }),
        ],
      });

      workerSdk.start();
      console.log('[OpenTelemetry] Worker NodeSDK initialized successfully');
    } catch (err: any) {
      console.warn(`[OpenTelemetry] Warning during worker SDK initialization: ${err?.message}`);
    }
  }

  return workerSdk;
}

if (process.env.NODE_ENV !== 'test') {
  initWorkerTelemetry();
}

process.on('SIGTERM', () => {
  workerSdk?.shutdown().then(() => console.log('[OpenTelemetry] Worker SDK shut down cleanly')).catch(() => {});
});
