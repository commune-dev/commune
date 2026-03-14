import type { Request, Response, NextFunction } from 'express';

/**
 * Server-Timing middleware.
 *
 * Adds a `Server-Timing` header to every response so latency can be measured
 * in DevTools / curl without deploying additional APM tooling.
 *
 * Usage:
 *   curl -sv https://api.commune.email/v1/threads 2>&1 | grep -i server-timing
 *   # → Server-Timing: total;dur=42
 *
 * Phases are added via `res.locals.timing.start(name)` / `res.locals.timing.end(name)`:
 *   res.locals.timing.start('db');
 *   await someQuery();
 *   res.locals.timing.end('db');
 */

interface TimingEntry {
  start: number;
  end?: number;
  desc?: string;
}

interface Timing {
  start: (name: string, desc?: string) => void;
  end: (name: string) => void;
}

export function serverTiming(req: Request, res: Response, next: NextFunction): void {
  const reqStart = performance.now();
  const entries = new Map<string, TimingEntry>();

  const timing: Timing = {
    start(name, desc) {
      entries.set(name, { start: performance.now(), desc });
    },
    end(name) {
      const e = entries.get(name);
      if (e) e.end = performance.now();
    },
  };

  res.locals.timing = timing;

  const writeHeader = () => {
    if (res.headersSent) return;
    const total = Math.round(performance.now() - reqStart);
    const parts: string[] = [`total;dur=${total}`];
    for (const [name, e] of entries) {
      if (e.end !== undefined) {
        const dur = Math.round(e.end - e.start);
        parts.push(e.desc ? `${name};dur=${dur};desc="${e.desc}"` : `${name};dur=${dur}`);
      }
    }
    res.setHeader('Server-Timing', parts.join(', '));
  };

  res.on('finish', writeHeader);
  res.on('close', writeHeader);

  next();
}
