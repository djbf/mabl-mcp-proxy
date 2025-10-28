import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { MablCli } from "./mablCli";
import { createServer } from "./server";

async function main() {
  const config = await loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    pretty: config.prettyLogs,
  });

  const cli = new MablCli({
    apiKey: config.mablApiKey,
    logger: logger.child({ component: "mablCli" }),
  });

  await cli.start();

  const { server, close } = createServer(config, logger, cli);

  server.listen(config.port, config.host, () => {
    logger.info(
      { port: config.port, host: config.host, tls: Boolean(config.tls) },
      "mabl MCP proxy listening.",
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal.");
    try {
      await close();
      process.exit(0);
    } catch (error) {
      logger.error({ error }, "Error during shutdown.");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection.");
  });

  process.on("uncaughtException", (error) => {
    logger.error({ error }, "Uncaught exception.");
    void shutdown("uncaughtException");
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console -- logging not yet available.
  console.error("Failed to start mabl MCP proxy.", error);
  process.exit(1);
});
