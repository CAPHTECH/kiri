import { ServerResponse } from "node:http";

export interface WatcherMetrics {
  reindexCount: number;
  lastReindexDuration: number;
  queueDepth: number;
  lastReindexStart: number | null;
  watcherStartTime: number;
  isRunning: boolean;
}

export interface MetricSnapshot {
  httpRequestsTotal: number;
  maskAppliedTotal: number;
  denylistHitsTotal: number;
  requestDurationMs: number;
  watcher?: WatcherMetrics;
}

export class MetricsRegistry {
  private httpRequestsTotal = 0;
  private maskAppliedTotal = 0;
  private denylistHitsTotal = 0;
  private requestDurationMs = 0;
  private watcherMetrics: WatcherMetrics | undefined = undefined;

  recordRequest(durationMs: number): void {
    this.httpRequestsTotal += 1;
    this.requestDurationMs += durationMs;
  }

  recordMask(applied: number): void {
    this.maskAppliedTotal += applied;
  }

  recordDenylistHit(count: number): void {
    this.denylistHitsTotal += count;
  }

  updateWatcherMetrics(metrics: WatcherMetrics): void {
    this.watcherMetrics = metrics;
  }

  /**
   * メトリクスをリセット（テスト用、またはメトリクスローテーション用）
   */
  reset(): void {
    this.httpRequestsTotal = 0;
    this.maskAppliedTotal = 0;
    this.denylistHitsTotal = 0;
    this.requestDurationMs = 0;
    this.watcherMetrics = undefined;
  }

  snapshot(): MetricSnapshot {
    const base = {
      httpRequestsTotal: this.httpRequestsTotal,
      maskAppliedTotal: this.maskAppliedTotal,
      denylistHitsTotal: this.denylistHitsTotal,
      requestDurationMs: this.requestDurationMs,
    };

    if (this.watcherMetrics) {
      return { ...base, watcher: this.watcherMetrics };
    }

    return base;
  }

  toPrometheus(): string {
    const snapshot = this.snapshot();
    const lines = [
      "# HELP kiri_http_requests_total Total number of JSON-RPC requests handled",
      "# TYPE kiri_http_requests_total counter",
      `kiri_http_requests_total ${snapshot.httpRequestsTotal}`,
      "# HELP kiri_mask_applied_total Number of sensitive values masked",
      "# TYPE kiri_mask_applied_total counter",
      `kiri_mask_applied_total ${snapshot.maskAppliedTotal}`,
      "# HELP kiri_denylist_hits_total Number of paths excluded via denylist",
      "# TYPE kiri_denylist_hits_total counter",
      `kiri_denylist_hits_total ${snapshot.denylistHitsTotal}`,
      "# HELP kiri_request_duration_ms Accumulated request duration in milliseconds",
      "# TYPE kiri_request_duration_ms counter",
      `kiri_request_duration_ms ${snapshot.requestDurationMs}`,
    ];

    // Add watcher metrics if watch mode is enabled
    if (snapshot.watcher) {
      lines.push(
        "# HELP kiri_watcher_running Whether the file watcher is currently active",
        "# TYPE kiri_watcher_running gauge",
        `kiri_watcher_running ${snapshot.watcher.isRunning ? 1 : 0}`,
        "# HELP kiri_watcher_reindex_total Total number of reindex operations completed",
        "# TYPE kiri_watcher_reindex_total counter",
        `kiri_watcher_reindex_total ${snapshot.watcher.reindexCount}`,
        "# HELP kiri_watcher_last_reindex_duration_ms Duration of last reindex in milliseconds",
        "# TYPE kiri_watcher_last_reindex_duration_ms gauge",
        `kiri_watcher_last_reindex_duration_ms ${snapshot.watcher.lastReindexDuration}`,
        "# HELP kiri_watcher_queue_depth Current number of file changes queued for reindex",
        "# TYPE kiri_watcher_queue_depth gauge",
        `kiri_watcher_queue_depth ${snapshot.watcher.queueDepth}`,
        "# HELP kiri_watcher_uptime_seconds Time since watcher started in seconds",
        "# TYPE kiri_watcher_uptime_seconds gauge",
        `kiri_watcher_uptime_seconds ${Math.round((Date.now() - snapshot.watcher.watcherStartTime) / 1000)}`
      );
    }

    return lines.join("\n");
  }
}

export function writeMetricsResponse(res: ServerResponse, registry: MetricsRegistry): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  res.end(`${registry.toPrometheus()}\n`);
}
