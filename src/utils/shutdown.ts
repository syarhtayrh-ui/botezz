import { createLogger } from '../logging/logger';

const log = createLogger('shutdown');

export type CleanupHandler = () => Promise<void> | void;

/**
 * Coordinates graceful shutdown across sessions, task runners, temp file cleanup, and SQLite.
 */
export class ShutdownManager {
  private readonly handlers: Array<{ name: string; fn: CleanupHandler }> = [];
  private shuttingDown = false;

  public register(name: string, fn: CleanupHandler): void {
    this.handlers.push({ name, fn });
  }

  public isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  public async shutdown(signal = 'MANUAL'): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    log.info(`Initiating graceful shutdown (${signal})...`, {
      registeredHandlers: this.handlers.length,
    });

    // Execute in reverse registration order (LIFO)
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const item = this.handlers[i];
      try {
        await item.fn();
        log.info(`Shutdown handler completed: ${item.name}`);
      } catch (err) {
        log.error(`Shutdown handler failed: ${item.name}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
