import express from "express";
import http from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { setupMCPServer } from "./mcp.js";
import { logger } from "./logger.js";
/**
 * Start the HTTP + MCP server.
 * If port is 0 or undefined, the OS will pick a free port.
 */
export async function startServer(port) {
    const app = express();
    app.use(express.json());
    const mcpServer = setupMCPServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Connect MCP server to transport
    mcpServer.connect(transport);
    // Mount the MCP server endpoint
    app.all("/mcp", (req, res) => {
        // transport.handleRequest may be sync or async; don't await here to avoid changing signature,
        // but ensure errors are surfaced by try/catch if needed.
        try {
            // pass parsed body if available
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            transport.handleRequest(req, res, req.body);
        }
        catch (err) {
            logger.error({ err }, "Error handling /mcp request");
            res.status(500).send("Internal MCP error");
        }
    });
    // Health check
    app.get("/", (_req, res) => res.send("MCP OpenProject server is running!"));
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.listen(port ?? 8000, () => resolve());
        server.on("error", (err) => reject(err));
    });
    const actualPort = server.address()?.port ?? (port ?? 8000);
    logger.info({ port: actualPort }, "Server started");
    const stop = async () => {
        logger.info("Shutting down server");
        await new Promise((resolve, reject) => {
            server.close((err) => {
                if (err) {
                    logger.error({ err }, "Error closing HTTP server");
                    return reject(err);
                }
                resolve();
            });
        });
        try {
            // Try to gracefully disconnect MCP server if supported
            if (typeof mcpServer.disconnect === "function") {
                await mcpServer.disconnect();
            }
        }
        catch (err) {
            logger.warn({ err }, "Error while disconnecting MCP server (ignored)");
        }
        logger.info("Shutdown complete");
    };
    return { app, server, port: actualPort, stop };
}
