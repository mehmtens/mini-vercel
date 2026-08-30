const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

async function fetchJson<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': 'demo_user',
      ...options.headers,
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    let errorMsg = `API request failed with status ${res.status}`;
    try {
      const errJson = await res.json();
      errorMsg = errJson.message || errJson.error || errorMsg;
    } catch (_err) {
      // Ignore JSON parse failure for error responses
    }
    throw new Error(errorMsg);
  }

  return res.json() as Promise<T>;
}

export interface ProjectData {
  id: string;
  name: string;
  slug: string;
  repoName: string;
  repoUrl: string;
  branch: string;
  rootDirectory: string;
  buildCommand: string;
  outputDirectory: string;
  installCommand: string;
  framework: string;
  currentDeploymentId?: string | null;
  createdAt: string;
  updatedAt: string;
  currentDeployment?: {
    id: string;
    status: string;
    commitHash: string;
    previewUrl?: string | null;
    createdAt: string;
  } | null;
  deployments?: DeploymentData[];
  envVars?: EnvVarData[];
  _count?: {
    deployments: number;
    envVars: number;
  };
}

export interface DeploymentData {
  id: string;
  project_id?: string;
  projectId?: string;
  project_name?: string;
  project_slug?: string;
  repo_url?: string;
  branch: string;
  commit_hash?: string;
  commitHash?: string;
  commit_message?: string;
  commitMessage?: string;
  sender_username?: string;
  senderUsername?: string;
  trigger: 'WEBHOOK_PUSH' | 'MANUAL' | 'ROLLBACK';
  status: 'QUEUED' | 'INITIALIZING' | 'CLONING' | 'BUILDING' | 'UPLOADING' | 'DEPLOYING' | 'READY' | 'FAILED' | 'CANCELLED';
  preview_url?: string | null;
  previewUrl?: string | null;
  build_duration_ms?: number;
  buildDurationMs?: number;
  error_message?: string | null;
  errorMessage?: string | null;
  created_at?: string;
  createdAt?: string;
  events?: {
    id: string;
    from_status?: string;
    to_status?: string;
    event_message: string;
    timestamp: string;
  }[];
  logs?: {
    id: number | string;
    deployment_id: string;
    step: string;
    message: string;
    log_level: 'INFO' | 'WARN' | 'ERROR';
    timestamp: string;
  }[];
}

export interface EnvVarData {
  id: string;
  projectId?: string;
  key: string;
  value: string;
  target: 'PRODUCTION' | 'PREVIEW' | 'ALL';
  createdAt: string;
  updatedAt: string;
}

export const api = {
  // Projects
  async getProjects(): Promise<ProjectData[]> {
    try {
      const res = await fetchJson<{ success: boolean; data: ProjectData[] }>('/api/projects');
      return res.data || [];
    } catch {
      return [];
    }
  },

  async getProject(id: string): Promise<ProjectData | null> {
    try {
      const res = await fetchJson<{ success: boolean; data: ProjectData }>(`/api/projects/${id}`);
      return res.data;
    } catch {
      return null;
    }
  },

  async createProject(data: Partial<ProjectData>): Promise<ProjectData> {
    const res = await fetchJson<{ success: boolean; data: ProjectData }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res.data;
  },

  async updateProject(id: string, data: Partial<ProjectData>): Promise<ProjectData> {
    const res = await fetchJson<{ success: boolean; data: ProjectData }>(`/api/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return res.data;
  },

  async deleteProject(id: string): Promise<void> {
    await fetchJson(`/api/projects/${id}`, { method: 'DELETE' });
  },

  // Environment Variables
  async getProjectEnv(id: string, reveal: boolean = false): Promise<EnvVarData[]> {
    try {
      const res = await fetchJson<{ success: boolean; data: EnvVarData[] }>(
        `/api/projects/${id}/env?reveal=${reveal}`
      );
      return res.data || [];
    } catch {
      return [];
    }
  },

  async addProjectEnv(
    id: string,
    data: { key: string; value: string; target?: 'PRODUCTION' | 'PREVIEW' | 'ALL' }
  ): Promise<EnvVarData> {
    const res = await fetchJson<{ success: boolean; data: EnvVarData }>(`/api/projects/${id}/env`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res.data;
  },

  async deleteProjectEnv(id: string, varId: string): Promise<void> {
    await fetchJson(`/api/projects/${id}/env/${varId}`, { method: 'DELETE' });
  },

  // Deployments
  async getDeployments(limit: number = 20, projectId?: string): Promise<DeploymentData[]> {
    try {
      const url = projectId
        ? `/api/deployments?limit=${limit}&projectId=${projectId}`
        : `/api/deployments?limit=${limit}`;
      const res = await fetchJson<{ deployments: DeploymentData[] }>(url);
      return res.deployments || [];
    } catch {
      return [];
    }
  },

  async getDeployment(id: string): Promise<DeploymentData | null> {
    try {
      return await fetchJson<DeploymentData>(`/api/deployments/${id}`);
    } catch {
      return null;
    }
  },

  async createDeployment(data: {
    project_name: string;
    repo_url?: string;
    branch?: string;
    commit_hash?: string;
  }): Promise<DeploymentData> {
    return await fetchJson<DeploymentData>('/api/deployments', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async cancelDeployment(id: string): Promise<void> {
    await fetchJson(`/api/deployments/${id}/cancel`, { method: 'POST' });
  },

  async promoteDeployment(id: string): Promise<{ success: boolean; message: string; current_deployment_id: string; data?: DeploymentData }> {
    return await fetchJson<{ success: boolean; message: string; current_deployment_id: string; data?: DeploymentData }>(
      `/api/deployments/${id}/promote`,
      { method: 'POST' }
    );
  },

  async rollbackDeployment(id: string): Promise<{ success: boolean; message: string; current_deployment_id: string; data?: DeploymentData }> {
    return await fetchJson<{ success: boolean; message: string; current_deployment_id: string; data?: DeploymentData }>(
      `/api/deployments/${id}/rollback`,
      { method: 'POST' }
    );
  },

  // System
  async getHealth(): Promise<any> {
    try {
      return await fetchJson('/health');
    } catch {
      return { status: 'offline' };
    }
  },

  async getStats(): Promise<any> {
    try {
      return await fetchJson('/api/v1/stats');
    } catch {
      return { total_deployments: 0, active_queue_jobs: 0, status_counts: {}, success_rate: 100 };
    }
  },
};
