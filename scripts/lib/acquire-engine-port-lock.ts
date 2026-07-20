import { createServer as createTcpProbe } from 'node:net';

// Shared by every maintenance script that must run with a port's owner DEFINITELY not up (extracted out of
// rescue-legacy-logs.ts so a second script needing the same guarantee — promote-legacy-system-messages.ts —
// imports the ONE implementation instead of forking it; see the project's dead-code & fork-prevention rule).
//
// CLAIM the port and HOLD it for the entire operation — this is a LOCK, not a check.
//
// A probe that binds and immediately releases only proves the owner was down at one instant: the real
// process (or a second copy of the calling script) can start inside the gap between the check and the work,
// and then two writers touch the same on-disk state — the exact TOCTOU race the guard exists to prevent. So
// we keep the socket LISTENING for the whole operation and release it only when the caller is done. While we
// hold it, nothing else can bind that port (it would hit EADDRINUSE), which turns "please stop that first"
// from a polite request into real mutual exclusion.
//
// EADDRINUSE is the ONLY signal we treat as "already up": any other bind failure (e.g. permission) is a
// real, unrelated error and is rethrown as-is rather than mis-reported as "it's running".
export async function acquireEngineLock(
  port: number,
  alreadyUpDescription: string,
): Promise<{ release: () => Promise<void> }> {
  const lock = createTcpProbe();
  await new Promise<void>((resolve, reject) => {
    lock.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Refusing to run: 127.0.0.1:${port} is already bound, which means ${alreadyUpDescription} ` +
          `Stop it first and re-run this script. No file was touched.`,
        ));
        return;
      }
      reject(err);
    });
    lock.once('listening', () => resolve());
    lock.listen(port, '127.0.0.1');
  });

  return {
    release: () => new Promise<void>((resolve) => lock.close(() => resolve())),
  };
}
