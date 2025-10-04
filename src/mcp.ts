import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  withOpenProject,
  missingConfigResult,
  getErrorMessage,
  isNotFoundError,
} from "./helpers.js";
import { logger } from "./logger.js";

type ToolContext = RequestHandlerExtra<ServerRequest, ServerNotification> & {
  config?: Record<string, string | undefined>;
};

export const setupMCPServer = (): McpServer => {
  const server = new McpServer(
    {
      name: "stateless-server",
      version: "1.0.0",
    },
    { capabilities: { logging: {} } }
  );

  // Prompt template
  server.prompt(
    "greeting-template",
    "A simple greeting prompt template",
    {
      name: z.string().describe("Name to include in greeting"),
    },
    async ({ name }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please greet ${name} in a friendly manner.`,
            },
          },
        ],
      };
    }
  );

  // Notification stream test tool
  server.tool(
    "start-notification-stream",
    "Starts sending periodic notifications for testing resumability",
    {
      interval: z
        .number()
        .describe("Interval in milliseconds between notifications")
        .default(100),
      count: z
        .number()
        .describe("Number of notifications to send (0 for 100)")
        .default(10),
    },
    async ({ interval, count }, { sendNotification }): Promise<CallToolResult> => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      let counter = 0;

      while (count === 0 || counter < count) {
        counter++;
        try {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: `Periodic notification #${counter} at ${new Date().toISOString()}`,
            },
          });
        } catch (error: unknown) {
          logger.error({ err: error }, "Error sending notification");
        }
        await sleep(interval);
      }

      return {
        content: [
          {
            type: "text",
            text: `Started sending periodic notifications every ${interval}ms`,
          },
        ],
      };
    }
  );

  // Greeting resource
  server.resource(
    "greeting-resource",
    "https://example.com/greetings/default",
    { mimeType: "text/plain" },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: "https://example.com/greetings/default",
            text: "Hello, world!",
          },
        ],
      };
    }
  );

  // --- OpenProject tools (use withOpenProject to remove repetition) ---
  server.tool(
    "openproject-list-users",
    "Lists all users in OpenProject",
    {
      pageSize: z.number().optional(),
      offset: z.number().optional(),
    },
    withOpenProject(async (api, params) => {
      const response = await api.get("/users", { params });
      return {
        content: [
          { type: "text", text: `Found ${response.data.count} users` },
          { type: "text", text: JSON.stringify(response.data) },
        ],
      };
    })
  );

  server.tool(
    "openproject-create-project",
    "Creates a new project in OpenProject",
    {
      name: z.string().describe("Name of the project"),
      identifier: z.string().describe("Identifier of the project (unique)"),
      description: z.string().optional().describe("Optional description for the project"),
    },
    withOpenProject(async (api, params: any) => {
      const { name, identifier, description } = params;
      const response = await api.post("/projects", {
        name,
        identifier,
        description: description || "",
      });
      return {
        content: [
          {
            type: "text",
            text: `Successfully created project: ${response.data.name} (ID: ${response.data.id})`,
          },
          { type: "text", text: JSON.stringify(response.data) },
        ],
      };
    })
  );

  server.tool(
    "openproject-create-task",
    "Creates a new task (work package) in an OpenProject project",
    {
      projectId: z.string().describe("The ID or identifier of the project to add the task to"),
      subject: z.string().describe("Subject/title of the task"),
      description: z.string().optional().describe("Optional description for the task"),
      type: z.string().default("/api/v3/types/1").describe("Type of the work package (e.g., /api/v3/types/1 for Task)"),
      startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
      dueDate: z.string().optional().describe("Due date in YYYY-MM-DD format"),
    },
    withOpenProject(async (api, params: any) => {
      const { projectId, subject, description, type, startDate, dueDate } = params;
      
      const payload: any = {
        subject,
        description: { raw: description || "" },
        _links: {
          type: { href: type },
          project: { href: `/api/v3/projects/${projectId}` },
        },
      };

      // Ajouter les dates si fournies (format API OpenProject v3)
      if (startDate) payload.startDate = startDate;
      if (dueDate) payload.dueDate = dueDate;

      const response = await api.post(`/projects/${projectId}/work_packages`, payload);
      
      return {
        content: [
          {
            type: "text",
            text: `Successfully created task: ${response.data.subject} (ID: ${response.data.id}) in project ${projectId}`,
          },
          { type: "text", text: JSON.stringify(response.data) },
        ],
      };
    })
  );

  server.tool(
    "openproject-get-project",
    "Gets a specific project by its ID from OpenProject",
    {
      projectId: z.string().describe("The ID of the project to retrieve"),
    },
    withOpenProject(async (api, params: any) => {
      const { projectId } = params;
      const response = await api.get(`/projects/${projectId}`);
      return {
        content: [
          { type: "text", text: `Successfully retrieved project: ${response.data.name}` },
          { type: "text", text: JSON.stringify(response.data) },
        ],
      };
    })
  );

  server.tool(
    "openproject-list-projects",
    "Lists all projects in OpenProject",
    {
      pageSize: z.number().optional().describe("Number of projects per page"),
      offset: z.number().optional().describe("Page number to retrieve (1-indexed)"),
    },
    withOpenProject(async (api, params: any) => {
      const { pageSize, offset } = params;
      const qparams: any = {};
      if (pageSize) qparams.pageSize = pageSize;
      if (offset) qparams.offset = offset;
      const response = await api.get("/projects", { params: qparams });
      const count = response.data?._embedded?.elements?.length ?? 0;
      const total = response.data?.total ?? "unknown";
      return {
        content: [
          {
            type: "text",
            text: `Successfully retrieved ${count} projects (Total: ${total})`,
          },
          { type: "text", text: JSON.stringify(response.data) },
        ],
      };
    })
  );

  server.tool(
    "openproject-get-task",
    "Gets a specific task (work package) by its ID from OpenProject",
    {
      taskId: z.string().describe("The ID of the task to retrieve"),
    },
    withOpenProject(async (api, params: any) => {
      const { taskId } = params;
      const response = await api.get(`/work_packages/${taskId}`);
      return {
        content: [
          { type: "text", text: `Successfully retrieved task: ${response.data.subject}` },
          { type: "text", text: JSON.stringify(response.data) },
        ],
      };
    })
  );

  server.tool(
    "openproject-list-tasks",
    "Lists tasks (work packages) in OpenProject, optionally filtered by project ID",
    {
      projectId: z.string().optional().describe("Optional ID of the project to filter tasks by"),
      pageSize: z.number().optional().describe("Number of tasks per page"),
      offset: z.number().optional().describe("Page number to retrieve (1-indexed)"),
    },
    withOpenProject(async (api, params: any) => {
      const { projectId, pageSize, offset } = params;
      let url = "/work_packages";
      const qparams: any = {};
      if (pageSize) qparams.pageSize = pageSize;
      if (offset) qparams.offset = offset;
      if (projectId) url = `/projects/${projectId}/work_packages`;
      const response = await api.get(url, { params: qparams });
      const count = response.data?._embedded?.elements?.length ?? 0;
      const total = response.data?.total ?? "unknown";
      return {
        content: [
          { type: "text", text: `Successfully retrieved ${count} tasks (Total: ${total})` },
          { type: "text", text: JSON.stringify(response.data) },
        ],
      };
    })
  );

  server.tool(
    "openproject-update-project",
    "Updates an existing project in OpenProject. Only include fields to be changed.",
    {
      projectId: z.string().describe("The ID of the project to update"),
      name: z.string().optional().describe("New name for the project"),
      description: z.string().optional().describe("New description for the project"),
    },
    withOpenProject(async (api, params: any) => {
      const { projectId, name, description } = params;
      const updatePayload: any = {};
      if (name) updatePayload.name = name;
      if (description) updatePayload.description = description;
      if (Object.keys(updatePayload).length === 0) {
        return {
          content: [
            { type: "text", text: "Error: No fields provided to update for the project." },
          ],
        };
      }
      const response = await api.patch(`/projects/${projectId}`, updatePayload);
      return {
        content: [
          { type: "text", text: `Successfully updated project: ${response.data.name}` },
          { type: "text", text: JSON.stringify(response.data) },
        ],
      };
    })
  );

  server.tool(
    "openproject-update-task",
    "Updates an existing task (work package) in OpenProject. Only include fields to be changed.",
    {
      taskId: z.string().describe("The ID of the task to update"),
      lockVersion: z.number().describe("The lockVersion of the task (obtained from a GET request)"),
      subject: z.string().optional().describe("New subject/title for the task"),
      description: z.string().optional().describe("New description for the task (provide as raw text)"),
    },
    withOpenProject(async (api, params: any) => {
      const { taskId, lockVersion, subject, description } = params;
      const updatePayload: any = { lockVersion };
      if (subject) updatePayload.subject = subject;
      if (description) updatePayload.description = { raw: description };
      if (Object.keys(updatePayload).filter((k) => k !== "lockVersion").length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No fields (besides lockVersion) provided to update for the task.",
            },
          ],
        };
      }
      const response = await api.patch(`/work_packages/${taskId}`, updatePayload);
      return {
        content: [
          { type: "text", text: `Successfully updated task: ${response.data.subject}` },
          { type: "text", text: JSON.stringify(response.data) },
        ],
      };
    })
  );

  server.tool(
    "openproject-delete-project",
    "Deletes a project from OpenProject. This action is irreversible.",
    {
      projectId: z.string().describe("The ID of the project to delete"),
    },
    withOpenProject(async (api, params: any) => {
      const { projectId } = params;
      try {
        await api.delete(`/projects/${projectId}`);
        return {
          content: [{ type: "text", text: `Successfully deleted project with ID: ${projectId}` }],
        };
      } catch (error: unknown) {
        if (isNotFoundError(error)) {
          return {
            content: [
              {
                type: "text",
                text: `Project with ID ${projectId} not found. It might have already been deleted.`,
              },
            ],
          };
        }
        throw error;
      }
    })
  );

  server.tool(
    "openproject-delete-task",
    "Deletes a task (work package) from OpenProject. This action is irreversible.",
    {
      taskId: z.string().describe("The ID of the task to delete"),
    },
    withOpenProject(async (api, params: any) => {
      const { taskId } = params;
      try {
        await api.delete(`/work_packages/${taskId}`);
        return {
          content: [{ type: "text", text: `Successfully deleted task with ID: ${taskId}` }],
        };
      } catch (error: unknown) {
        if (isNotFoundError(error)) {
          return {
            content: [
              {
                type: "text",
                text: `Task with ID ${taskId} not found. It might have already been deleted.`,
              },
            ],
          };
        }
        throw error;
      }
    })
  );

  // --- Attachments tools ---
  server.tool(
    "openproject-upload-attachment",
    "Uploads an attachment to an OpenProject resource. Provide `apiPath`, `filename`, and `contentBase64`.",
    {
      apiPath: z
        .string()
        .describe("API path to POST to, e.g. /projects/123/attachments or /work_packages/456/attachments"),
      filename: z.string().describe("Filename for the uploaded attachment"),
      contentBase64: z.string().describe("Base64-encoded file content"),
      contentType: z.string().optional().describe("MIME type").default("application/octet-stream"),
    },
    withOpenProject(async (api, params: any) => {
      const { apiPath, filename, contentBase64, contentType } = params;
      const buffer = Buffer.from(contentBase64, "base64");
      try {
        const url = `${apiPath}${apiPath.includes("?") ? "&" : "?"}filename=${encodeURIComponent(
          filename
        )}`;
        const response = await api.post(url, buffer, {
          headers: {
            "Content-Type": contentType || "application/octet-stream",
          },
        });
        return {
          content: [
            { type: "text", text: `Uploaded attachment ${filename}` },
            { type: "text", text: JSON.stringify(response.data) },
          ],
        };
      } catch (error: unknown) {
        const errorMsg = getErrorMessage(error);
        return { content: [{ type: "text", text: `Error uploading attachment: ${errorMsg}` }] };
      }
    })
  );

  server.tool(
    "openproject-download-attachment",
    "Downloads an attachment from OpenProject as base64. Provide `attachmentPath` (full API path).",
    {
      attachmentPath: z
        .string()
        .describe("API path to GET attachment, e.g. /attachments/123"),
    },
    withOpenProject(async (api, params: any) => {
      const { attachmentPath } = params;
      try {
        const response = await api.get(attachmentPath, { responseType: "arraybuffer" as const });
        const contentType = response.headers?.["content-type"] || "application/octet-stream";
        const base64 = Buffer.from(response.data).toString("base64");
        return {
          content: [
            { type: "text", text: `Downloaded attachment (${contentType}) as base64` },
            { type: "text", text: base64 },
          ],
        };
      } catch (error: unknown) {
        const errorMsg = getErrorMessage(error);
        return { content: [{ type: "text", text: `Error downloading attachment: ${errorMsg}` }] };
      }
    })
  );

  // --- Sync tool: bidirectional synchronization for projects/tasks ---
  server.tool(
    "openproject-sync",
    "Synchronize tasks between OpenProject and an external system. Supports pull, push or both.",
    {
      projectId: z.string().optional().describe("Optional project ID to scope the sync"),
      direction: z
        .enum(["pull", "push", "both"])
        .default("both")
        .describe("Direction of sync: pull (from OpenProject), push (to OpenProject), or both"),
      itemsToPush: z.array(z.any()).optional().describe("When pushing, array of task-like objects to create/update"),
      dryRun: z.boolean().optional().default(false).describe("If true, do not perform writes; return planned actions"),
      batchSize: z.number().optional().default(50).describe("Batch size for paging through OpenProject lists"),
    },
    withOpenProject(async (api, params: any, context?: ToolContext): Promise<CallToolResult> => {
      const { projectId, direction, itemsToPush, dryRun, batchSize } = params;

      // Simple in-memory lock to avoid concurrent syncs for the same project
      const LOCK_KEY = projectId || "__global__";
      const globalAny: any = globalThis as any;
      globalAny.__openproject_sync_locks = globalAny.__openproject_sync_locks || new Map();
      const syncLocks: Map<string, number> = globalAny.__openproject_sync_locks;

      if (syncLocks.has(LOCK_KEY)) {
        return {
          content: [
            { type: "text", text: `Sync already in progress for ${LOCK_KEY}` },
          ],
        };
      }

      syncLocks.set(LOCK_KEY, Date.now());
      try {
        const results: any = { pulled: [], pushed: [], errors: [] };

        // PULL: read tasks from OpenProject and notify external systems (via context.sendNotification if available)
        if (direction === "pull" || direction === "both") {
          if (!projectId) {
            results.errors.push("projectId is required for pull direction");
          } else {
            let offset = 0;
            let totalFetched = 0;
            while (true) {
              const resp = await api.get(`/projects/${projectId}/work_packages`, {
                params: { pageSize: batchSize, offset },
              });
              const elements = resp.data?._embedded?.elements ?? [];
              for (const el of elements) {
                results.pulled.push(el);
                try {
                  if (context && typeof (context as any).sendNotification === "function") {
                    await (context as any).sendNotification({
                      method: "sync/openproject/item",
                      params: { projectId, item: el },
                    });
                  }
                } catch (err) {
                  // ignore forward errors but record them
                  results.errors.push(`notify error for item ${el.id || "<no-id>"}: ${getErrorMessage(err)}`);
                }
              }
              totalFetched += elements.length;
              if (!resp.data?._embedded?.elements || elements.length < batchSize) break;
              offset += elements.length;
            }
          }
        }

        // PUSH: create or update items in OpenProject provided in itemsToPush
        if ((direction === "push" || direction === "both") && Array.isArray(itemsToPush)) {
          if (!projectId) {
            results.errors.push("projectId is required for push direction");
          } else {
            for (const item of itemsToPush) {
              try {
                if (dryRun) {
                  results.pushed.push({ action: item.id ? "update" : "create", item });
                  continue;
                }
                if (item.id) {
                  // Update existing work package. Support subject and description if provided.
                  const payload: any = {};
                  if (item.subject) payload.subject = item.subject;
                  if (item.description) payload.description = { raw: item.description };
                  // lockVersion if provided
                  if (typeof item.lockVersion === "number") payload.lockVersion = item.lockVersion;
                  if (Object.keys(payload).length === 0) {
                    results.pushed.push({ action: "noop", id: item.id, reason: "no updatable fields" });
                    continue;
                  }
                  const resp = await api.patch(`/work_packages/${item.id}`, payload);
                  results.pushed.push({ action: "update", id: item.id, result: resp.data });
                } else {
                  // Create new work package in target project
                  const createPayload: any = {
                    subject: item.subject || "No subject",
                    description: { raw: item.description || "" },
                    _links: {
                      project: { href: `/api/v3/projects/${projectId}` },
                      type: { href: item.type || "/api/v3/types/1" },
                    },
                  };
                  const resp = await api.post(`/projects/${projectId}/work_packages`, createPayload);
                  results.pushed.push({ action: "create", result: resp.data });
                }
              } catch (err) {
                const errMsg = getErrorMessage(err);
                results.errors.push(`push error for item ${item.id || item.subject || "<no-id>"}: ${errMsg}`);
              }
            }
          }
        }

        return {
          content: [
            { type: "text", text: `Sync completed: pulled=${results.pulled.length || 0}, pushed=${results.pushed.length || 0}, errors=${results.errors.length || 0}` },
            { type: "text", text: JSON.stringify(results) },
          ],
        };
      } finally {
        syncLocks.delete(LOCK_KEY);
      }
    })
  );

  logger.info("MCP server configured with OpenProject tools");
  return server;
};
