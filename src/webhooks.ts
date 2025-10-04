import express from "express";
import { logger } from "./logger.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Register OpenProject webhook endpoint.
 *
 * POST /webhooks/openproject
 * - optionally validates X-OpenProject-Webhook-Token against env OPENPROJECT_WEBHOOK_SECRET
 * - logs payload
 * - attempts to forward the event to the MCP server via sendNotification/notify if available
 */
export function registerOpenProjectWebhook(app: express.Express, mcpServer?: McpServer) {
  const secret = process.env.OPENPROJECT_WEBHOOK_SECRET;

  app.post("/webhooks/openproject", express.json(), async (req, res) => {
    try {
      const receivedToken = req.header("x-openproject-webhook-token") ?? req.header("x-hook-token");
      if (secret) {
        if (!receivedToken || receivedToken !== secret) {
          logger.warn(
            { receivedToken: !!receivedToken },
            "OpenProject webhook token missing or mismatched"
          );
          return res.status(401).json({ ok: false, error: "Invalid webhook token" });
        }
      }

      const payload = req.body;
      logger.info({ payload }, "Received OpenProject webhook");

      // Try to forward to MCP server as a notification if possible.
      try {
        // Different MCP server implementations may expose different APIs.
        // Try a couple of common method names safely.
        const anyServer: any = mcpServer as any;
        if (anyServer) {
          if (typeof anyServer.sendNotification === "function") {
            await anyServer.sendNotification({
              method: "webhook/openproject",
              params: { payload },
            });
            logger.debug("Forwarded webhook to mcpServer.sendNotification");
          } else if (typeof anyServer.notify === "function") {
            await anyServer.notify("webhook/openproject", { payload });
            logger.debug("Forwarded webhook to mcpServer.notify");
          } else {
            logger.debug("mcpServer present but has no notification API; skipping forward");
          }
        }
      } catch (err) {
        logger.warn({ err }, "Failed to forward webhook to MCP server (ignored)");
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      logger.error({ err }, "Error handling OpenProject webhook");
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  logger.info("OpenProject webhook endpoint registered at POST /webhooks/openproject");
}
