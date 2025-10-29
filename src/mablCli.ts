import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { Logger } from "pino";

interface CliEvents {
  message: [unknown];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
  error: [Error];
}

type EventKey = keyof CliEvents;

type Listener<T extends EventKey> = (...args: CliEvents[T]) => void;

export interface MablCliOptions {
  apiKey: string;
  logger: Logger;
  restartDelayMs?: number;
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  homeDir?: string;
}

export class MablCli extends EventEmitter {
  private child: ReturnType<typeof spawn> | null = null;
  private stdoutBuffer = "";
  private restarting = false;
  private restarts = 0;
  private closed = false;
  private lastMessageTimestamp: number | null = null;

  private readonly cacheDir: string;
  private readonly homeDir: string;

  constructor(private readonly options: MablCliOptions) {
    super();
    this.cacheDir = options.cacheDir ?? "/tmp/mabl-cli-cache";
    this.homeDir = options.homeDir ?? "/tmp/mabl-cli-home";
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot start mabl CLI after shutdown.");
    }

    await this.prepareEnvironment();
    await this.authenticate();
    await this.spawnCli();
  }

  isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  getLastMessageAt(): number | null {
    return this.lastMessageTimestamp;
  }

  getRestartCount(): number {
    return this.restarts;
  }

  private async prepareEnvironment(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.cacheDir, { recursive: true }),
      fs.mkdir(this.homeDir, { recursive: true }),
    ]);
  }

  async send(payload: unknown): Promise<void> {
    if (!this.child || this.child.killed) {
      throw new Error("mabl CLI process is not running.");
    }

    const json = JSON.stringify(payload);
    const writable = this.child.stdin;
    if (!writable) {
      throw new Error("mabl CLI stdin is not available.");
    }

    if (!writable.write(`${json}\n`)) {
      await once(writable, "drain");
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.child) {
      this.child.removeAllListeners();
      this.child.kill("SIGTERM");
    }
    this.child = null;
  }

  override on<T extends EventKey>(event: T, listener: Listener<T>): this {
    return super.on(event, listener);
  }

  override once<T extends EventKey>(event: T, listener: Listener<T>): this {
    return super.once(event, listener);
  }

  override off<T extends EventKey>(event: T, listener: Listener<T>): this {
    return super.off(event, listener);
  }

  private async authenticate(): Promise<void> {
    const log = this.options.logger;
    log.info("Authenticating mabl CLI key.");

    const args = [
      "--yes",
      "@mablhq/mabl-cli@latest",
      "mabl",
      "auth",
      "activate-key",
      this.options.apiKey,
    ];

    await this.runOneShotCommand(args);
    log.info("Successfully authenticated mabl CLI key.");
  }

  private async spawnCli(): Promise<void> {
    const log = this.options.logger;
    log.info("Spawning mabl MCP server.");

    const child = spawn(
      "npx",
      ["--yes", "@mablhq/mabl-cli@latest", "mcp", "start"],
      {
        env: {
          ...process.env,
          ...this.options.env,
          NPX_YES: "1",
          FORCE_COLOR: "0",
          HOME: this.homeDir,
          NPM_CONFIG_CACHE: this.cacheDir,
          npm_config_cache: this.cacheDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.child = child;
    this.restarting = false;

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      this.handleStdout(chunk);
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      chunk
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .forEach((line) => {
          log.warn({ line }, "mabl CLI stderr output.");
        });
    });

    child.on("exit", async (code, signal) => {
      this.child = null;
      this.emit("exit", { code, signal });
      if (this.closed) {
        log.info({ code, signal }, "mabl CLI exited after shutdown.");
        return;
      }

      log.error({ code, signal }, "mabl CLI exited unexpectedly.");
      await this.scheduleRestart();
    });

    child.on("error", (error) => {
      this.emit("error", error);
      log.error({ error }, "mabl CLI process error.");
    });
  }

  private async scheduleRestart(): Promise<void> {
    if (this.restarting || this.closed) {
      return;
    }

    this.restarting = true;
    const delayMs = this.options.restartDelayMs ?? 5_000;
    this.options.logger.info(
      { delayMs },
      "Attempting to restart mabl CLI after delay.",
    );
    await delay(delayMs);
    this.restarts += 1;

    try {
      await this.spawnCli();
    } catch (error) {
      this.options.logger.error(
        { error },
        "Failed to restart mabl CLI. Retrying.",
      );
      this.restarting = false;
      await this.scheduleRestart();
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.processLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private processLine(line: string): void {
    this.lastMessageTimestamp = Date.now();
    try {
      const parsed = JSON.parse(line);
      this.emit("message", parsed);
    } catch (error) {
      this.options.logger.warn(
        { line },
        "Failed to parse mabl CLI output as JSON.",
      );
    }
  }

  private async runOneShotCommand(args: string[]): Promise<void> {
    const log = this.options.logger;
    return new Promise((resolve, reject) => {
      const child = spawn("npx", args, {
        env: {
          ...process.env,
          ...this.options.env,
          NPX_YES: "1",
          FORCE_COLOR: "0",
          HOME: this.homeDir,
          NPM_CONFIG_CACHE: this.cacheDir,
          npm_config_cache: this.cacheDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";

      child.stdout?.setEncoding?.("utf-8");
      child.stdout?.on("data", () => {
        // drain stdout to avoid backpressure; no-op handler satisfies lint.
      });

      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          log.error(
            { code, stderr: stderr.trim() },
            "mabl CLI authentication command failed.",
          );
          reject(
            new Error(
              `mabl auth activate-key command failed with exit code ${code}.`,
            ),
          );
        }
      });
    });
  }
}
