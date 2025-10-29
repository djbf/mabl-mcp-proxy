import { randomUUID } from "node:crypto";

import { Response } from "express";
import { Logger } from "pino";

import { sseClientsGauge } from "./metrics";

interface SseClient {
  sessionId: string;
  res: Response;
  connectedAt: number;
  lastEventAt: number;
}

export interface SseBrokerOptions {
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
}

export class SseBroker {
  private readonly clients = new Map<string, SseClient>();
  private readonly heartbeatTimer: NodeJS.Timeout;

  constructor(
    private readonly logger: Logger,
    private readonly options: SseBrokerOptions,
  ) {
    this.heartbeatTimer = setInterval(() => {
      this.clients.forEach((client, sessionId) => {
        const now = Date.now();
        if (now - client.lastEventAt > this.options.idleTimeoutMs) {
          this.logger.warn(
            { sessionId },
            "SSE connection idle timeout, closing stream.",
          );
          client.res.end();
          this.removeClient(sessionId);
          return;
        }

        this.writeHeartbeat(client);
      });
    }, this.options.heartbeatIntervalMs);

    this.heartbeatTimer.unref();
  }

  attach(res: Response, sessionId?: string): string {
    const resolvedSessionId = sessionId && sessionId.length > 0 ? sessionId : randomUUID();
    const existing = this.clients.get(resolvedSessionId);
    if (existing) {
      this.logger.warn(
        { sessionId: resolvedSessionId },
        "Replacing existing SSE connection for session.",
      );
      existing.res.end();
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const client: SseClient = {
      sessionId: resolvedSessionId,
      res,
      connectedAt: Date.now(),
      lastEventAt: Date.now(),
    };

    this.clients.set(resolvedSessionId, client);
    sseClientsGauge.inc();

    res.write(`event: ready\n`);
    res.write(`data: {"session":"${resolvedSessionId}"}\n\n`);

    res.on("close", () => {
      this.removeClient(resolvedSessionId);
    });

    res.on("error", (error) => {
      this.logger.warn({ sessionId: resolvedSessionId, error }, "SSE stream error.");
      this.removeClient(resolvedSessionId);
    });

    return resolvedSessionId;
  }

  send(
    sessionId: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const client = this.clients.get(sessionId);
    if (!client) {
      this.logger.debug({ sessionId }, "No SSE client found for session.");
      return;
    }

    this.writeEvent(client, event, payload);
  }

  broadcast(
    event: string,
    payloadBuilder: (sessionId: string) => Record<string, unknown>,
  ) {
    this.clients.forEach((client, sessionId) => {
      const payload = payloadBuilder(sessionId);
      this.writeEvent(client, event, payload);
    });
  }

  getSessionIds(): string[] {
    return Array.from(this.clients.keys());
  }

  private writeEvent(
    client: SseClient,
    event: string,
    payload: unknown,
  ): void {
    try {
      const serialized = JSON.stringify(payload);
      client.res.write(`event: ${event}\n`);
      client.res.write(`data: ${serialized}\n\n`);
      client.lastEventAt = Date.now();
    } catch (error) {
      this.logger.error(
        { sessionId: client.sessionId, error },
        "Failed to serialize SSE payload.",
      );
    }
  }

  private writeHeartbeat(client: SseClient): void {
    client.res.write(`: heartbeat ${Date.now()}\n\n`);
  }

  private removeClient(sessionId: string): void {
    if (this.clients.delete(sessionId)) {
      sseClientsGauge.dec();
    }
  }

  close(): void {
    clearInterval(this.heartbeatTimer);
    this.clients.forEach((client) => {
      client.res.end();
    });
    this.clients.clear();
    sseClientsGauge.set(0);
  }
}
