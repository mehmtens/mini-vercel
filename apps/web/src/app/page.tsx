'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  FolderGit2,
  ExternalLink,
  GitBranch,
  Clock,
  Play,
  AlertCircle,
  Loader2,
  Search,
  Plus,
  ArrowUpRight,
  Layers,
  Zap,
  Activity,
} from 'lucide-react';
import { api, ProjectData, DeploymentData } from '../lib/api';
import { projectUrl } from '../lib/urls';

export default function DashboardPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [deployments, setDeployments] = useState<DeploymentData[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [selectedFramework, setSelectedFramework] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [deployingId, setDeployingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [projData, depData, statsData] = await Promise.all([
        api.getProjects(),
        api.getDeployments(10),
        api.getStats(),
      ]);
      setProjects(projData);
      setDeployments(depData);
      setStats(statsData);
    } catch {
      // Offline fallback
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetching dashboard data is the external synchronization performed by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadData();
    const interval = setInterval(() => void loadData(), 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  async function handleQuickDeploy(project: ProjectData, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDeployingId(project.id);
    try {
      const deployment = await api.createDeployment({
        project_name: project.name,
        repo_url: project.repoUrl,
        branch: project.branch,
      });
      router.push(`/deployments/${deployment.id}`);
    } catch (err: any) {
      alert(`Deployment failed: ${err.message}`);
      setDeployingId(null);
    }
  }

  const filteredProjects = projects.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.slug.toLowerCase().includes(search.toLowerCase()) ||
      p.repoName.toLowerCase().includes(search.toLowerCase());
    const matchesFramework =
      selectedFramework === 'all' ||
      p.framework.toLowerCase() === selectedFramework.toLowerCase();
    return matchesSearch && matchesFramework;
  });

  const getStatusBadge = (status?: string) => {
    switch (status) {
      case 'READY':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Ready
          </span>
        );
      case 'BUILDING':
      case 'INITIALIZING':
      case 'CLONING':
      case 'UPLOADING':
      case 'DEPLOYING':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Loader2 className="w-3 h-3 animate-spin" />
            Building
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <AlertCircle className="w-3 h-3" />
            Failed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <Clock className="w-3 h-3" />
            Queued
          </span>
        );
    }
  };

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* 1. Metric Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-panel p-5 rounded-2xl flex items-center justify-between border-white/[0.08]">
          <div>
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Total Projects</p>
            <h3 className="text-2xl font-bold text-white mt-1">{projects.length}</h3>
          </div>
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 text-blue-400 flex items-center justify-center border border-blue-500/20">
            <FolderGit2 className="w-5 h-5" />
          </div>
        </div>

        <div className="glass-panel p-5 rounded-2xl flex items-center justify-between border-white/[0.08]">
          <div>
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Total Deployments</p>
            <h3 className="text-2xl font-bold text-white mt-1">
              {stats?.total_deployments ?? deployments.length}
            </h3>
          </div>
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center border border-indigo-500/20">
            <Layers className="w-5 h-5" />
          </div>
        </div>

        <div className="glass-panel p-5 rounded-2xl flex items-center justify-between border-white/[0.08]">
          <div>
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Active Queue Jobs</p>
            <h3 className="text-2xl font-bold text-white mt-1">
              {stats?.active_queue_jobs ?? 0}
            </h3>
          </div>
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center border border-amber-500/20">
            <Zap className="w-5 h-5" />
          </div>
        </div>

        <div className="glass-panel p-5 rounded-2xl flex items-center justify-between border-white/[0.08]">
          <div>
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Avg Build Duration</p>
            <h3 className="text-2xl font-bold text-white mt-1">
              {stats?.avg_build_time_ms ? `${(stats.avg_build_time_ms / 1000).toFixed(1)}s` : '—'}
            </h3>
          </div>
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center border border-emerald-500/20">
            <Activity className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* 2. Search & Filtering Header */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            type="text"
            placeholder="Search projects by name, slug or repository..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all"
          />
        </div>

        <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
          {['all', 'nextjs', 'astro', 'vite', 'static'].map((fw) => (
            <button
              key={fw}
              onClick={() => setSelectedFramework(fw)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${
                selectedFramework === fw
                  ? 'bg-blue-600 text-white'
                  : 'bg-white/[0.04] text-zinc-400 hover:text-white border border-white/[0.06]'
              }`}
            >
              {fw === 'all' ? 'All Frameworks' : fw}
            </button>
          ))}
        </div>
      </div>

      {/* 3. Project Cards Grid */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white tracking-tight">Your Projects</h2>
          <span className="text-xs text-zinc-400">{filteredProjects.length} projects found</span>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[1, 2, 3].map((i) => (
              <div key={i} className="glass-panel p-6 rounded-2xl h-48 animate-pulse bg-white/[0.02]" />
            ))}
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="glass-panel p-12 rounded-2xl text-center border-dashed border-white/[0.12]">
            <FolderGit2 className="w-12 h-12 text-zinc-500 mx-auto mb-3" />
            <h3 className="text-base font-semibold text-white">No projects found</h3>
            <p className="text-sm text-zinc-400 max-w-sm mx-auto mt-1 mb-5">
              {search
                ? `No projects matching "${search}". Try searching for another name.`
                : 'Get started by creating your first deployment pipeline.'}
            </p>
            <Link
              href="/new"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Deploy New Project
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filteredProjects.map((project) => {
              const currentStatus = project.currentDeployment?.status || 'READY';
              const previewUrl =
                project.currentDeployment?.previewUrl ||
                projectUrl(project.slug);

              return (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="glass-panel glass-panel-hover p-6 rounded-2xl flex flex-col justify-between group border-white/[0.08]"
                >
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-bold text-base text-white group-hover:text-blue-400 transition-colors flex items-center gap-1.5">
                          {project.name}
                          <ArrowUpRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity text-blue-400" />
                        </h3>
                        <p className="text-xs font-mono text-zinc-400 mt-0.5">{project.slug}</p>
                      </div>
                      {getStatusBadge(currentStatus)}
                    </div>

                    {/* Repo & Branch info */}
                    <div className="flex items-center gap-2 mt-4 text-xs text-zinc-400">
                      <span className="inline-flex items-center gap-1 font-mono text-zinc-300">
                        <GitBranch className="w-3.5 h-3.5 text-blue-400" />
                        {project.branch}
                      </span>
                      <span>•</span>
                      <span className="truncate max-w-[150px]">{project.repoName}</span>
                    </div>

                    {/* Preview Domain */}
                    <div className="mt-3">
                      <a
                        href={previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-blue-400 truncate max-w-full font-mono transition-colors"
                      >
                        <span className="truncate">{previewUrl.replace(/^https?:\/\//, '')}</span>
                        <ExternalLink className="w-3 h-3 flex-shrink-0" />
                      </a>
                    </div>
                  </div>

                  {/* Card Bottom Meta & Actions */}
                  <div className="pt-5 mt-5 border-t border-white/[0.06] flex items-center justify-between text-xs">
                    <span className="text-zinc-500">
                      {project._count?.deployments || 0} deployments
                    </span>

                    <button
                      onClick={(e) => handleQuickDeploy(project, e)}
                      disabled={deployingId === project.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-blue-600 hover:text-white text-zinc-300 font-medium transition-all"
                    >
                      {deployingId === project.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Play className="w-3 h-3 fill-current" />
                      )}
                      <span>Deploy</span>
                    </button>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* 4. Recent Activity Stream */}
      <div id="activity" className="pt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-400" />
            Recent Deployment Activity
          </h2>
          <span className="text-xs text-zinc-400">Live platform events</span>
        </div>

        <div className="glass-panel rounded-2xl overflow-hidden border-white/[0.08]">
          {deployments.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-400">
              No recent deployments recorded.
            </div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {deployments.map((dep) => {
                const commit = (dep.commit_hash || dep.commitHash || 'c8f12a3').slice(0, 7);
                const message = dep.commit_message || dep.commitMessage || `Commit ${commit}`;
                const projectName = dep.project_name || 'project';
                const duration = dep.build_duration_ms || dep.buildDurationMs;

                return (
                  <Link
                    key={dep.id}
                    href={`/deployments/${dep.id}`}
                    className="p-4 sm:px-6 flex items-center justify-between gap-4 hover:bg-white/[0.02] transition-colors group"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-white/[0.04] border border-white/[0.08] flex items-center justify-center font-bold text-xs text-zinc-300">
                        ▲
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-white group-hover:text-blue-400 transition-colors truncate">
                            {projectName}
                          </span>
                          <span className="text-xs font-mono text-zinc-500">({commit})</span>
                        </div>
                        <p className="text-xs text-zinc-400 truncate max-w-md">{message}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 flex-shrink-0">
                      {duration ? (
                        <span className="hidden sm:inline-block text-xs font-mono text-zinc-500">
                          {(duration / 1000).toFixed(1)}s
                        </span>
                      ) : null}
                      {getStatusBadge(dep.status)}
                      <ArrowUpRight className="w-4 h-4 text-zinc-600 group-hover:text-white transition-colors" />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
