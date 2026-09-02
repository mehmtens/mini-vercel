'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Terminal,
  ExternalLink,
  GitBranch,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Ban,
  RotateCcw,
  ArrowUpCircle,
  Copy,
  Check,
  Search,
  Radio,
  ArrowDown,
  Archive,
  WifiOff,
  RefreshCw,
  Clock,
  Keyboard,
} from 'lucide-react';
import { api, DeploymentData } from '../../../lib/api';

interface StreamLogItem {
  id?: number | string;
  sequence?: number;
  step?: string;
  message: string;
  log_level?: string;
  timestamp?: string;
}

type StreamState = 'live' | 'reconnecting' | 'history' | 'cancelled' | 'failed' | 'disconnected';

const PIPELINE_STAGES = [
  { id: 'QUEUED', label: 'Queued' },
  { id: 'INITIALIZING', label: 'Initialize' },
  { id: 'CLONING', label: 'Clone' },
  { id: 'BUILDING', label: 'Build Sandbox' },
  { id: 'UPLOADING', label: 'Artifact Upload' },
  { id: 'DEPLOYING', label: 'Edge Propagation' },
  { id: 'READY', label: 'Ready' },
];

export default function DeploymentDetailPage() {
  const params = useParams();
  const deploymentId = params?.id as string;

  const [deployment, setDeployment] = useState<DeploymentData | null>(null);
  const [logs, setLogs] = useState<StreamLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [logFilter, setLogFilter] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [streamState, setStreamState] = useState<StreamState>('disconnected');
  const [keyboardHelpOpen, setKeyboardHelpOpen] = useState(false);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const terminalViewerRef = useRef<HTMLDivElement>(null);
  const lastSequenceRef = useRef<number>(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTerminalRef = useRef<boolean>(false);

  const copyAllLogs = useCallback(() => {
    const text = logs.map((log) => log.message).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [logs]);

  const loadDeployment = useCallback(async () => {
    if (!deploymentId) return;
    try {
      const data = await api.getDeployment(deploymentId);
      if (data) {
        setDeployment(data);
        const terminal = ['READY', 'FAILED', 'CANCELLED'].includes(data.status);
        isTerminalRef.current = terminal;

        if (terminal) {
          if (data.status === 'FAILED') setStreamState('failed');
          else if (data.status === 'CANCELLED') setStreamState('cancelled');
          else setStreamState('history');
        }

        // Initialize logs from API if stream hasn't populated them
        if (data.logs && data.logs.length > 0) {
          setLogs((prev) => {
            if (prev.length === 0) {
              const items: StreamLogItem[] = data.logs!.map((l) => {
                const seq = typeof l.id === 'number' ? l.id : parseInt(String(l.id), 10);
                return {
                  id: l.id,
                  sequence: isNaN(seq) ? undefined : seq,
                  message: l.message,
                  step: l.step,
                  log_level: l.log_level,
                  timestamp: l.timestamp,
                };
              });
              lastSequenceRef.current = Math.max(
                lastSequenceRef.current,
                ...items.map((i) => (typeof i.sequence === 'number' ? i.sequence : 0))
              );
              return items;
            }
            return prev;
          });
        }
      }
    } catch (err) {
      console.error('Failed to load deployment metadata:', err);
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  // Connect SSE with Last-Event-ID replay and auto-reconnect
  const connectSSE = useCallback(() => {
    if (!deploymentId || isTerminalRef.current) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081';
    const lastSeq = lastSequenceRef.current;
    const url = `${apiBase}/api/deployments/${deploymentId}/logs/stream${lastSeq > 0 ? `?lastEventId=${lastSeq}` : ''}`;

    setStreamState((prev) => (prev === 'disconnected' || prev === 'reconnecting' ? 'reconnecting' : 'live'));

    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => {
      setStreamState('live');
    };

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const chunk = payload.logChunk || payload.message;
        const seq = payload.sequence || (event.lastEventId ? parseInt(event.lastEventId, 10) : undefined);

        if (seq && typeof seq === 'number') {
          lastSequenceRef.current = Math.max(lastSequenceRef.current, seq);
        }

        if (chunk) {
          setLogs((prev) => {
            // Deduplicate log lines by sequence or exact message+timestamp
            if (seq && prev.some((p) => p.sequence === seq)) {
              return prev;
            }
            return [
              ...prev,
              {
                sequence: seq,
                message: chunk,
                step: payload.stream || payload.step,
                timestamp: payload.timestamp || new Date().toISOString(),
              },
            ];
          });
        }
      } catch (err) {
        console.error('Failed to parse SSE log payload:', err);
      }
    };

    es.addEventListener('status', (event: any) => {
      try {
        const statusData = JSON.parse(event.data);
        if (statusData?.status) {
          setDeployment((prev) => (prev ? { ...prev, status: statusData.status } : null));
          if (['READY', 'FAILED', 'CANCELLED'].includes(statusData.status)) {
            isTerminalRef.current = true;
          }
        }
      } catch {
        // Ignore status event parsing error
      }
    });

    es.addEventListener('end', (event: any) => {
      es.close();
      eventSourceRef.current = null;
      try {
        const endData = JSON.parse(event.data || '{}');
        if (endData.status === 'FAILED') setStreamState('failed');
        else if (endData.status === 'CANCELLED') setStreamState('cancelled');
        else setStreamState('history');
      } catch {
        setStreamState('history');
      }
      loadDeployment();
    });

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;

      if (isTerminalRef.current) {
        setStreamState('history');
        return;
      }

      setStreamState('reconnecting');

      // Attempt automatic reconnect with Last-Event-ID after exponential backoff
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(() => {
        if (!isTerminalRef.current) {
          connectSSE();
        }
      }, 2500);
    };
  }, [deploymentId, loadDeployment]);

  // Initial load
  useEffect(() => {
    loadDeployment().then(() => {
      if (!isTerminalRef.current) {
        connectSSE();
      }
    });

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [deploymentId, loadDeployment, connectSSE]);

  // Scroll to bottom when new logs arrive if autoScroll is enabled
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is actively typing in an input or textarea
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        if (e.key === 'Escape') {
          target.blur();
          setLogFilter('');
        }
        return;
      }

      if (e.key === '/' || e.key === 'f') {
        e.preventDefault();
        filterInputRef.current?.focus();
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        copyAllLogs();
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        setAutoScroll((prev) => !prev);
      } else if (e.key === '?') {
        e.preventDefault();
        setKeyboardHelpOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [copyAllLogs]);

  async function handleCancel() {
    if (!confirm('Are you sure you want to cancel this active build?')) return;
    setCancelling(true);
    try {
      await api.cancelDeployment(deploymentId);
      await loadDeployment();
      setStreamState('cancelled');
    } catch (err: any) {
      alert(`Cancel failed: ${err.message}`);
    } finally {
      setCancelling(false);
    }
  }

  async function handlePromote() {
    if (!confirm('Promote this deployment to production? Live production traffic will immediately route to this build.')) return;
    setPromoting(true);
    try {
      const res = await api.promoteDeployment(deploymentId);
      alert(res.message || 'Deployment promoted to production successfully!');
      await loadDeployment();
    } catch (err: any) {
      alert(`Promote failed: ${err.message}`);
    } finally {
      setPromoting(false);
    }
  }

  async function handleRollback() {
    if (!confirm('Rollback production pointer to this deployment? Live production traffic will immediately switch.')) return;
    setRollingBack(true);
    try {
      const res = await api.rollbackDeployment(deploymentId);
      alert(res.message || 'Production pointer rolled back to this deployment successfully!');
      await loadDeployment();
    } catch (err: any) {
      alert(`Rollback failed: ${err.message}`);
    } finally {
      setRollingBack(false);
    }
  }

  const getStageIndex = (status?: string) => {
    if (!status) return 0;
    if (status === 'FAILED' || status === 'CANCELLED') return -1;
    return PIPELINE_STAGES.findIndex((s) => s.id === status);
  };

  const currentStageIdx = getStageIndex(deployment?.status);

  const formatLogLine = (message: string) => {
    if (message.startsWith('[CLONE]')) {
      return <span className="text-cyan-400 font-semibold">{message}</span>;
    }
    if (message.startsWith('[DEPENDENCIES]')) {
      return <span className="text-sky-400 font-semibold">{message}</span>;
    }
    if (message.startsWith('[BUILD]') || message.startsWith('[COMPILE]')) {
      return <span className="text-purple-400 font-semibold">{message}</span>;
    }
    if (message.startsWith('[STATIC_GEN]')) {
      return <span className="text-indigo-400">{message}</span>;
    }
    if (message.startsWith('[UPLOAD]')) {
      return <span className="text-amber-400 font-semibold">{message}</span>;
    }
    if (message.startsWith('[EDGE_DEPLOY]') || message.startsWith('[SUCCESS]') || message.startsWith('[DEPLOY]')) {
      return <span className="text-emerald-400 font-bold">{message}</span>;
    }
    if (message.startsWith('[ERROR]') || message.startsWith('[DOCKER_ERROR]')) {
      return <span className="text-rose-400 font-bold">{message}</span>;
    }
    if (message.startsWith('[CANCELLED]')) {
      return <span className="text-orange-400 font-bold">{message}</span>;
    }
    if (message.startsWith('[INIT]') || message.startsWith('[QUEUED]')) {
      return <span className="text-zinc-400">{message}</span>;
    }
    return <span className="text-zinc-300">{message}</span>;
  };

  const filteredLogs = logs.filter((l) =>
    l.message.toLowerCase().includes(logFilter.toLowerCase())
  );

  const isTerminal =
    deployment?.status === 'READY' ||
    deployment?.status === 'FAILED' ||
    deployment?.status === 'CANCELLED';

  const previewUrl =
    deployment?.preview_url ||
    deployment?.previewUrl ||
    (deployment?.project_slug
      ? `http://${deployment.project_slug}.localhost`
      : 'http://localhost');

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* 1. Header & Breadcrumbs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <Link
              href={deployment?.project_id ? `/projects/${deployment.project_id}` : '/'}
              className="hover:text-white transition-colors flex items-center gap-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {deployment?.project_name || 'Project'}
            </Link>
            <span>/</span>
            <span className="font-mono text-zinc-300">{deploymentId.slice(0, 8)}</span>
          </div>

          <h1 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight flex items-center gap-3">
            {deployment?.commit_message || deployment?.commitMessage || 'Deployment Pipeline'}
          </h1>

          <div className="flex items-center gap-3 text-xs text-zinc-400 font-mono flex-wrap">
            <span className="inline-flex items-center gap-1">
              <GitBranch className="w-3.5 h-3.5 text-blue-400" />
              {deployment?.branch || 'main'}
            </span>
            <span>•</span>
            <span>{(deployment?.commit_hash || deployment?.commitHash || '').slice(0, 7)}</span>
            {deployment?.build_duration_ms ? (
              <>
                <span>•</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3 h-3 text-zinc-500" />
                  {(deployment.build_duration_ms / 1000).toFixed(1)}s
                </span>
              </>
            ) : null}
          </div>
        </div>

        {/* Top Actions */}
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
          {!isTerminal && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-rose-600/10 hover:bg-rose-600 text-rose-400 hover:text-white border border-rose-500/20 text-xs font-bold transition-all disabled:opacity-50 min-h-[38px]"
            >
              {cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
              <span>Cancel Build</span>
            </button>
          )}

          {deployment?.status === 'READY' && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-white text-xs font-bold border border-white/[0.08] transition-all min-h-[38px]"
            >
              <span>Visit Preview</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}

          {deployment?.status === 'READY' && (
            <button
              onClick={handlePromote}
              disabled={promoting || rollingBack}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-500/20 transition-all disabled:opacity-50 min-h-[38px]"
            >
              {promoting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpCircle className="w-3.5 h-3.5" />}
              <span>Promote to Production</span>
            </button>
          )}

          {deployment?.status === 'READY' && (
            <button
              onClick={handleRollback}
              disabled={rollingBack || promoting}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-500/10 hover:bg-amber-600 text-amber-400 hover:text-white border border-amber-500/20 text-xs font-semibold transition-all disabled:opacity-50 min-h-[38px]"
            >
              {rollingBack ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
              <span>Rollback</span>
            </button>
          )}
        </div>
      </div>

      {/* 2. Visual Pipeline Progress Bar */}
      <div className="glass-panel p-4 sm:p-5 rounded-2xl border-white/[0.08] space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-white">Pipeline Execution Stages</span>
          <span className="font-mono text-zinc-400 font-medium capitalize">
            Status: {deployment?.status}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {PIPELINE_STAGES.map((stage, idx) => {
            const isCompleted = currentStageIdx > idx || deployment?.status === 'READY';
            const isCurrent = currentStageIdx === idx && deployment?.status !== 'READY';
            const isFailed = (deployment?.status === 'FAILED' || deployment?.status === 'CANCELLED') && currentStageIdx === idx;

            return (
              <div
                key={stage.id}
                className={`p-2.5 rounded-xl border text-center flex flex-col items-center justify-center gap-1 transition-all ${
                  isFailed
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                    : isCompleted
                    ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
                    : isCurrent
                    ? 'bg-blue-600/10 border-blue-500 text-blue-400 ring-1 ring-blue-500/50'
                    : 'bg-white/[0.02] border-white/[0.04] text-zinc-600'
                }`}
              >
                <div className="text-xs">
                  {isFailed ? (
                    <AlertCircle className="w-4 h-4 text-rose-400" />
                  ) : isCompleted ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : isCurrent ? (
                    <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-zinc-700 inline-block" />
                  )}
                </div>
                <span className="text-[11px] font-bold tracking-tight">{stage.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Status Warning Banners */}
      {deployment?.status === 'FAILED' && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold text-rose-200">Deployment Failed</p>
            <p className="text-zinc-300 font-mono text-[11px]">{deployment.error_message || deployment.errorMessage || 'An error occurred during build or sandbox execution.'}</p>
          </div>
        </div>
      )}

      {deployment?.status === 'CANCELLED' && (
        <div className="p-4 rounded-xl bg-orange-500/10 border border-orange-500/30 text-orange-300 text-xs flex items-start gap-3">
          <Ban className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold text-orange-200">Deployment Cancelled</p>
            <p className="text-zinc-300 text-[11px]">This build process was manually aborted before completion.</p>
          </div>
        </div>
      )}

      {/* 3. Realtime Dark Terminal Log Viewer */}
      <div
        ref={terminalViewerRef}
        tabIndex={0}
        role="region"
        aria-label="Deployment Build Output Logs"
        className="terminal-window rounded-2xl overflow-hidden shadow-2xl border border-white/[0.1] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
      >
        {/* Terminal Header Bar */}
        <div className="bg-[#0e1117] px-4 py-3 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full bg-rose-500/80" />
              <div className="w-3 h-3 rounded-full bg-amber-500/80" />
              <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
            </div>
            <div className="flex items-center gap-2 pl-2 border-l border-white/[0.1] text-xs font-mono text-zinc-400">
              <Terminal className="w-3.5 h-3.5 text-blue-400" />
              <span>build-output.log</span>
            </div>
          </div>

          {/* Stream Status Indicators */}
          <div className="flex items-center gap-2.5 flex-wrap">
            {streamState === 'live' && (
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
                <Radio className="w-3 h-3 animate-pulse" />
                Live SSE Stream
              </div>
            )}

            {streamState === 'reconnecting' && (
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-[10px] font-bold text-amber-400 uppercase tracking-wider">
                <RefreshCw className="w-3 h-3 animate-spin" />
                Reconnecting...
              </div>
            )}

            {streamState === 'history' && (
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-[10px] font-bold text-blue-400 uppercase tracking-wider">
                <Archive className="w-3 h-3" />
                Archived Log
              </div>
            )}

            {streamState === 'failed' && (
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-500/10 border border-rose-500/20 text-[10px] font-bold text-rose-400 uppercase tracking-wider">
                <AlertCircle className="w-3 h-3" />
                Failed Log
              </div>
            )}

            {streamState === 'cancelled' && (
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-orange-500/10 border border-orange-500/20 text-[10px] font-bold text-orange-400 uppercase tracking-wider">
                <Ban className="w-3 h-3" />
                Cancelled Log
              </div>
            )}

            {streamState === 'disconnected' && (
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-zinc-500/10 border border-zinc-500/20 text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                <WifiOff className="w-3 h-3" />
                Stream Offline
              </div>
            )}

            {/* Filter Search with keyboard hint */}
            <div className="relative">
              <Search className="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                ref={filterInputRef}
                type="text"
                placeholder="Filter logs... [/]"
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                aria-label="Filter logs"
                className="pl-7 pr-3 py-1 rounded-lg bg-black/40 border border-white/[0.08] text-[11px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-blue-500 font-mono w-28 sm:w-36"
              />
            </div>

            {/* AutoScroll Toggle with keyboard hint */}
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              aria-label="Toggle autoscroll"
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium font-mono flex items-center gap-1 transition-colors ${
                autoScroll
                  ? 'bg-blue-600 text-white'
                  : 'bg-white/[0.04] text-zinc-400 hover:text-white border border-white/[0.08]'
              }`}
            >
              <ArrowDown className="w-3 h-3" />
              <span className="hidden sm:inline">Auto-scroll</span>
              <span className="text-[9px] opacity-70 ml-0.5">[A]</span>
            </button>

            {/* Copy Button with keyboard hint */}
            <button
              onClick={copyAllLogs}
              className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-zinc-400 hover:text-white transition-colors relative"
              title="Copy All Logs [C]"
              aria-label="Copy all logs"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>

            {/* Keyboard shortcuts modal toggle */}
            <button
              onClick={() => setKeyboardHelpOpen(!keyboardHelpOpen)}
              className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Keyboard Shortcuts [?]"
              aria-label="View keyboard shortcuts"
            >
              <Keyboard className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Keyboard Shortcuts Bar */}
        {keyboardHelpOpen && (
          <div className="bg-[#0b0e14] px-4 py-2 border-b border-white/[0.06] flex items-center justify-between text-[11px] text-zinc-400 font-mono flex-wrap gap-2">
            <div className="flex items-center gap-4">
              <span><kbd className="px-1.5 py-0.5 rounded bg-white/[0.08] text-white">/</kbd> Search</span>
              <span><kbd className="px-1.5 py-0.5 rounded bg-white/[0.08] text-white">C</kbd> Copy</span>
              <span><kbd className="px-1.5 py-0.5 rounded bg-white/[0.08] text-white">A</kbd> Auto-scroll</span>
              <span><kbd className="px-1.5 py-0.5 rounded bg-white/[0.08] text-white">Esc</kbd> Clear</span>
            </div>
            <button
              onClick={() => setKeyboardHelpOpen(false)}
              className="text-zinc-500 hover:text-white text-[10px]"
            >
              Close
            </button>
          </div>
        )}

        {/* Terminal Log Output Stream */}
        <div
          className="p-4 sm:p-6 max-h-[560px] min-h-[380px] overflow-y-auto font-mono text-xs leading-relaxed space-y-1 bg-[#050608]"
          aria-live="polite"
        >
          {filteredLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-zinc-600 text-center gap-2">
              {streamState === 'live' || streamState === 'reconnecting' ? (
                <>
                  <Loader2 className="w-6 h-6 animate-spin text-blue-500/50" />
                  <p>Connecting to worker build stream...</p>
                </>
              ) : (
                <>
                  <Terminal className="w-6 h-6 text-zinc-700" />
                  <p>No log entries available</p>
                </>
              )}
            </div>
          ) : (
            filteredLogs.map((item, idx) => (
              <div key={idx} className="flex items-start gap-3 hover:bg-white/[0.02] py-0.5 px-1 rounded">
                <span className="text-zinc-600 select-none w-8 text-right font-mono text-[10px]">
                  {idx + 1}
                </span>
                <div className="flex-1 break-all whitespace-pre-wrap">
                  {formatLogLine(item.message)}
                </div>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}
