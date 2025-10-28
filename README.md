# mabl MCP Proxy

Containerized HTTPS proxy that exposes the mabl MCP stdio server over the HTTP transport expected by ChatGPT. The proxy runs a long-lived instance of `@mablhq/mabl-cli@latest`, forwards MCP JSON-RPC payloads over stdio, and streams responses back to ChatGPT via Server-Sent Events.

## Features
- TLS-terminated HTTPS server (falls back to HTTP only when `ALLOW_HTTP=true`).
- Single, long-lived mabl MCP child process with automatic restart and pending request clean-up.
- Structured logging with optional pretty-printing.
- Health and readiness endpoints plus Prometheus metrics (`/healthz`, `/readyz`, `/metrics`).
- Pluggable request timeout, heartbeat, and idle timeouts.

## Runtime Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MABL_API_KEY` | ✅ | — | API key used to authenticate the CLI (`mabl auth activate-key`). |
| `PORT` | | `443` | Listening port for HTTPS/HTTP server. |
| `HOST` | | `0.0.0.0` | Bind address. |
| `TLS_CERT_PATH` | ✅* | — | Path to PEM-encoded TLS certificate. |
| `TLS_KEY_PATH` | ✅* | — | Path to PEM-encoded TLS private key. |
| `TLS_CA_PATH` | | — | Optional additional CA bundle (PEM). |
| `ALLOW_HTTP` | | `false` | Set to `true` to run over HTTP (for local testing only). |
| `LOG_LEVEL` | | `info` | Pino log level (`trace`, `debug`, …). |
| `PRETTY_LOGS` | | `false` | Pretty-print logs when stdout is a TTY. |
| `REQUEST_TIMEOUT_MS` | | `45000` | Timeout for pending MCP requests. |
| `HEARTBEAT_INTERVAL_MS` | | `15000` | Interval between SSE heartbeat comments. |
| `IDLE_TIMEOUT_MS` | | `120000` | Disconnect SSE clients after this idle period. |

> \* `TLS_CERT_PATH` and `TLS_KEY_PATH` must be supplied unless `ALLOW_HTTP=true`.

## Local Development

```bash
npm install
npm run build
npm start
```

Set `ALLOW_HTTP=true` and `PORT=8080` in your environment when developing without TLS.

## Docker Usage

```bash
docker build -t mabl-mcp-proxy .
docker run \
  -e MABL_API_KEY=changeme \
  -e TLS_CERT_PATH=/secrets/fullchain.pem \
  -e TLS_KEY_PATH=/secrets/privkey.pem \
  -p 443:443 \
  -v /path/to/certs:/secrets:ro \
  mabl-mcp-proxy
```

For local testing without TLS:

```bash
docker run \
  -e MABL_API_KEY=changeme \
  -e ALLOW_HTTP=true \
  -e PORT=8080 \
  -p 8080:8080 \
  mabl-mcp-proxy
```

## Endpoints

- `GET /` – Service metadata and uptime.
- `GET /messages?session=<id>` – Establish MCP SSE stream.
- `POST /messages` – Forward MCP JSON-RPC payloads (`{ "session": "...", "body": { ... } }`).
- `GET /healthz` – Liveness information including CLI status.
- `GET /readyz` – Readiness indicator (200 when CLI is running).
- `GET /metrics` – Prometheus metrics.

## TLS Material

Mount certificates into the container (or bake via secrets) and point `TLS_CERT_PATH`, `TLS_KEY_PATH`, and optionally `TLS_CA_PATH` at the mounted files. Certificates are read at startup; restart the container to pick up renewals.

## ChatGPT Configuration

Once deployed behind a public HTTPS endpoint with a trusted certificate, register the ChatGPT MCP server with:

```
https://<your-domain>/
```

ChatGPT will:

1. Open an SSE stream on `/messages?session=<UUID>`.
2. POST MCP JSON-RPC envelopes to `/messages`.
3. Receive translated responses/events over the SSE connection.

Ensure the container can reach the Internet so `npx @mablhq/mabl-cli@latest mcp start` can download and update the CLI when needed.

## Continuous Delivery

The repository ships with a GitHub Actions workflow (`.github/workflows/ci.yml`) that:

- runs `npm ci`, linting, and the TypeScript build on every push and pull request to `main`;
- builds a Docker image with Buildx and pushes it to Docker Hub when commits land on `main` or when you push a tag that matches `v*.*.*`.

### Setup Steps

1. Create a new GitHub repository (e.g. `mabl-mcp-proxy`) and push this codebase to `main`.
2. In the repo settings, add secrets:
   - `DOCKERHUB_USERNAME` – your Docker Hub username.
   - `DOCKERHUB_TOKEN` – a Docker Hub access token with `write:packages`.
3. Optionally enable branch protection on `main` so pull requests must pass CI.

Once configured, every merge to `main` publishes `docker.io/<org-or-user>/<repo>:main` plus semver tags for releases. Point your TrueNAS app at that image (e.g. `docker.io/yourname/mabl-mcp-proxy:main`) so it always pulls the latest build.
