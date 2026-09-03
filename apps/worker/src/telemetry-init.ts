import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { config } from '@doplo/config';

let workerSdk: NodeSDK | null = null;

export function initWorkerTelemetry(): NodeSDK | null {
  if (workerSdk) return workerSdk;

  if (config.telemetry.enabled || process.env.NODE_ENV === 'production') {
    try {
      workerSdk = new NodeSDK({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: 'doplo-worker',
          [ATTR_SERVICE_VERSION]: '1.0.0',
          [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.env,
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
