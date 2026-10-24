// Turns computer-use frames into lossless WebP in a worker thread, off the turn's path: a frame is
// written and referenced as PNG first, and only a finished WebP replaces it (see
// src/routes/computer-use/participant-frames.ts). The process shares one worker, so encoding uses
// at most one core however many participants run.
import { Worker } from "node:worker_threads";

/**
 * The PNG bytes that may wait for the worker at once. A frame past it stays PNG, so a busy runner
 * keeps today's format for that frame instead of holding more frames in memory.
 */
const QUEUE_BYTE_BUDGET = 64 * 1024 * 1024;

type Reply = { id: number; webp: Uint8Array } | { id: number; error: string };
type Ready = { ready: true } | { ready: false; error: string };

export interface WebpTranscoder {
  /** The frame's WebP bytes, or undefined when the queue is full or the encoder failed. */
  transcode(png: Buffer): Promise<Buffer> | undefined;
}

class WorkerTranscoder implements WebpTranscoder {
  private readonly worker: Worker;
  private readonly waiting = new Map<
    number,
    { size: number; resolve: (webp: Buffer) => void; reject: (error: Error) => void }
  >();
  private queuedBytes = 0;
  private nextId = 0;
  private failed = false;

  constructor(entry: URL) {
    this.worker = new Worker(entry);
    // An idle worker never keeps the process alive; a waiting frame does (track).
    this.worker.unref();
    this.worker.on("message", (message: Reply | Ready) => {
      if ("ready" in message) {
        if (!message.ready) this.fail(new Error(message.error));
        return;
      }
      const job = this.waiting.get(message.id);
      if (job === undefined) return;
      this.settle(message.id, job.size);
      if ("error" in message) job.reject(new Error(message.error));
      else
        job.resolve(Buffer.from(message.webp.buffer, message.webp.byteOffset, message.webp.length));
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) =>
      this.fail(new Error(`The WebP worker exited with code ${code}.`)),
    );
  }

  transcode(png: Buffer): Promise<Buffer> | undefined {
    if (this.failed || this.queuedBytes + png.length > QUEUE_BYTE_BUDGET) return undefined;
    const id = this.nextId++;
    if (this.waiting.size === 0) this.worker.ref();
    this.queuedBytes += png.length;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { size: png.length, resolve, reject });
      this.worker.postMessage({ id, png: new Uint8Array(png) });
    });
  }

  private settle(id: number, size: number): void {
    this.waiting.delete(id);
    this.queuedBytes -= size;
    if (this.waiting.size === 0) this.worker.unref();
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    for (const [id, job] of this.waiting) {
      this.settle(id, job.size);
      job.reject(error);
    }
    void this.worker.terminate();
  }
}

let shared: WebpTranscoder | undefined;

/**
 * The process's transcoder, started on first use. From source the worker runs as TypeScript, which
 * Node loads with its types stripped.
 */
export function webpTranscoder(): WebpTranscoder {
  shared ??= new WorkerTranscoder(
    new URL(
      import.meta.url.endsWith(".ts") ? "./webp-encode-worker.ts" : "./webp-encode-worker.js",
      import.meta.url,
    ),
  );
  return shared;
}
