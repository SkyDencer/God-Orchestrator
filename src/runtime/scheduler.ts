import { Job, PersistentQueue } from './queue.js';

export type JobHandler = (_job: Job) => Promise<void>;

export interface SchedulerConfig {
  pollIntervalMs: number;
  leaseSeconds: number;
  maxConcurrent: number;
}

export class Scheduler {
  private readonly queue: PersistentQueue;
  private readonly config: SchedulerConfig;
  private readonly handlers: Map<string, JobHandler> = new Map();
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private jobsProcessed = 0;
  private jobsFailed = 0;
  private startedAt?: Date;
  private stopPromise?: Promise<void>;
  private resolveStop?: () => void;
  private pendingJobs = 0;

  constructor(queue: PersistentQueue, config: Partial<SchedulerConfig> = {}) {
    this.queue = queue;
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      leaseSeconds: config.leaseSeconds ?? 30,
      maxConcurrent: config.maxConcurrent ?? 5,
      ...config,
    };
  }

  /**
   * Register a handler for a job type.
   */
  registerHandler(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Start the scheduler poll loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = new Date();
    this.poll();
  }

  /**
   * Stop the scheduler and wait for in-flight jobs to complete.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for in-flight jobs
    if (this.inFlight > 0 || this.pendingJobs > 0) {
      this.stopPromise = new Promise((resolve) => {
        this.resolveStop = resolve;
      });
      await this.stopPromise;
    }
  }

  /**
   * Check if the scheduler is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get scheduler statistics.
   */
  stats(): { startedAt?: Date; jobsProcessed: number; jobsFailed: number } {
    return {
      startedAt: this.startedAt,
      jobsProcessed: this.jobsProcessed,
      jobsFailed: this.jobsFailed,
    };
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      // Release any expired leases first
      this.queue.releaseExpiredLeases();

      // Lease up to maxConcurrent jobs
      const canLease = this.config.maxConcurrent - this.inFlight;
      for (let i = 0; i < canLease; i++) {
        const job = this.queue.leaseNext(this.config.leaseSeconds);
        if (!job) break;

        this.dispatch(job);
      }
    } catch (error) {
      console.error('Scheduler poll error:', error);
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), this.config.pollIntervalMs);
    }
  }

  private async dispatch(job: Job): Promise<void> {
    this.inFlight++;
    this.pendingJobs++;

    const handler = this.handlers.get(job.type);
    try {
      if (!handler) {
        console.warn(`No handler registered for job type: ${job.type}`);
        this.queue.complete(job.id);
        this.inFlight--;
        this.pendingJobs--;
        this.jobsProcessed++;
        this.checkStop();
        return;
      }

      await handler(job);
      this.queue.complete(job.id);
      this.inFlight--;
      this.pendingJobs--;
      this.jobsProcessed++;
      this.checkStop();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.queue.fail(job.id, errorMessage);
      this.inFlight--;
      this.pendingJobs--;
      this.jobsFailed++;
      this.checkStop();
    }
  }

  private checkStop(): void {
    if (!this.running && this.inFlight === 0 && this.pendingJobs === 0) {
      const resolve = this.resolveStop;
      this.resolveStop = undefined;
      this.stopPromise = undefined;
      resolve?.();
    }
  }
}
