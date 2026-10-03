#!/usr/bin/env node
// Run every 5 min by the laptop's "ambient-heartbeat" scheduled task. healthchecks.io alerts the owner when the
// pings stop: the laptop is off, asleep, crashed or offline. No AMBIENT_PING_URL yet: does nothing.
import './config.js'; // loads .env

const url = process.env.AMBIENT_PING_URL;
if (url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) process.exitCode = 1;
  } catch {
    process.exitCode = 1; // offline: the missing ping is the alert
  }
}
