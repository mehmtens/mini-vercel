export type DeploymentStatus =
  | 'QUEUED'
  | 'INITIALIZING'
  | 'CLONING'
  | 'BUILDING'
  | 'UPLOADING'
  | 'DEPLOYING'
  | 'READY'
  | 'FAILED'
  | 'CANCELLED';

export const ALLOWED_STATE_TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  QUEUED: ['INITIALIZING', 'CANCELLED', 'FAILED'],
  INITIALIZING: ['CLONING', 'CANCELLED', 'FAILED'],
  CLONING: ['BUILDING', 'CANCELLED', 'FAILED'],
  BUILDING: ['UPLOADING', 'CANCELLED', 'FAILED'],
  UPLOADING: ['DEPLOYING', 'CANCELLED', 'FAILED'],
  DEPLOYING: ['READY', 'CANCELLED', 'FAILED'],
  READY: [],
  FAILED: [],
  CANCELLED: [],
} as const;

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly deploymentId: string,
    public readonly fromStatus: DeploymentStatus,
    public readonly toStatus: DeploymentStatus,
    message?: string
  ) {
    super(
      message ||
        `Invalid deployment state transition from "${fromStatus}" to "${toStatus}" for deployment "${deploymentId}". Allowed transitions from "${fromStatus}": [${(
          ALLOWED_STATE_TRANSITIONS[fromStatus] || []
        ).join(', ')}]`
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export function isValidTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  if (from === to) return true; // idempotent self-transition
  const allowed = ALLOWED_STATE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function isTerminalStatus(status: DeploymentStatus): boolean {
  return status === 'READY' || status === 'FAILED' || status === 'CANCELLED';
}

export interface Project {
  id: string;
  name: string;
  repo_url: string;
  branch: string;
  framework: string;
  created_at: string;
  updated_at: string;
}

export interface BuildLog {
  id?: number;
  deployment_id: string;
  step: 'QUEUE' | 'CLONE' | 'DEPENDENCIES' | 'COMPILE' | 'STATIC_GEN' | 'MINIO_UPLOAD' | 'EDGE_DEPLOY' | 'SUCCESS' | 'ERROR';
  message: string;
  log_level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  timestamp?: string;
}

export interface Deployment {
  id: string;
  project_id?: string | null;
  project_name: string;
  repo_url: string;
  branch: string;
  commit_hash: string;
  status: DeploymentStatus;
  preview_url?: string | null;
  build_duration_ms: number;
  error_message?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at: string;
  logs?: BuildLog[];
}

export interface DeploymentJobPayload {
  deployment_id: string;
  project_name: string;
  repo_url: string;
  branch: string;
  commit_hash: string;
  build_command?: string;
  install_command?: string;
  output_directory?: string;
  root_directory?: string;
  created_at: string;
  traceparent?: string;
  tracestate?: string;
  requestId?: string;
}

export interface CreateDeploymentDto {
  project_name: string;
  repo_url: string;
  branch?: string;
  commit_hash?: string;
}

export interface ServiceHealth {
  status: 'up' | 'down';
  latency?: string;
  message?: string;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: string;
  version: string;
  services: {
    api: ServiceHealth;
    postgres: ServiceHealth;
    redis: ServiceHealth;
    minio: ServiceHealth;
  };
}

export interface StatsResponse {
  total_deployments: number;
  active_queue_jobs: number;
  status_counts: Record<string, number>;
  avg_build_time_ms: number;
  success_rate: number;
}
