export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";

export interface LogContext {
  cycle?: number;
  issue?: number;
  phase?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, data?: LogContext): void;
  info(msg: string, data?: LogContext): void;
  warn(msg: string, data?: LogContext): void;
  error(msg: string, data?: LogContext): void;
  child(context: LogContext): Logger;
}

export function createLogger(opts: {
  format: "json" | "text";
  level: LogLevel;
}): Logger {
  const minLevel = LEVEL_ORDER[opts.level];

  function write(level: LogLevel, msg: string, data?: LogContext): void {
    if (LEVEL_ORDER[level] < minLevel) return;

    const ts = new Date().toISOString();

    if (opts.format === "json") {
      const entry = { level, ts, msg, ...data };
      process.stdout.write(JSON.stringify(entry) + "\n");
    } else {
      const color = LEVEL_COLORS[level];
      const tag = `${color}${level.toUpperCase().padEnd(5)}${RESET}`;
      const ctx = data
        ? " " + Object.entries(data).map(([k, v]) => `${k}=${v}`).join(" ")
        : "";
      process.stdout.write(`[${ts}] ${tag} ${msg}${ctx}\n`);
    }
  }

  function makeLogger(baseContext: LogContext = {}): Logger {
    const log = (level: LogLevel, msg: string, data?: LogContext) =>
      write(level, msg, { ...baseContext, ...data });

    return {
      debug: (msg, data) => log("debug", msg, data),
      info: (msg, data) => log("info", msg, data),
      warn: (msg, data) => log("warn", msg, data),
      error: (msg, data) => log("error", msg, data),
      child: (context) => makeLogger({ ...baseContext, ...context }),
    };
  }

  return makeLogger();
}
