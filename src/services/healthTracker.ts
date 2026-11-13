import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

/**
 * Represents a single queued health-check task waiting to be executed.
 */
export interface HealthProbeTask {
  /** Unique identifier for the queued check. */
  id: string;
  /** Descriptive label (e.g., service or endpoint name). */
  label: string;
  /** Unix epoch timestamp (ms) when the task was enqueued. */
  enqueuedAt: number;
  /** Optional metadata passed to the probe executor. */
  metadata?: Record<string, unknown>;
}

/**
 * Represents a single completed latency & health measurement stored in history.
 */
export interface HealthMeasurement {
  /** Task identifier associated with this measurement. */
  id: string;
  /** Service or probe label. */
  label: string;
  /** Unix epoch timestamp (ms) when the measurement completed. */
  timestamp: number;
  /** ISO-8601 timestamp string for logging and serialization. */
  isoTimestamp: string;
  /** Measured round-trip / execution latency in milliseconds via `performance.now()`. */
  latencyMs: number;
  /** Whether the probe completed successfully without error or timeout. */
  ok: boolean;
  /** Optional error message if `ok` is `false`. */
  errorMessage?: string;
}

/**
 * Overall health state classification derived from recent measurements.
 */
export type HealthCheckStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

/**
 * Custom probe executor signature allowing callers to inject any async health check.
 */
export type ProbeExecutor = (
  task: HealthProbeTask,
  signal: AbortSignal
) => Promise<void>;

/**
 * Configuration options for `HealthTracker`.
 */
export interface HealthTrackerOptions {
  /** Human-readable name for the monitored service (default: `'default-service'`). */
  serviceName?: string;
  /** Optional HTTP/HTTPS health endpoint URL used by the default probe when provided. */
  endpointUrl?: string;
  /** Interval in milliseconds between automatic periodic checks (default: `10_000`). */
  intervalMs?: number;
  /** Timeout in milliseconds before an individual probe is aborted (default: `5_000`). */
  probeTimeoutMs?: number;
  /** Maximum number of historical measurements retained (default: `50`). */
  maxHistorySize?: number;
  /** Maximum number of pending tasks allowed in the execution queue (default: `100`). */
  maxQueueSize?: number;
  /**
   * Multiplier applied to the rolling median to compute the dynamic latency threshold
   * (default: `1.5`, meaning latency <= 150% of rolling median is considered normal).
   */
  thresholdMultiplier?: number;
  /** Minimum dynamic threshold floor in milliseconds to avoid noise on sub-ms checks (default: `10`). */
  minThresholdMs?: number;
  /** Optional hard upper bound in milliseconds above which the service is always unhealthy. */
  maxAbsoluteLatencyMs?: number;
  /** Minimum number of successful samples required before enforcing the rolling median threshold (default: `3`). */
  minSamplesForThreshold?: number;
  /** Number of consecutive probe failures before reporting `isServiceHealthy() === false` (default: `2`). */
  maxConsecutiveFailures?: number;
  /** Optional custom probe function invoked for each queued task. */
  probeExecutor?: ProbeExecutor;
  /** Whether periodic `setInterval` should call `.unref()` so it does not keep Node alive on shutdown (default: `true`). */
  unrefTimer?: boolean;
}

/**
 * Read-only summary snapshot of the tracker's current state and metrics.
 */
export interface HealthSnapshot {
  serviceName: string;
  status: HealthCheckStatus;
  healthy: boolean;
  running: boolean;
  queueLength: number;
  historyCount: number;
  maxHistorySize: number;
  consecutiveFailures: number;
  latestMeasurement: HealthMeasurement | null;
  rollingMedianMs: number | null;
  dynamicThresholdMs: number | null;
}

const DEFAULT_MAX_HISTORY_SIZE = 50;
const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_THRESHOLD_MULTIPLIER = 1.5;
const DEFAULT_MIN_THRESHOLD_MS = 10;
const DEFAULT_MIN_SAMPLES_FOR_THRESHOLD = 3;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 2;

/**
 * Service Health Check & Latency Monitor (`HealthTracker`).
 *
 * Manages a FIFO probe queue and a bounded historical ring buffer (last 50 measurements by default),
 * measures execution latency with `performance.now()`, computes a rolling median dynamic threshold,
 * and evaluates service health via `isServiceHealthy()`.
 */
