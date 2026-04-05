import fs from 'fs';

/**
 * Returns true if the current process is running in the background
 * (i.e. not the foreground process group of the controlling terminal).
 *
 * Works on Linux by reading /proc/self/stat:
 *   field[4] = pgrp  (our process group ID)
 *   field[7] = tpgid (foreground process group of the controlling terminal)
 *
 * If tpgid == -1, there is no controlling terminal (nohup / systemd / pipe) —
 * the process is also treated as "background" since stdin prompts won't work.
 *
 * Falls back to false (assume foreground) on non-Linux systems or if /proc
 * is unavailable.
 */
export function isBackgroundProcess(): boolean {
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const fields = stat.split(' ');
    const pgrp = parseInt(fields[4], 10);   // process group ID
    const tpgid = parseInt(fields[7], 10);  // terminal foreground process group
    // tpgid === -1: no controlling terminal (nohup, systemd, etc.)
    // pgrp !== tpgid: we are a background process group
    return tpgid === -1 || pgrp !== tpgid;
  } catch {
    // /proc not available (macOS, non-Linux) — fall back to false
    return false;
  }
}
