import fs from "node:fs/promises";

export interface TlsConfig {
  cert: string;
  key: string;
  ca?: string;
}

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  prettyLogs: boolean;
  requestTimeoutMs: number;
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
  mablApiKey: string;
  tls?: TlsConfig;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

async function maybeReadFile(path?: string): Promise<string | undefined> {
  if (!path) {
    return undefined;
  }

  const data = await fs.readFile(path, "utf-8");
  return data;
}

export async function loadConfig(): Promise<AppConfig> {
  const mablApiKey = process.env.MABL_API_KEY;
  if (!mablApiKey) {
    throw new Error("MABL_API_KEY is required but was not provided.");
  }

  const port = parseNumber(process.env.PORT, 443);
  const host = process.env.HOST ?? "0.0.0.0";
  const requestTimeoutMs = parseNumber(process.env.REQUEST_TIMEOUT_MS, 45_000);
  const heartbeatIntervalMs = parseNumber(
    process.env.HEARTBEAT_INTERVAL_MS,
    15_000,
  );
  const idleTimeoutMs = parseNumber(process.env.IDLE_TIMEOUT_MS, 120_000);
  const logLevel = process.env.LOG_LEVEL ?? "info";
  const prettyLogs = (process.env.PRETTY_LOGS ?? "").toLowerCase() === "true";

  const cert = await maybeReadFile(process.env.TLS_CERT_PATH);
  const key = await maybeReadFile(process.env.TLS_KEY_PATH);
  const ca = await maybeReadFile(process.env.TLS_CA_PATH);

  let tls: TlsConfig | undefined;
  if (cert && key) {
    tls = { cert, key, ca };
  } else if (!process.env.ALLOW_HTTP) {
    throw new Error(
      "TLS_CERT_PATH and TLS_KEY_PATH must be set or ALLOW_HTTP=true to run without TLS.",
    );
  }

  return {
    port,
    host,
    logLevel,
    prettyLogs,
    requestTimeoutMs,
    heartbeatIntervalMs,
    idleTimeoutMs,
    mablApiKey,
    tls,
  };
}
