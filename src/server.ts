import http from "node:http";
import https from "node:https";

import express, { Request, RequestHandler, Response } from "express";
import pinoHttp from "pino-http";
import { Logger } from "pino";

import packageInfo from "../package.json";

import { AppConfig } from "./config";
import {
  forwardedMessagesCounter,
  getRegistry,
  httpRequestDurationSeconds,
  pendingRequestsGauge,
} from "./metrics";
import { MablCli } from "./mablCli";
import { SseBroker } from "./sse";

interface PendingRequest {
  sessionId: string;
  startedAt: number;
  timeoutHandle: NodeJS.Timeout;
}

interface MessageEnvelope {
  session: string;
  body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractMessageEnvelope(req: Request): MessageEnvelope {
  if (!isRecord(req.body)) {
    throw new Error("Request body must be a JSON object.");
  }

  const { session, body } = req.body;
  if (typeof session !== "string" || session.length === 0) {
    throw new Error("Field 'session' must be a non-empty string.");
  }

  if (!isRecord(body)) {
    throw new Error("Field 'body' must be an object.");
  }

  return { session, body };
}

function getRequestId(body: Record<string, unknown>): string | undefined {
  const id = body.id;
  if (id === undefined || id === null) {
    return undefined;
  }

  if (typeof id === "string" || typeof id === "number") {
    return String(id);
  }

  throw new Error("Field 'body.id' must be a string or number when present.");
}

function buildProxyErrorPayload(
  id: string,
  message: string,
  code = -32000,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

export interface CreateServerResult {
  app: express.Express;
  server: http.Server | https.Server;
  sseBroker: SseBroker;
  close: () => Promise<void>;
}

export function createServer(
  config: AppConfig,
  logger: Logger,
  cli: MablCli,
): CreateServerResult {
  const app = express();

  const requestTimer = (
    req: Request,
    res: Response,
    next: express.NextFunction,
  ) => {
    const stop = httpRequestDurationSeconds.startTimer();
    res.on("finish", () => {
      const route = req.route?.path ?? req.path ?? "unknown";
      stop({
        method: req.method,
        route,
        status_code: String(res.statusCode),
      });
    });
    next();
  };

  app.use(requestTimer);
  app.use(express.json({ limit: "2mb" }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: true,
      customLogLevel: (res, err) => {
        const statusCode = res.statusCode ?? 200;
        if (err || statusCode >= 500) {
          return "error";
        }
        if (statusCode >= 400) {
          return "warn";
        }
        return "info";
      },
    }),
  );

  const sseBroker = new SseBroker(logger.child({ component: "sse" }), {
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    idleTimeoutMs: config.idleTimeoutMs,
  });

  const manifest = {
    name: packageInfo.name,
    version: packageInfo.version,
    description: packageInfo.description,
    capabilities: {},
    transport: {
      type: "http",
      endpoints: {
        messages: "/messages",
      },
    },
  };

  const resolveSessionIdFromRequest = (req: Request): string | undefined => {
    if (typeof req.query.session === "string" && req.query.session.length > 0) {
      return req.query.session;
    }

    const headerCandidates = [
      "x-mcp-session",
      "x-mcp-session-id",
      "x-session-id",
      "x-openai-session-id",
      "x-openai-mcp-session-id",
    ] as const;

    for (const header of headerCandidates) {
      const value = req.header(header);
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }

    return undefined;
  };

  const handleSse: RequestHandler = (req, res) => {
    const sessionId = resolveSessionIdFromRequest(req);
    const resolvedSessionId = sseBroker.attach(res, sessionId);
    logger.debug({ sessionId: resolvedSessionId }, "Attached SSE client.");
  };

  const pendingRequests = new Map<string, PendingRequest>();

  const clearPending = (id: string) => {
    const pending = pendingRequests.get(id);
    if (pending) {
      clearTimeout(pending.timeoutHandle);
      pendingRequests.delete(id);
      pendingRequestsGauge.set(pendingRequests.size);
    }
  };

  cli.on("message", (payload) => {
    if (!isRecord(payload)) {
      logger.warn({ payload }, "Received non-object payload from CLI.");
      return;
    }

    const id = getRequestId(payload);
    if (id) {
      const pending = pendingRequests.get(id);
      if (pending) {
        clearPending(id);
        sseBroker.send(pending.sessionId, "message", {
          session: pending.sessionId,
          body: payload,
        });
        return;
      }
      logger.warn(
        { id, payload },
        "Received response with unknown request id. Broadcasting.",
      );
    }

    sseBroker.broadcast("message", (sessionId) => ({
      session: sessionId,
      body: payload,
    }));
  });

  cli.on("exit", ({ code, signal }) => {
    logger.warn({ code, signal }, "mabl CLI exited. Clearing pending calls.");
    pendingRequests.forEach((pending, id) => {
      clearTimeout(pending.timeoutHandle);
      sseBroker.send(pending.sessionId, "message", {
        session: pending.sessionId,
        body: buildProxyErrorPayload(
          id,
          "mabl CLI process restarted; request cancelled.",
          -32001,
        ),
      });
    });
    pendingRequests.clear();
    pendingRequestsGauge.set(0);
  });

  app.get("/", (req, res, next) => {
    const accepts = req.headers.accept ?? "";
    if (accepts.includes("text/event-stream")) {
      handleSse(req, res, next);
      return;
    }

    res.json({
      ...manifest,
      uptimeSeconds: process.uptime(),
    });
  });

  app.get("/healthz", (_req, res) => {
    res.json({
      status: cli.isRunning() ? "ok" : "unavailable",
      cli: {
        running: cli.isRunning(),
        restarts: cli.getRestartCount(),
        lastMessageAt: cli.getLastMessageAt(),
      },
      sseSessions: sseBroker.getSessionIds(),
    });
  });

  app.get("/readyz", (_req, res) => {
    if (cli.isRunning()) {
      res.status(200).json({ ready: true });
    } else {
      res.status(503).json({ ready: false });
    }
  });

  app.get("/metrics", async (_req, res) => {
    res.setHeader("Content-Type", getRegistry().contentType);
    res.send(await getRegistry().metrics());
  });

  app.get("/messages", handleSse);

  const messageHandler = async (req: Request, res: Response) => {
    let envelope: MessageEnvelope;

    try {
      envelope = extractMessageEnvelope(req);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }

    const { session, body } = envelope;
    let requestId: string | undefined;

    try {
      requestId = getRequestId(body);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }

    try {
      forwardedMessagesCounter.inc();

      if (requestId) {
        const timeoutHandle = setTimeout(() => {
          logger.error(
            { requestId, session },
            "Timed out waiting for response from mabl CLI.",
          );
          pendingRequests.delete(requestId!);
          pendingRequestsGauge.set(pendingRequests.size);
          sseBroker.send(session, "message", {
            session,
            body: buildProxyErrorPayload(
              requestId!,
              "Timed out waiting for response from mabl CLI.",
            ),
          });
        }, config.requestTimeoutMs);
        timeoutHandle.unref();

        pendingRequests.set(requestId, {
          sessionId: session,
          startedAt: Date.now(),
          timeoutHandle,
        });
        pendingRequestsGauge.set(pendingRequests.size);
      }

      await cli.send(body);
      res.status(202).json({ accepted: true });
    } catch (error) {
      if (requestId) {
        clearPending(requestId);
      }
      logger.error({ error }, "Failed to forward message to mabl CLI.");
      res.status(503).json({ error: "mabl CLI process unavailable." });
    }
  };

  app.post("/messages", messageHandler);
  app.post("/", messageHandler);

  const server =
    config.tls != null
      ? https.createServer(
          {
            cert: config.tls.cert,
            key: config.tls.key,
            ca: config.tls.ca,
          },
          app,
        )
      : http.createServer(app);

  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    sseBroker.close();
    await cli.stop();
  };

  return {
    app,
    server,
    sseBroker,
    close,
  };
}
