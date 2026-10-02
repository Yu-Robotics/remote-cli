import { Worker } from 'worker_threads';
import path from 'path';
import { existsSync } from 'fs';
import type { ExtractionResult } from './FileInbox';

/** A bounded worker keeps document parsing off the WebSocket/control event loop. */
export function extractDocument(filename: string, name: string, signal: AbortSignal, timeoutMs = 30_000): Promise<ExtractionResult> {
  if (signal.aborted) return Promise.reject(new Error('Document extraction cancelled.'));
  return new Promise((resolve, reject) => {
    const compiled = path.join(__dirname, 'DocumentWorker.js');
    const built = existsSync(compiled);
    const worker = new Worker(built ? compiled
      : `require(${JSON.stringify(require.resolve('tsx/cjs'))}); require(${JSON.stringify(path.join(__dirname, 'DocumentWorker.ts'))});`, {
      eval: !built, workerData: { kind: 'remote-cli-document', filename, name }, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      // Do not inherit debugger/loader hooks or runtime credentials into the parser.
      execArgv: [], env: {},
    });
    worker.stdout?.resume(); worker.stderr?.resume();
    let settled = false;
    const finish = (error?: Error, result?: ExtractionResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error('Document extraction cancelled.'));
    const timer = setTimeout(() => finish(new Error('Document extraction exceeded the 30 second time limit.')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', message => {
      if (message?.error) finish(new Error(String(message.error).slice(0, 300)));
      else if (!message || !['parsed', 'partial', 'unsupported'].includes(message.status)
        || typeof message.detail !== 'string' || message.text !== undefined && (typeof message.text !== 'string' || Buffer.byteLength(message.text) > 2 * 1024 * 1024)) {
        finish(new Error('Invalid document parser result.'));
      } else finish(undefined, message);
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`Document parser exited before producing a result (${code}).`)); });
    if (signal.aborted) abort();
  });
}
