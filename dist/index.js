import { startServer } from "./server.js";
import { logger } from "./logger.js";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
(async () => {
    try {
        const { port, stop } = await startServer(PORT);
        const shutdown = async (signal) => {
            logger.info({ signal }, "Received shutdown signal, stopping server");
            try {
                await stop();
                logger.info("Server stopped cleanly");
                process.exit(0);
            }
            catch (err) {
                logger.error({ err }, "Error during shutdown");
                process.exit(1);
            }
        };
        process.on("SIGINT", () => void shutdown("SIGINT"));
        process.on("SIGTERM", () => void shutdown("SIGTERM"));
        process.on("uncaughtException", (err) => {
            logger.error({ err }, "uncaughtException, exiting");
            process.exit(1);
        });
        process.on("unhandledRejection", (reason) => {
            logger.error({ reason }, "unhandledRejection, exiting");
            process.exit(1);
        });
        logger.info({ port }, "MCP server running");
    }
    catch (err) {
        logger.error({ err }, "Failed to start MCP server");
        process.exit(1);
    }
})();