export class HealthTracker extends EventEmitter {
  public readonly serviceName: string;
  public readonly maxHistorySize: number;
  public readonly maxQueueSize: number;
  public readonly intervalMs: number;
  public readonly probeTimeoutMs: number;
  public readonly thresholdMultiplier: number;
  public readonly minThresholdMs: number;
  public readonly maxAbsoluteLatencyMs: number | undefined;
  public readonly minSamplesForThreshold: number;
  public readonly maxConsecutiveFailures: number;

  private readonly endpointUrl: string | undefined;
  private readonly customProbeExecutor: ProbeExecutor | undefined;
  private readonly unrefTimer: boolean;

  private readonly queue: HealthProbeTask[] = [];
  private readonly history: HealthMeasurement[] = [];

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isDraining = false;
  private disposed = false;
  private consecutiveFailures = 0;
  private taskSequence = 0;
  private activeAbortController: AbortController | null = null;
  private lastHealthyState: boolean | null = null;

  constructor(options: HealthTrackerOptions = {}) {
    super();

    this.serviceName = options.serviceName?.trim() || 'default-service';
    this.endpointUrl = options.endpointUrl?.trim() || undefined;
    this.customProbeExecutor = options.probeExecutor;
    this.unrefTimer = options.unrefTimer ?? true;

    this.maxHistorySize = Math.max(
      1,
      Math.floor(options.maxHistorySize ?? DEFAULT_MAX_HISTORY_SIZE)
    );
    this.maxQueueSize = Math.max(
      1,
      Math.floor(options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE)
    );
    this.intervalMs = Math.max(
      50,
      Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS)
    );
    this.probeTimeoutMs = Math.max(
      50,
      Math.floor(options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    );
    this.thresholdMultiplier =
      typeof options.thresholdMultiplier === 'number' &&
      Number.isFinite(options.thresholdMultiplier) &&
      options.thresholdMultiplier > 0
        ? options.thresholdMultiplier
        : DEFAULT_THRESHOLD_MULTIPLIER;
    this.minThresholdMs =
      typeof options.minThresholdMs === 'number' &&
      Number.isFinite(options.minThresholdMs) &&
      options.minThresholdMs >= 0
        ? options.minThresholdMs
        : DEFAULT_MIN_THRESHOLD_MS;
    this.maxAbsoluteLatencyMs =
      typeof options.maxAbsoluteLatencyMs === 'number' &&
      Number.isFinite(options.maxAbsoluteLatencyMs) &&
      options.maxAbsoluteLatencyMs > 0
        ? options.maxAbsoluteLatencyMs
        : undefined;
    this.minSamplesForThreshold = Math.max(
      1,
      Math.floor(
        options.minSamplesForThreshold ?? DEFAULT_MIN_SAMPLES_FOR_THRESHOLD
      )
    );
    this.maxConsecutiveFailures = Math.max(
      1,
      Math.floor(
        options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
      )
    );
  }

  /**
   * Starts periodic health monitoring on the configured interval.
   * Optionally triggers an immediate check on startup.
   */
  public start(runImmediately = true): void {
    if (this.disposed) {
      throw new Error('Cannot start a disposed HealthTracker instance.');
    }
    if (this.intervalHandle) {
      return;
    }

    if (runImmediately) {
      void this.runPeriodicCheck();
    }

    this.intervalHandle = setInterval(() => {
      void this.runPeriodicCheck();
    }, this.intervalMs);

    if (this.unrefTimer && typeof this.intervalHandle.unref === 'function') {
      this.intervalHandle.unref();
    }
  }

  /**
   * Stops the periodic timer and aborts any in-flight probe without wiping history.
   */
  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  /**
   * Permanently stops monitoring, clears the pending queue and history, and removes listeners.
   */
  public dispose(): void {
    this.disposed = true;
    this.stop();
    this.queue.length = 0;
    this.history.length = 0;
    this.removeAllListeners();
  }

  /**
   * Resets collected history and failure counters while keeping configuration intact.
   */
  public reset(): void {
    this.queue.length = 0;
    this.history.length = 0;
    this.consecutiveFailures = 0;
    this.lastHealthyState = null;
  }

  /**
   * Periodic execution entry point. Enqueues a check task (if not saturated) and drains the queue.
   */
  public async runPeriodicCheck(
    label = this.serviceName,
    metadata?: Record<string, unknown>
  ): Promise<HealthMeasurement | null> {
    if (this.disposed) {
      return null;
    }

    // Avoid piling up periodic checks if a previous probe is still draining
    if (this.isDraining && this.queue.length > 0) {
      return null;
    }

    this.enqueueProbe(label, metadata);
    const processed = await this.drainQueue();
    return processed[processed.length - 1] ?? null;
  }

