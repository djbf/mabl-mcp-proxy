import pino, { Logger } from "pino";

export interface LoggerOptions {
  level: string;
  pretty: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  if (options.pretty && process.stdout.isTTY) {
    return pino({
      level: options.level,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          singleLine: false,
        },
      },
    });
  }

  return pino({
    level: options.level,
  });
}
