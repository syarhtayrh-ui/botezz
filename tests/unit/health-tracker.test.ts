import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HealthTracker,
  type HealthMeasurement,
} from '../../src/services/healthTracker';

describe('HealthTracker (Service Health Check & Latency Monitor)', () => {
  it('bounds historical measurements to the last 50 entries by default', () => {
    const tracker = new HealthTracker({ serviceName: 'api-gateway' });

    for (let i = 1; i <= 65; i++) {
      const entry: HealthMeasurement = {
        id: `probe_${i}`,
        label: 'api-gateway',
        timestamp: 1_700_000_000_000 + i * 1000,
        isoTimestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        latencyMs: i * 2,
        ok: true,
      };
      tracker.recordMeasurement(entry);
    }

    const history = tracker.getHistory();
    assert.equal(history.length, 50);
    assert.equal(history[0]?.id, 'probe_16');
    assert.equal(history[49]?.id, 'probe_65');
    tracker.dispose();
  });

  it('computes accurate rolling median for odd and even sample counts and evaluates dynamic health thresholds', () => {
    const tracker = new HealthTracker({
      serviceName: 'db-primary',
      thresholdMultiplier: 1.5,
      minThresholdMs: 10,
      minSamplesForThreshold: 3,
    });

    // Odd count: [20, 40, 100] -> median = 40 -> dynamic threshold = 60
    for (const ms of [100, 20, 40]) {
      tracker.recordMeasurement({
        id: `m_${ms}`,
        label: 'db-primary',
        timestamp: Date.now(),
        isoTimestamp: new Date().toISOString(),
        latencyMs: ms,
        ok: true,
      });
    }

    assert.equal(tracker.calculateRollingMedian(), 40);
    assert.equal(tracker.getDynamicThreshold(), 60);
    assert.equal(tracker.isServiceHealthy(55), true);
    assert.equal(tracker.isServiceHealthy(65), false);
    assert.equal(tracker.getHealthStatus(65), 'DEGRADED');

    // Even count: [20, 40, 60, 100] -> median = (40 + 60) / 2 = 50 -> dynamic threshold = 75
    tracker.recordMeasurement({
      id: 'm_60',
      label: 'db-primary',
      timestamp: Date.now(),
      isoTimestamp: new Date().toISOString(),
      latencyMs: 60,
      ok: true,
    });

    assert.equal(tracker.calculateRollingMedian(), 50);
    assert.equal(tracker.getDynamicThreshold(), 75);
    assert.equal(tracker.isServiceHealthy(70), true);
    assert.equal(tracker.isServiceHealthy(80), false);
    tracker.dispose();
  });

  it('enqueues tasks, measures latency with performance.now(), and transitions to UNHEALTHY on consecutive failures', async () => {
    let shouldFail = false;
    let calls = 0;

    const tracker = new HealthTracker({
      serviceName: 'worker-queue',
      maxQueueSize: 3,
      probeTimeoutMs: 500,
      maxConsecutiveFailures: 2,
      probeExecutor: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (shouldFail) {
          throw new Error('Upstream unavailable');
        }
      },
    });

    // Queue bounding check (maxQueueSize = 3)
    tracker.enqueueProbe('t1');
    tracker.enqueueProbe('t2');
    tracker.enqueueProbe('t3');
    tracker.enqueueProbe('t4');
    assert.equal(tracker.getQueueLength(), 3);
    assert.deepEqual(
      tracker.getPendingQueue().map((t) => t.label),
      ['t2', 't3', 't4']
    );

    const drained = await tracker.drainQueue();
    assert.equal(drained.length, 3);
    assert.equal(calls, 3);
    assert.equal(tracker.getQueueLength(), 0);
    assert.ok(drained.every((m) => m.ok && m.latencyMs >= 10));
    assert.equal(tracker.isServiceHealthy(), true);

    // Consecutive failures should mark service UNHEALTHY
    shouldFail = true;
    const fail1 = await tracker.runPeriodicCheck();
    assert.equal(fail1?.ok, false);
    assert.equal(tracker.isServiceHealthy(), true); // 1 < maxConsecutiveFailures(2)

    const fail2 = await tracker.runPeriodicCheck();
    assert.equal(fail2?.ok, false);
    assert.equal(tracker.isServiceHealthy(), false);
    assert.equal(tracker.getHealthStatus(), 'UNHEALTHY');

    const snapshot = tracker.getSnapshot();
    assert.equal(snapshot.serviceName, 'worker-queue');
    assert.equal(snapshot.consecutiveFailures, 2);
    assert.equal(snapshot.status, 'UNHEALTHY');

    tracker.dispose();
  });

  it('supports periodic start/stop lifecycle cleanly', async () => {
    let invocations = 0;
    const tracker = new HealthTracker({
      serviceName: 'periodic-check',
      intervalMs: 60,
      probeExecutor: async () => {
        invocations += 1;
      },
    });

    tracker.start(true);
    await new Promise((resolve) => setTimeout(resolve, 160));
    tracker.stop();

    const countAtStop = invocations;
    assert.ok(countAtStop >= 2);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(invocations, countAtStop);
    tracker.dispose();
  });
});
