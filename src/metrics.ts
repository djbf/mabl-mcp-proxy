import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

const registry = new Registry();

collectDefaultMetrics({
  prefix: "mabl_mcp_proxy_",
  register: registry,
});

export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds.",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const forwardedMessagesCounter = new Counter({
  name: "forwarded_messages_total",
  help: "Count of MCP messages forwarded to the mabl CLI.",
  registers: [registry],
});

export const pendingRequestsGauge = new Gauge({
  name: "pending_requests",
  help: "Current number of MCP requests awaiting response.",
  registers: [registry],
});

export const sseClientsGauge = new Gauge({
  name: "sse_clients",
  help: "Number of active SSE clients.",
  registers: [registry],
});

export function getRegistry(): Registry {
  return registry;
}