  /**
   * Adds a new probe task to the internal FIFO queue.
   * Drops the oldest pending task if `maxQueueSize` would be exceeded.
   */
  public enqueueProbe(
    label = this.serviceName,
    metadata?: Record<string, unknown>
  ): HealthProbeTask {
    if (this.disposed) {
      throw new Error('Cannot enqueue probe on a disposed HealthTracker.');
    }

    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
    }

    this.taskSequence += 1;
    const task: HealthProbeTask = {
      id: `probe_${Date.now()}_${this.taskSequence}`,
      label,
      enqueuedAt: Date.now(),
      metadata,
    };

    this.queue.push(task);
    this.emit('enqueued', task);
    return task;
  }

  /**
   * Sequentially processes all tasks currently in the queue and records their latency measurements.
   */
  public async drainQueue(): Promise<HealthMeasurement[]> {
    if (this.isDraining || this.disposed) {
      return [];
    }

    this.isDraining = true;
    const results: HealthMeasurement[] = [];

    try {
      while (this.queue.length > 0 && !this.disposed) {
        const task = this.queue.shift();
        if (!task) {
          continue;
        }
        const measurement = await this.measureTask(task);
        this.recordMeasurement(measurement);
        results.push(measurement);
      }
    } finally {
      this.isDraining = false;
    }

    return results;
  }

  /**
   * Executes a single probe task and measures its duration using `performance.now()`.
   */
  public async measureTask(task: HealthProbeTask): Promise<HealthMeasurement> {
    const controller = new AbortController();
    this.activeAbortController = controller;

    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.probeTimeoutMs);
    if (typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }

    const startTime = performance.now();
    let ok = true;
    let errorMessage: string | undefined;

    try {
      await this.executeProbe(task, controller.signal);
    } catch (err) {
      ok = false;
      errorMessage =
        err instanceof Error ? err.message : String(err ?? 'Unknown probe error');
    } finally {
      clearTimeout(timeoutHandle);
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
    }

    const elapsedMs = Math.max(
      0,
      Number((performance.now() - startTime).toFixed(3))
    );
    const now = Date.now();

    return {
      id: task.id,
      label: task.label,
      timestamp: now,
      isoTimestamp: new Date(now).toISOString(),
      latencyMs: elapsedMs,
      ok,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  /**
   * Performs the actual health check / probe operation for a queued task.
   * Replace or customize the body below, or pass `options.probeExecutor` at construction time.
   */
  protected async executeProbe(
    task: HealthProbeTask,
    signal: AbortSignal
  ): Promise<void> {
    /* TODO: Replace probe logic here */
    if (this.customProbeExecutor) {
      await this.customProbeExecutor(task, signal);
      return;
    }

    if (this.endpointUrl) {
      const response = await fetch(this.endpointUrl, {
        method: 'GET',
        signal,
      });
      if (!response.ok) {
        throw new Error(
          `Health endpoint responded with HTTP ${response.status}`
        );
      }
      return;
    }

    // Default lightweight async event-loop responsiveness check
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Health probe aborted'));
        return;
      }
      const onAbort = () => {
        clearImmediate(immediateHandle);
        reject(new Error('Health probe timed out'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const immediateHandle = setImmediate(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  /**
   * Appends a measurement to the bounded historical array (max `maxHistorySize`, default 50).
   */
  public recordMeasurement(measurement: HealthMeasurement): void {
    this.history.push(measurement);
    while (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    if (measurement.ok) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
    }

    this.emit('measurement', measurement);

    const currentlyHealthy = this.isServiceHealthy(measurement.latencyMs);
    if (this.lastHealthyState !== currentlyHealthy) {
      this.lastHealthyState = currentlyHealthy;
      this.emit('healthChange', {
        healthy: currentlyHealthy,
        status: this.getHealthStatus(measurement.latencyMs),
        measurement,
      });
    }
  }

  /**
   * Computes the rolling median latency (in ms) over recent successful measurements.
   * Returns `null` when no successful measurements exist in history.
   */
  public calculateRollingMedian(windowSize = this.maxHistorySize): number | null {
    const boundedWindow = Math.max(1, Math.floor(windowSize));
    const recentSlice = this.history.slice(-boundedWindow);
    const validLatencies = recentSlice
      .filter((entry) => entry.ok && Number.isFinite(entry.latencyMs))
      .map((entry) => entry.latencyMs)
      .sort((a, b) => a - b);

    if (validLatencies.length === 0) {
      return null;
    }

    const mid = Math.floor(validLatencies.length / 2);
    if (validLatencies.length % 2 === 1) {
      return validLatencies[mid];
    }

    return Number(
      ((validLatencies[mid - 1] + validLatencies[mid]) / 2).toFixed(3)
    );
  }

  /**
   * Computes the current dynamic latency threshold (in ms) from the rolling median.
   * Returns `null` if insufficient historical samples have been collected yet.
   */
  public getDynamicThreshold(): number | null {
    const successfulSamples = this.history.filter(
      (entry) => entry.ok && Number.isFinite(entry.latencyMs)
    );
    if (successfulSamples.length < this.minSamplesForThreshold) {
      return null;
    }

    const median = this.calculateRollingMedian();
    if (median === null) {
      return null;
    }

    const scaled = Math.max(
      this.minThresholdMs,
      Number((median * this.thresholdMultiplier).toFixed(3))
    );

    if (this.maxAbsoluteLatencyMs !== undefined) {
      return Math.min(scaled, this.maxAbsoluteLatencyMs);
    }

    return scaled;
  }

  /**
   * Evaluates whether the monitored service is currently healthy by comparing the current
   * (or latest) latency measurement against the rolling-median dynamic threshold and failure count.
   */
  public isServiceHealthy(currentLatencyMs?: number): boolean {
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      return false;
    }

    const latest = this.getLatestMeasurement();
    const latestValid = this.getLatestValidMeasurement();

    const targetLatency =
      typeof currentLatencyMs === 'number' && Number.isFinite(currentLatencyMs)
        ? currentLatencyMs
        : latest?.ok
          ? latest.latencyMs
          : latestValid?.latencyMs;

    if (targetLatency === undefined) {
      // No completed valid sample yet and failures are below maxConsecutiveFailures
      return true;
    }

    if (
      this.maxAbsoluteLatencyMs !== undefined &&
      targetLatency > this.maxAbsoluteLatencyMs
    ) {
      return false;
    }

    const dynamicThreshold = this.getDynamicThreshold();
    if (dynamicThreshold === null) {
      return true;
    }

    return targetLatency <= dynamicThreshold;
  }

  private getLatestValidMeasurement(): HealthMeasurement | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i]?.ok) {
        return { ...this.history[i] };
      }
    }
    return null;
  }

  /**
   * Returns a semantic health status label (`HEALTHY`, `DEGRADED`, `UNHEALTHY`, `UNKNOWN`).
   */
  public getHealthStatus(currentLatencyMs?: number): HealthCheckStatus {
    if (this.history.length === 0 && currentLatencyMs === undefined) {
      return 'UNKNOWN';
    }
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      return 'UNHEALTHY';
    }
    if (!this.isServiceHealthy(currentLatencyMs)) {
      return 'DEGRADED';
    }
    if (this.consecutiveFailures > 0) {
      return 'DEGRADED';
    }
    return 'HEALTHY';
  }

  /**
   * Returns a shallow copy of the stored latency history (up to `maxHistorySize` entries).
   */
  public getHistory(): HealthMeasurement[] {
    return this.history.map((entry) => ({ ...entry }));
  }

  /**
   * Returns a copy of the pending probe queue.
   */
  public getPendingQueue(): HealthProbeTask[] {
    return this.queue.map((task) => ({ ...task }));
  }

  /**
   * Returns the current number of queued probe tasks.
   */
  public getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Returns the most recent measurement, or `null` if history is empty.
   */
  public getLatestMeasurement(): HealthMeasurement | null {
    const latest = this.history[this.history.length - 1];
    return latest ? { ...latest } : null;
  }

  /**
   * Returns a complete observability snapshot of the monitor's current state.
   */
  public getSnapshot(): HealthSnapshot {
    return {
      serviceName: this.serviceName,
      status: this.getHealthStatus(),
      healthy: this.isServiceHealthy(),
      running: this.intervalHandle !== null,
      queueLength: this.queue.length,
      historyCount: this.history.length,
      maxHistorySize: this.maxHistorySize,
      consecutiveFailures: this.consecutiveFailures,
      latestMeasurement: this.getLatestMeasurement(),
      rollingMedianMs: this.calculateRollingMedian(),
      dynamicThresholdMs: this.getDynamicThreshold(),
    };
  }
}

export default HealthTracker;
