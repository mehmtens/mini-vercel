'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Github,
  Lock,
  Plus,
  Trash2,
  Rocket,
  Loader2,
  Code2,
  FolderTree,
  Sparkles,
} from 'lucide-react';
import { api } from '../../lib/api';

interface EnvVarRow {
  key: string;
  value: string;
  target: 'PRODUCTION' | 'PREVIEW' | 'ALL';
}

const FRAMEWORK_PRESETS = [
  {
    id: 'nextjs',
    name: 'Next.js',
    icon: '▲',
    buildCommand: 'npm run build',
    outputDir: 'dist',
    installCommand: 'npm install',
  },
  {
    id: 'vite',
    name: 'Vite / React',
    icon: '⚡',
    buildCommand: 'npm run build',
    outputDir: 'dist',
    installCommand: 'npm install',
  },
  {
    id: 'astro',
    name: 'Astro',
    icon: '🚀',
    buildCommand: 'npm run build',
    outputDir: 'dist',
    installCommand: 'npm install',
  },
  {
    id: 'static',
    name: 'HTML / Static',
    icon: '📄',
    buildCommand: 'echo "Static build complete"',
    outputDir: 'public',
    installCommand: '',
  },
  {
    id: 'custom',
    name: 'Custom',
    icon: '🛠️',
    buildCommand: 'npm run build',
    outputDir: 'dist',
    installCommand: 'npm install',
  },
];

