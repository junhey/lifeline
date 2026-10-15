/**
 * Watchdog for the agent uplink: if the socket stays continuously
 * disconnected longer than the current threshold, fire `onStuck` so the
 * caller rebuilds the whole connection stack. socket.io-client can enter
 * states it never leaves on its own (reconnect-error loops, or an inert
 * socket after a server-initiated disconnect where it stops reconnecting
 * entirely); a fresh Manager — what a process restart provides — is the
 * only reliable way out. See docs/plans/2026-10-04-uplink-watchdog-design.md.
 *
 * Pure logic: clock and scheduler are injected, so tests run on a fake clock.
 */
export interface UplinkWatchdogOptions {
  /** Fire after this much continuous disconnection. Default 5 min. */
  thresholdMs?: number;
  /** Cap for the backoff on consecutive failures. Default 1 h. */
  maxThresholdMs?: number;
  onStuck: (info: { attempt: number; thresholdMs: number }) => void;
  /** Injectable scheduler; returns a cancel function. Default setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  log?: (msg: string) => void;
}

export const DEFAULT_UPLINK_WATCHDOG_THRESHOLD_MS = 300_000;
export const DEFAULT_UPLINK_WATCHDOG_MAX_THRESHOLD_MS = 3_600_000;

export class UplinkWatchdog {
  private readonly thresholdMs: number;
  private readonly maxThresholdMs: number;
  private readonly onStuck: UplinkWatchdogOptions['onStuck'];
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly log: (msg: string) => void;

  private currentThresholdMs: number;
  private attempt = 0;
  private cancel: (() => void) | null = null;
  private stopped = false;

  constructor(opts: UplinkWatchdogOptions) {
    this.thresholdMs = opts.thresholdMs ?? DEFAULT_UPLINK_WATCHDOG_THRESHOLD_MS;
    this.maxThresholdMs = opts.maxThresholdMs ?? DEFAULT_UPLINK_WATCHDOG_MAX_THRESHOLD_MS;
    this.onStuck = opts.onStuck;
    this.schedule = opts.schedule ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
    this.log = opts.log ?? (() => {});
    this.currentThresholdMs = this.thresholdMs;
  }

  /** Any successful connect: disarm and reset the backoff. */
  notifyConnected(): void {
    if (this.stopped)
      return;
    if (this.cancel) {
      this.cancel();
      this.cancel = null;
    }
    if (this.attempt > 0)
      this.log(`reset after ${this.attempt} attempt(s)`);
    this.attempt = 0;
    this.currentThresholdMs = this.thresholdMs;
  }

  /**
   * socket.io 'disconnect' — arm on ANY reason. "io server disconnect" leaves
   * the socket inert (no auto-reconnect), so the watchdog is the only way out.
   */
  notifyDisconnected(): void {
    this.arm();
  }

  /** socket.io 'connect_error' — also covers the never-connected case. */
  notifyConnectError(): void {
    this.arm();
  }

  /** Permanent stop (manual shutdown). */
  stop(): void {
    this.stopped = true;
    if (this.cancel) {
      this.cancel();
      this.cancel = null;
    }
  }

  private arm(): void {
    if (this.stopped || this.cancel)
      return;
    const threshold = this.currentThresholdMs;
    this.cancel = this.schedule(() => {
      this.cancel = null;
      this.attempt += 1;
      this.currentThresholdMs = Math.min(this.currentThresholdMs * 2, this.maxThresholdMs);
      this.log(`disconnected for over ${threshold}ms (attempt ${this.attempt}); next threshold ${this.currentThresholdMs}ms`);
      try {
        this.onStuck({ attempt: this.attempt, thresholdMs: threshold });
      }
      catch (err) {
        this.log(`onStuck handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Re-arm immediately with the new threshold: the rebuilt socket gets a
      // full window, and a silently hanging handshake cannot outlive it.
      this.arm();
    }, threshold);
  }
}
