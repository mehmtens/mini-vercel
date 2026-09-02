'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  GitBranch,
  Github,
  ExternalLink,
  Layers,
  Lock,
  Settings,
  Play,
  RotateCcw,
  Eye,
  EyeOff,
  Trash2,
  Plus,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowUpRight,
  ArrowUpCircle,
  ShieldCheck,
} from 'lucide-react';
import { api, ProjectData, DeploymentData, EnvVarData } from '../../../lib/api';

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [project, setProject] = useState<ProjectData | null>(null);
  const [deployments, setDeployments] = useState<DeploymentData[]>([]);
  const [envVars, setEnvVars] = useState<EnvVarData[]>([]);
  const [activeTab, setActiveTab] = useState<'deployments' | 'env' | 'settings'>('deployments');
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  // New Env Form State
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newTarget, setNewTarget] = useState<'PRODUCTION' | 'PREVIEW' | 'ALL'>('ALL');
  const [addingEnv, setAddingEnv] = useState(false);

  const loadProjectData = useCallback(async () => {
    try {
      const [proj, deps, envs] = await Promise.all([
        api.getProject(projectId),
        api.getDeployments(20, projectId),
        api.getProjectEnv(projectId, false),
      ]);
      setProject(proj);
      setDeployments(deps);
      setEnvVars(envs);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // Loading project data is the external synchronization performed by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadProjectData();
  }, [loadProjectData]);

  async function handleDeployNew() {
    if (!project) return;
    setDeploying(true);
    try {
      const dep = await api.createDeployment({
        project_name: project.name,
        repo_url: project.repoUrl,
        branch: project.branch,
      });
      router.push(`/deployments/${dep.id}`);
    } catch (err: any) {
      alert(`Failed to trigger deployment: ${err.message}`);
      setDeploying(false);
    }
  }

  const [promotingId, setPromotingId] = useState<string | null>(null);

  async function handlePromote(deploymentId: string) {
    if (!confirm('Promote this deployment to production? Live production traffic will immediately route to this build.')) return;
    setPromotingId(deploymentId);
    try {
      await api.promoteDeployment(deploymentId);
      await loadProjectData();
    } catch (err: any) {
      alert(`Promote failed: ${err.message}`);
    } finally {
      setPromotingId(null);
    }
  }

  async function handleRollback(deploymentId: string) {
    if (!confirm('Rollback production pointer to this previous deployment? Live production traffic will immediately switch.')) return;
    setRollingBackId(deploymentId);
    try {
      await api.rollbackDeployment(deploymentId);
      await loadProjectData();
    } catch (err: any) {
      alert(`Rollback failed: ${err.message}`);
    } finally {
      setRollingBackId(null);
    }
  }

  async function toggleRevealSecrets() {
    const nextState = !revealed;
    setRevealed(nextState);
    try {
      const envs = await api.getProjectEnv(projectId, nextState);
      setEnvVars(envs);
    } catch {
      // Ignore reveal error
    }
  }

  async function handleAddEnv(e: React.FormEvent) {
    e.preventDefault();
    if (!newKey.trim() || !newValue.trim()) return;
    setAddingEnv(true);
    try {
      await api.addProjectEnv(projectId, {
        key: newKey.trim(),
        value: newValue.trim(),
        target: newTarget,
      });
      setNewKey('');
      setNewValue('');
      const updatedEnvs = await api.getProjectEnv(projectId, revealed);
      setEnvVars(updatedEnvs);
    } catch (err: any) {
      alert(`Failed to save env var: ${err.message}`);
    } finally {
      setAddingEnv(false);
    }
  }

  async function handleDeleteEnv(varId: string) {
    if (!confirm('Delete this environment variable?')) return;
    try {
      await api.deleteProjectEnv(projectId, varId);
      setEnvVars(envVars.filter((v) => v.id !== varId));
    } catch (err: any) {
      alert(`Failed to delete: ${err.message}`);
    }
  }

  async function handleDeleteProject() {
    if (!confirm(`Are you sure you want to permanently delete "${project?.name}"?`)) return;
    try {
      await api.deleteProject(projectId);
      router.push('/');
    } catch (err: any) {
      alert(`Delete failed: ${err.message}`);
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'READY':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="w-3 h-3" />
            Ready
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <AlertCircle className="w-3 h-3" />
            Failed
          </span>
        );
      case 'CANCELLED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
            Cancelled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Loader2 className="w-3 h-3 animate-spin" />
            {status}
          </span>
        );
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-16 space-y-4">
        <h2 className="text-xl font-bold text-white">Project Not Found</h2>
        <p className="text-sm text-zinc-400">The project you requested does not exist.</p>
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-blue-400 hover:underline">
          <ArrowLeft className="w-4 h-4" /> Back to projects
        </Link>
      </div>
    );
  }

  const productionUrl = `http://${project.slug}.localhost`;

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* 1. Breadcrumbs & Header */}
      <div className="space-y-4">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-xs font-medium text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Overview
        </Link>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                {project.name}
              </h1>
              <span className="px-2.5 py-0.5 rounded-lg text-xs font-mono bg-white/[0.06] text-zinc-400 border border-white/[0.08]">
                {project.framework}
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs text-zinc-400">
              <a
                href={project.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-white transition-colors"
              >
                <Github className="w-3.5 h-3.5" />
                {project.repoName}
              </a>
              <span>•</span>
              <span className="inline-flex items-center gap-1 font-mono text-zinc-300">
                <GitBranch className="w-3.5 h-3.5 text-blue-400" />
                {project.branch}
              </span>
              <span>•</span>
              <a
                href={productionUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-blue-400 hover:underline font-mono"
              >
                {project.slug}.localhost
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={handleDeployNew}
              disabled={deploying}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm shadow-md shadow-blue-500/20 active:scale-95 transition-all disabled:opacity-50"
            >
              {deploying ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4 fill-current" />
              )}
              <span>Deploy Branch</span>
            </button>
          </div>
        </div>
      </div>

      {/* 2. Navigation Tabs */}
      <div className="border-b border-white/[0.08] flex items-center gap-6 text-sm font-medium">
        <button
          onClick={() => setActiveTab('deployments')}
          className={`pb-3 relative transition-colors ${
            activeTab === 'deployments' ? 'text-white' : 'text-zinc-400 hover:text-white'
          }`}
        >
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4" />
            <span>Deployments</span>
            <span className="px-1.5 py-0.5 rounded text-[11px] bg-white/[0.06] text-zinc-400">
              {deployments.length}
            </span>
          </div>
          {activeTab === 'deployments' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-full" />
          )}
        </button>

        <button
          onClick={() => setActiveTab('env')}
          className={`pb-3 relative transition-colors ${
            activeTab === 'env' ? 'text-white' : 'text-zinc-400 hover:text-white'
          }`}
        >
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4" />
            <span>Environment Variables</span>
            <span className="px-1.5 py-0.5 rounded text-[11px] bg-white/[0.06] text-zinc-400">
              {envVars.length}
            </span>
          </div>
          {activeTab === 'env' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-full" />
          )}
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`pb-3 relative transition-colors ${
            activeTab === 'settings' ? 'text-white' : 'text-zinc-400 hover:text-white'
          }`}
        >
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </div>
          {activeTab === 'settings' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-full" />
          )}
        </button>
      </div>

      {/* 3. Tab Contents */}

      {/* TAB 1: Deployments History & Rollback */}
      {activeTab === 'deployments' && (
        <div className="space-y-4">
          <div className="glass-panel rounded-2xl overflow-hidden border-white/[0.08]">
            {deployments.length === 0 ? (
              <div className="p-12 text-center text-sm text-zinc-400 space-y-3">
                <p>No deployments have been created for this project yet.</p>
                <button
                  onClick={handleDeployNew}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Run First Deployment
                </button>
              </div>
            ) : (
              <div className="divide-y divide-white/[0.04]">
                {deployments.map((dep) => {
                  const commit = (dep.commit_hash || dep.commitHash || 'a1b2c3d').slice(0, 7);
                  const message = dep.commit_message || dep.commitMessage || `Commit ${commit}`;
                  const isCurrent = project.currentDeploymentId === dep.id;
                  const duration = dep.build_duration_ms || dep.buildDurationMs;

                  return (
                    <div
                      key={dep.id}
                      className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-white/[0.02] transition-colors"
                    >
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link
                            href={`/deployments/${dep.id}`}
                            className="font-bold text-sm text-white hover:text-blue-400 transition-colors flex items-center gap-1.5"
                          >
                            {dep.id.slice(0, 8)}
                            <ArrowUpRight className="w-3.5 h-3.5 text-zinc-500" />
                          </Link>
                          {getStatusBadge(dep.status)}
                          {isCurrent && (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                              Current Active
                            </span>
                          )}
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-white/[0.04] text-zinc-400">
                            {dep.trigger}
                          </span>
                        </div>

                        <p className="text-xs text-zinc-300 truncate max-w-xl">{message}</p>

                        <div className="flex items-center gap-3 text-[11px] text-zinc-500 font-mono">
                          <span>branch: {dep.branch}</span>
                          <span>•</span>
                          <span>commit: {commit}</span>
                          {duration && (
                            <>
                              <span>•</span>
                              <span>build: {(duration / 1000).toFixed(1)}s</span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Right Action Buttons */}
                      <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap flex-shrink-0">
                        {(dep.preview_url || dep.previewUrl) && (
                          <a
                            href={dep.preview_url || dep.previewUrl || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 hover:text-white border border-white/[0.06] text-xs font-medium transition-colors"
                            title="Open Preview URL"
                          >
                            <ExternalLink className="w-3 h-3" />
                            <span>Preview</span>
                          </a>
                        )}

                        {dep.status === 'READY' && !isCurrent && (
                          <button
                            onClick={() => handlePromote(dep.id)}
                            disabled={promotingId === dep.id || rollingBackId === dep.id}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-600 text-emerald-400 hover:text-white border border-emerald-500/20 text-xs font-semibold transition-all disabled:opacity-50"
                            title="Promote this deployment to active production"
                          >
                            {promotingId === dep.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <ArrowUpCircle className="w-3 h-3" />
                            )}
                            <span>Promote</span>
                          </button>
                        )}

                        {dep.status === 'READY' && !isCurrent && (
                          <button
                            onClick={() => handleRollback(dep.id)}
                            disabled={rollingBackId === dep.id || promotingId === dep.id}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-600 text-amber-400 hover:text-white border border-amber-500/20 text-xs font-semibold transition-all disabled:opacity-50"
                            title="Instant rollback production to this deployment version"
                          >
                            {rollingBackId === dep.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <RotateCcw className="w-3 h-3" />
                            )}
                            <span>Rollback</span>
                          </button>
                        )}

                        <Link
                          href={`/deployments/${dep.id}`}
                          className="px-2.5 py-1.5 rounded-lg bg-blue-600/10 hover:bg-blue-600 text-blue-400 hover:text-white border border-blue-500/20 text-xs font-semibold transition-all"
                        >
                          Logs
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Encrypted Environment Variables */}
      {activeTab === 'env' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Project Secrets & Environment Variables
              </h3>
              <p className="text-xs text-zinc-400 mt-0.5">
                Variables are securely stored with AES-256-GCM encryption and injected during isolated sandbox builds.
              </p>
            </div>

            <button
              onClick={toggleRevealSecrets}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-xs font-medium text-zinc-300 transition-colors"
            >
              {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              <span>{revealed ? 'Hide Values' : 'Reveal Values'}</span>
            </button>
          </div>

          {/* Add New Variable Form */}
          <form onSubmit={handleAddEnv} className="glass-panel p-5 rounded-2xl border-white/[0.08] space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">Add Environment Variable</h4>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <input
                type="text"
                required
                placeholder="VARIABLE_NAME"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                className="flex-1 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-xs text-white font-mono placeholder:text-zinc-500 uppercase focus:outline-none focus:border-blue-500"
              />
              <input
                type="text"
                required
                placeholder="Secret value..."
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                className="flex-1 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-xs text-white font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500"
              />
              <select
                value={newTarget}
                onChange={(e) => setNewTarget(e.target.value as any)}
                className="px-3 py-2 rounded-xl bg-[#12141a] border border-white/[0.08] text-xs text-zinc-300 focus:outline-none focus:border-blue-500 font-medium"
              >
                <option value="ALL">All Environments</option>
                <option value="PRODUCTION">Production Only</option>
                <option value="PREVIEW">Preview Only</option>
              </select>

              <button
                type="submit"
                disabled={addingEnv}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {addingEnv ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                <span>Save</span>
              </button>
            </div>
          </form>

          {/* List of Variables */}
          <div className="glass-panel rounded-2xl overflow-hidden border-white/[0.08]">
            {envVars.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-400">
                No environment variables configured for this project.
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="bg-white/[0.02] border-b border-white/[0.06] text-zinc-400 font-semibold">
                  <tr>
                    <th className="p-3.5 pl-5">Key</th>
                    <th className="p-3.5">Target</th>
                    <th className="p-3.5">Value</th>
                    <th className="p-3.5 pr-5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04] font-mono">
                  {envVars.map((env) => (
                    <tr key={env.id} className="hover:bg-white/[0.02]">
                      <td className="p-3.5 pl-5 font-bold text-white">{env.key}</td>
                      <td className="p-3.5">
                        <span className="px-2 py-0.5 rounded text-[10px] bg-white/[0.04] text-zinc-400">
                          {env.target}
                        </span>
                      </td>
                      <td className="p-3.5 text-zinc-400 truncate max-w-xs">{env.value}</td>
                      <td className="p-3.5 pr-5 text-right">
                        <button
                          onClick={() => handleDeleteEnv(env.id)}
                          className="p-1.5 text-zinc-500 hover:text-rose-400 transition-colors"
                          title="Delete Variable"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Settings */}
      {activeTab === 'settings' && (
        <div className="space-y-6">
          <div className="glass-panel p-6 rounded-2xl border-white/[0.08] space-y-4">
            <h3 className="text-base font-bold text-white">Build Configuration</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
              <div>
                <span className="text-zinc-500 block mb-1">Root Directory</span>
                <span className="p-2.5 rounded-lg bg-white/[0.04] text-white block">
                  {project.rootDirectory || '/'}
                </span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-1">Build Command</span>
                <span className="p-2.5 rounded-lg bg-white/[0.04] text-white block">
                  {project.buildCommand || 'npm run build'}
                </span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-1">Output Directory</span>
                <span className="p-2.5 rounded-lg bg-white/[0.04] text-white block">
                  {project.outputDirectory || 'dist'}
                </span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-1">Install Command</span>
                <span className="p-2.5 rounded-lg bg-white/[0.04] text-white block">
                  {project.installCommand || 'npm install'}
                </span>
              </div>
            </div>
          </div>

          {/* Danger Zone */}
          <div className="glass-panel p-6 rounded-2xl border-rose-500/20 bg-rose-950/10 space-y-4">
            <h3 className="text-base font-bold text-rose-400">Danger Zone</h3>
            <p className="text-xs text-zinc-400">
              Permanently delete this project and all associated deployments, artifacts, and secrets.
            </p>
            <button
              onClick={handleDeleteProject}
              className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs transition-colors"
            >
              Delete Project
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
