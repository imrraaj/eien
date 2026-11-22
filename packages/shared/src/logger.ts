/**
 * Minimal structured (JSON-lines) logger for host-side code: gateway,
 * activities, worker bootstrap.
 *
 * Not for Temporal workflow code — workflows must be deterministic and should
 * use `workflow` logging (or return data) instead.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogContext = Record<string, unknown>;

export interface Logger {
    debug(message: string, context?: LogContext): void;
    info(message: string, context?: LogContext): void;
    warn(message: string, context?: LogContext): void;
    error(message: string, context?: LogContext): void;
    child(bindings: LogContext): Logger;
}

export interface LoggerOptions {
    level?: LogLevel;
    bindings?: LogContext;
    sink?: (line: string) => void;
}

const PRIORITY: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

function serialize(_key: string, value: unknown): unknown {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
            cause: value.cause,
        };
    }
    if (typeof value === "bigint") return value.toString();
    return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
    const level = options.level ?? "info";
    const bindings = options.bindings ?? {};
    const sink = options.sink ?? ((line: string) => console.log(line));
    const threshold = PRIORITY[level];

    const write = (entryLevel: LogLevel, message: string, context?: LogContext) => {
        if (PRIORITY[entryLevel] < threshold) return;
        const entry = {
            time: new Date().toISOString(),
            level: entryLevel,
            msg: message,
            ...bindings,
            ...context,
        };
        sink(JSON.stringify(entry, serialize));
    };

    return {
        debug: (message, context) => write("debug", message, context),
        info: (message, context) => write("info", message, context),
        warn: (message, context) => write("warn", message, context),
        error: (message, context) => write("error", message, context),
        child: (extra) => createLogger({ level, bindings: { ...bindings, ...extra }, sink }),
    };
}
