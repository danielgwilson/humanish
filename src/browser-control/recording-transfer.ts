import { Transform, type Duplex, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CuaExecutorError } from "../actors/computer-use/executor-error.js";
import { DESKTOP_RECORDING_MAX_BYTES } from "../evidence/desktop-recording-types.js";

const BROWSER_CONTROL_RECORDING_TRANSFER_TIMEOUT_MS = 120_000;

function exactBytes(expected: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(
        received <= expected ? undefined : new Error("recording exceeded declared length"),
        received <= expected ? chunk : undefined,
      );
    },
    flush(callback) {
      callback(
        received === expected ? undefined : new Error("recording ended before declared length"),
      );
    },
  });
}

function validLength(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > DESKTOP_RECORDING_MAX_BYTES) {
    throw new CuaExecutorError("invalid_response", "outcome_uncertain");
  }
}

export async function receiveBrowserControlRecording(
  source: Duplex,
  destination: Writable,
  bytes: number,
): Promise<void> {
  validLength(bytes);
  try {
    await pipeline(source, exactBytes(bytes), destination, {
      signal: AbortSignal.timeout(BROWSER_CONTROL_RECORDING_TRANSFER_TIMEOUT_MS),
    });
  } catch {
    throw new CuaExecutorError("transport_failed", "outcome_uncertain");
  }
}

export async function sendBrowserControlRecording(
  source: Readable,
  destination: Duplex,
  bytes: number,
): Promise<void> {
  validLength(bytes);
  try {
    await pipeline(source, exactBytes(bytes), destination, {
      end: false,
      signal: AbortSignal.timeout(BROWSER_CONTROL_RECORDING_TRANSFER_TIMEOUT_MS),
    });
    await new Promise<void>((resolve, reject) =>
      destination.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
    destination.destroy();
  } catch {
    destination.destroy();
    throw new CuaExecutorError("transport_failed", "outcome_uncertain");
  }
}