export default function NewProjectPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [rootDirectory, setRootDirectory] = useState('/');
  const [framework, setFramework] = useState('nextjs');
  const [buildCommand, setBuildCommand] = useState('npm run build');
  const [outputDirectory, setOutputDirectory] = useState('dist');
  const [installCommand, setInstallCommand] = useState('npm install');

  // Environment Variables
  const [envVars, setEnvVars] = useState<EnvVarRow[]>([
    { key: 'NODE_ENV', value: 'production', target: 'ALL' },
  ]);

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  const handleFrameworkSelect = (presetId: string) => {
    setFramework(presetId);
    const preset = FRAMEWORK_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setBuildCommand(preset.buildCommand);
      setOutputDirectory(preset.outputDir);
      setInstallCommand(preset.installCommand);
    }
  };

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: '', value: '', target: 'ALL' }]);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  const updateEnvVar = (index: number, field: keyof EnvVarRow, val: string) => {
    const updated = [...envVars];
    (updated[index] as any)[field] = val;
    setEnvVars(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please provide a project name');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 1. Create Project
      const project = await api.createProject({
        name: name.trim(),
        slug: slug || name.trim().toLowerCase(),
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || 'main',
        rootDirectory: rootDirectory.trim() || '/',
        framework,
        buildCommand,
        outputDirectory,
        installCommand,
      });

      // 2. Add Environment Variables (Encrypted on backend)
      const validEnvVars = envVars.filter((v) => v.key.trim() && v.value.trim());
      for (const env of validEnvVars) {
        try {
          await api.addProjectEnv(project.id, {
            key: env.key.trim(),
            value: env.value.trim(),
            target: env.target,
          });
        } catch (envErr) {
          console.warn('Failed to add env var:', envErr);
        }
      }

      // 3. Trigger first deployment
      const deployment = await api.createDeployment({
        project_name: project.name,
        repo_url: project.repoUrl,
        branch: project.branch,
      });

      // 4. Navigate to live logs
      router.push(`/deployments/${deployment.id}`);
    } catch (err: any) {
      setError(err.message || 'Failed to initialize project');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-fadeIn">
      {/* Breadcrumb & Header */}
      <div className="flex items-center justify-between">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Projects
        </Link>
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight flex items-center gap-2.5">
          <Sparkles className="w-6 h-6 text-blue-400" />
          Deploy New Project
        </h1>
        <p className="text-sm text-zinc-400">
          Configure repository settings, framework presets, and encrypted environment variables.
        </p>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm font-medium">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Section 1: Git Repository & Naming */}
        <div className="glass-panel p-6 sm:p-8 rounded-2xl space-y-5 border-white/[0.08]">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Github className="w-4 h-4 text-blue-400" />
            Repository Details
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-zinc-300">Project Name</label>
              <input
                type="text"
                required
                placeholder="my-cool-app"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all font-medium"
              />
              {slug && (
                <p className="text-[11px] text-zinc-500 font-mono">
                  Domain preview: {slug}.localhost
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-zinc-300">Production Branch</label>
              <input
                type="text"
                placeholder="main"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all font-mono"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300">GitHub Repository URL</label>
            <input
              type="url"
              required
              placeholder="https://github.com/username/repository"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
              <FolderTree className="w-3.5 h-3.5 text-zinc-400" />
              Root Directory
            </label>
            <input
              type="text"
              placeholder="/"
              value={rootDirectory}
              onChange={(e) => setRootDirectory(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all font-mono"
            />
          </div>
        </div>

        {/* Section 2: Framework & Build Settings */}
        <div className="glass-panel p-6 sm:p-8 rounded-2xl space-y-5 border-white/[0.08]">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Code2 className="w-4 h-4 text-indigo-400" />
            Framework & Build Pipeline
          </h3>

          {/* Framework Presets */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            {FRAMEWORK_PRESETS.map((p) => {
              const isSelected = framework === p.id;
              return (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => handleFrameworkSelect(p.id)}
                  className={`p-3 rounded-xl border text-center flex flex-col items-center gap-1.5 transition-all ${
                    isSelected
                      ? 'bg-blue-600/10 border-blue-500 text-white shadow-lg shadow-blue-500/10'
                      : 'bg-white/[0.02] border-white/[0.06] text-zinc-400 hover:text-white hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="text-lg">{p.icon}</span>
                  <span className="text-xs font-semibold">{p.name}</span>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-zinc-300">Install Command</label>
              <input
                type="text"
                placeholder="npm install"
                value={installCommand}
                onChange={(e) => setInstallCommand(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-xs text-white font-mono focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-zinc-300">Build Command</label>
              <input
                type="text"
                placeholder="npm run build"
                value={buildCommand}
                onChange={(e) => setBuildCommand(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-xs text-white font-mono focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-zinc-300">Output Directory</label>
              <input
                type="text"
                placeholder="dist"
                value={outputDirectory}
                onChange={(e) => setOutputDirectory(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-xs text-white font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Section 3: Encrypted Environment Variables */}
        <div className="glass-panel p-6 sm:p-8 rounded-2xl space-y-5 border-white/[0.08]">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Lock className="w-4 h-4 text-amber-400" />
              Environment Variables
            </h3>
            <span className="text-[11px] text-amber-400/90 font-medium px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
              AES-256-GCM Encrypted
            </span>
          </div>

          <div className="space-y-3">
            {envVars.map((env, idx) => (
              <div key={idx} className="flex items-center gap-2.5">
                <input
                  type="text"
                  placeholder="KEY"
                  value={env.key}
                  onChange={(e) => updateEnvVar(idx, 'key', e.target.value)}
                  className="flex-1 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-xs text-white font-mono placeholder:text-zinc-500 uppercase focus:outline-none focus:border-blue-500"
                />
                <input
                  type="text"
                  placeholder="value"
                  value={env.value}
                  onChange={(e) => updateEnvVar(idx, 'value', e.target.value)}
                  className="flex-1 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-xs text-white font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500"
                />
                <select
                  value={env.target}
                  onChange={(e) => updateEnvVar(idx, 'target', e.target.value as any)}
                  className="px-2.5 py-2 rounded-xl bg-[#12141a] border border-white/[0.08] text-xs text-zinc-300 focus:outline-none focus:border-blue-500 font-medium"
                >
                  <option value="ALL">All Environments</option>
                  <option value="PRODUCTION">Production</option>
                  <option value="PREVIEW">Preview</option>
                </select>
                {envVars.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeEnvVar(idx)}
                    className="p-2 text-zinc-500 hover:text-rose-400 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}

            <button
              type="button"
              onClick={addEnvVar}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-400 hover:text-blue-300 pt-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add another variable
            </button>
          </div>
        </div>

        {/* Submit Action */}
        <div className="flex items-center justify-end gap-3 pt-4">
          <Link
            href="/"
            className="px-5 py-2.5 rounded-xl text-sm font-semibold text-zinc-400 hover:text-white transition-colors"
          >
            Cancel
          </Link>

          <button
            type="submit"
            disabled={loading}
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm shadow-lg shadow-blue-500/25 active:scale-95 transition-all disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Initializing Pipeline...</span>
              </>
            ) : (
              <>
                <Rocket className="w-4 h-4" />
                <span>Deploy Project</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
