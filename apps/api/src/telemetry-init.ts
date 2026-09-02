import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { config } from '@mini-vercel/config';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

if (process.env.OTEL_DIAG_LOG_LEVEL === 'debug') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

let sdk: NodeSDK | null = null;

export function initTelemetry(): NodeSDK | null {
  if (sdk) return sdk;

  if (config.telemetry.enabled || process.env.NODE_ENV === 'production') {
    try {
      sdk = new NodeSDK({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: 'pulseops-api',
          [ATTR_SERVICE_VERSION]: '1.0.0',
          [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.env,
        }),
        instrumentations: [
          getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-fs': { enabled: false },
          }),
        ],
      });

      sdk.start();
      console.log('[OpenTelemetry] API NodeSDK initialized successfully');
    } catch (err: any) {
      console.warn(`[OpenTelemetry] Warning during SDK initialization: ${err?.message}`);
    }
  }

  return sdk;
}

// Auto-initialize if not in pure isolated test runner
if (process.env.NODE_ENV !== 'test') {
  initTelemetry();
}

process.on('SIGTERM', () => {
  sdk?.shutdown().then(() => console.log('[OpenTelemetry] API SDK shut down cleanly')).catch(() => {});
});
