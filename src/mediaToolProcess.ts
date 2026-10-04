import { spawn } from 'node:child_process';

export function spawnProcessAsync(
  command: string,
  args: string[],
  {
    stdinData = null,
    timeout,
  }: {
    stdinData?: Uint8Array | Buffer | null;
    timeout: number;
  },
): Promise<{ stderr: Buffer; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let didTimeout = false;
    let settled = false;
    let timeoutId: NodeJS.Timeout | null = null;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      callback();
    };

    child.stdout.on('data', (chunk: Buffer | Uint8Array | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | Uint8Array | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on('close', (code, signal) => {
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks);

        if (code === 0 && signal === null && !didTimeout) {
          resolve({ stderr, stdout });
          return;
        }

        const stderrText = stderr.toString('utf8').trim();
        const reason = didTimeout
          ? `Command timed out after ${timeout}ms`
          : signal
            ? `Command exited with signal ${signal}`
            : `Command exited with code ${code ?? 'unknown'}`;
        reject(new Error(stderrText ? `${reason}: ${stderrText}` : reason));
      });
    });

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        didTimeout = true;
        child.kill('SIGKILL');
      }, timeout);
    }

    if (stdinData && stdinData.byteLength > 0) {
      child.stdin.end(Buffer.isBuffer(stdinData) ? stdinData : Buffer.from(stdinData));
      return;
    }

    child.stdin.end();
  });
}

