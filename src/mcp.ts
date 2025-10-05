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
  pageSizeSchema,
  offsetSchema,
  safeTruncate,
  resolveByName,
  guardUpload,
  sha256Hex,
  patchWithConflictRetry,
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
    "Lists users (concise). Returns nextOffset when truncated.",
    {
      pageSize: pageSizeSchema.optional().describe("Number of users per page (max 100)"),
      offset: offsetSchema.optional().describe("Page number to retrieve (1-indexed)"),
      full: z.boolean().optional().default(false).describe("Return full payload if true"),
    },
    withOpenProject(async (api, { pageSize = 25, offset = 1, full = false }: any) => {
      const resp = await api.get("/users", { params: { pageSize, offset } });
      const els = resp.data?._embedded?.elements ?? [];

      if (full) {
        const nextOffset = els.length < pageSize ? null : offset + 1;
        return {
          content: [
            { type: "text", text: `Users: ${els.length} (page=${offset}, size=${pageSize}) nextOffset=${nextOffset ?? "none"}` },
            { type: "text", text: JSON.stringify({ items: els, nextOffset }) },
          ],
        };
      }

      const concise = els.map((u: any) => ({
        id: u.id,
        name: u.name ?? u._links?.self?.title ?? null,
        login: u.login ?? null,
      }));
      const nextOffset = concise.length < pageSize ? null : offset + 1;
      return {
        content: [
          { type: "text", text: `Users: ${concise.length} (page=${offset}, size=${pageSize}) nextOffset=${nextOffset ?? "none"}` },
          { type: "text", text: JSON.stringify({ items: concise, nextOffset }) },
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
      idempotencyKey: z.string().optional().describe("Optional Idempotency-Key header"),
    },
    withOpenProject(async (api, params: any) => {
      const { name, identifier, description, idempotencyKey } = params;
      const config: any = {};
      if (idempotencyKey) config.headers = { "Idempotency-Key": idempotencyKey };

      const response = await api.post("/projects", { name, identifier, description: description || "" }, config);
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
      startDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "Date must be YYYY-MM-DD").optional().describe("Start date in YYYY-MM-DD format"),
      dueDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "Date must be YYYY-MM-DD").optional().describe("Due date in YYYY-MM-DD format"),
      idempotencyKey: z.string().optional().describe("Optional Idempotency-Key header"),
    },
    withOpenProject(async (api, params: any) => {
      let { projectId, subject, description, type, startDate, dueDate, idempotencyKey } = params;

      // Resolve projectId that might be an identifier string
      let projectNumericId = projectId;
      try {
        // try direct get first (works if numeric id or identifier supported)
        await api.get(`/projects/${projectId}`);
      } catch (err) {
        // fallback: try to find by identifier in project list
        try {
          const list = await api.get("/projects", { params: { pageSize: 100, offset: 1 } });
          const found = (list.data?._embedded?.elements ?? []).find((p: any) => p.identifier === projectId || p.name === projectId);
          if (found) projectNumericId = found.id;
        } catch {
          // ignore, will let post fail below
        }
      }

      const payload: any = {
        subject,
        description: { raw: description || "" },
        _links: {
          type: { href: type },
          project: { href: `/api/v3/projects/${projectNumericId}` },
        },
      };

      if (startDate) payload.startDate = startDate;
      if (dueDate) payload.dueDate = dueDate;

      const config: any = { headers: {} };
      if (idempotencyKey) config.headers["Idempotency-Key"] = idempotencyKey;

      const response = await api.post(`/projects/${projectNumericId}/work_packages`, payload, config);

      return {
        content: [
          {
            type: "text",
            text: `Successfully created task: ${response.data.subject} (ID: ${response.data.id}) in project ${projectNumericId}`,
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

  // Variant: iterate internally and return a compact array of projects only
  server.tool(
    "openproject-list-projects-all",
    "Lists all projects (compact) by iterating pages internally and returning a concise array",
    {
      pageSize: pageSizeSchema.optional().describe("Page size for internal paging (max 100)"),
    },
    withOpenProject(async (api, params: any) => {
      const per = params?.pageSize ?? 100;
      let offset = 1;
      const all: any[] = [];
      while (true) {
        const resp = await api.get("/projects", { params: { pageSize: per, offset } });
        const els = resp.data?._embedded?.elements ?? [];
        for (const p of els) {
          all.push({
            id: p.id,
            name: p.name,
            identifier: p.identifier,
            status: p._links?.status?.title ?? null,
          });
        }
        if (!els.length || els.length < per) break;
        offset += els.length;
      }
      return {
        content: [
          { type: "text", text: `Projects: ${all.length} (fetched pagesize=${per})` },
          { type: "text", text: JSON.stringify(all) },
        ],
      };
    })
  );

  // Health check tool: verifies URL and auth by calling /users/me
  server.tool(
    "openproject-health",
    "Checks OpenProject URL and authentication (/users/me)",
    {},
    withOpenProject(async (api) => {
      try {
        const resp = await api.get("/users/me");
        const u = resp.data || {};
        return {
          content: [
            { type: "text", text: `OK: user=${u.login ?? u.name ?? u.id ?? "<unknown>"}` },
            { type: "text", text: JSON.stringify({ id: u.id ?? null, name: u.name ?? null, login: u.login ?? null }) },
          ],
        };
      } catch (err: unknown) {
        const short = getErrorMessage(err);
        return { content: [{ type: "text", text: `ERROR: ${short}` }] };
      }
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
    "Lists tasks (concise). Default concise mapping; set full=true to return full payload. Returns nextOffset when truncated.",
    {
      projectId: z.string().optional(),
      pageSize: pageSizeSchema.optional().describe("Number of tasks per page (max 100)"),
      offset: offsetSchema.optional().describe("Page number to retrieve (1-indexed)"),
      full: z.boolean().optional().default(false).describe("Return full payload if true"),
    },
    withOpenProject(async (api, { projectId, pageSize = 25, offset = 1, full = false }: any) => {
      const url = projectId ? `/projects/${projectId}/work_packages` : `/work_packages`;
      const resp = await api.get(url, { params: { pageSize, offset } });
      const els = resp.data?._embedded?.elements ?? [];

      // If full requested, return the original elements and nextOffset
      if (full) {
        const nextOffset = els.length < pageSize ? null : offset + 1;
        return {
          content: [
            { type: "text", text: `Tasks: ${els.length} (page=${offset}, size=${pageSize}) nextOffset=${nextOffset ?? "none"}` },
            { type: "text", text: JSON.stringify({ items: els, nextOffset }) },
          ],
        };
      }

      const concise = els.map((w: any) => ({
        id: w.id,
        subject: w.subject,
        startDate: w.startDate ?? null,
        dueDate: w.dueDate ?? null,
        status: w._links?.status?.title ?? null,
        assignee: w._links?.assignee?.title ?? null,
        priority: w._links?.priority?.title ?? null,
        project: w._links?.project?.title ?? null,
      }));
      const nextOffset = concise.length < pageSize ? null : offset + 1;
      return {
        content: [
          { type: "text", text: `Tasks: ${concise.length} (page=${offset}, size=${pageSize}) nextOffset=${nextOffset ?? "none"}` },
          { type: "text", text: JSON.stringify({ items: concise, nextOffset }) },
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
      idempotencyKey: z.string().optional().describe("Optional Idempotency-Key header"),
    },
    withOpenProject(async (api, params: any) => {
      const { projectId, name, description, idempotencyKey } = params;
      const updatePayload: any = {};
      if (name) updatePayload.name = name;
      if (description) updatePayload.description = description;
      if (Object.keys(updatePayload).length === 0) {
        return {
          content: [
            { type: "text", text: "ERROR: no fields provided to update" },
          ],
        };
      }
      const config: any = {};
      if (idempotencyKey) config.headers = { "Idempotency-Key": idempotencyKey };

      const response = await api.patch(`/projects/${projectId}`, updatePayload, config);
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
      lockVersion: z.number().optional().describe("The lockVersion of the task (obtained from a GET request)"),
      subject: z.string().optional().describe("New subject/title for the task"),
      description: z.string().optional().describe("New description for the task (provide as raw text)"),
      idempotencyKey: z.string().optional().describe("Optional Idempotency-Key header"),
    },
    withOpenProject(async (api, params: any) => {
      const { taskId, lockVersion, subject, description, idempotencyKey } = params;
      const updatePayload: any = {};
      if (lockVersion !== undefined) updatePayload.lockVersion = lockVersion;
      if (subject) updatePayload.subject = subject;
      if (description) updatePayload.description = { raw: description };

      if (Object.keys(updatePayload).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "ERROR: no fields provided to update",
            },
          ],
        };
      }

      const config: any = { headers: {} };
      if (idempotencyKey) config.headers["Idempotency-Key"] = idempotencyKey;

      // Use patchWithConflictRetry to handle 409 lockVersion automatically
      const resp = await patchWithConflictRetry(api, `/work_packages/${taskId}`, `/work_packages/${taskId}`, updatePayload, config);
      return {
        content: [
          { type: "text", text: `Successfully updated task: ${resp.data?.subject ?? "<unknown>"}` },
          { type: "text", text: JSON.stringify(resp.data) },
        ],
      };
    })
  );

  server.tool(
    "openproject-delete-project",
    "Deletes a project from OpenProject. This action is irreversible.",
    {
      projectId: z.string().describe("The ID of the project to delete"),
      idempotencyKey: z.string().optional().describe("Optional Idempotency-Key header"),
    },
    withOpenProject(async (api, params: any) => {
      const { projectId, idempotencyKey } = params;
      try {
        const config: any = {};
        if (idempotencyKey) config.headers = { "Idempotency-Key": idempotencyKey };
        await api.delete(`/projects/${projectId}`, config);
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
      idempotencyKey: z.string().optional().describe("Optional Idempotency-Key header"),
    },
    withOpenProject(async (api, params: any) => {
      const { taskId, idempotencyKey } = params;
      try {
        const config: any = {};
        if (idempotencyKey) config.headers = { "Idempotency-Key": idempotencyKey };
        await api.delete(`/work_packages/${taskId}`, config);
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
    "Uploads an attachment to an OpenProject resource. Provide `apiPath`, `filename`, and `contentBase64`. Optional checksumSha256 to verify.",
    {
      apiPath: z
        .string()
        .describe("API path to POST to, e.g. /projects/123/attachments or /work_packages/456/attachments"),
      filename: z.string().describe("Filename for the uploaded attachment"),
      contentBase64: z.string().describe("Base64-encoded file content"),
      contentType: z.string().optional().describe("MIME type").default("application/octet-stream"),
      checksumSha256: z.string().optional().describe("Optional hex SHA-256 checksum to validate upload"),
      idempotencyKey: z.string().optional().describe("Optional Idempotency-Key header"),
    },
    withOpenProject(async (api, params: any) => {
      const { apiPath, filename, contentBase64, contentType, checksumSha256, idempotencyKey } = params;

      // Guard upload early
      const guarded = guardUpload(apiPath, contentBase64, contentType);
      if (guarded) return guarded as CallToolResult;

      const buffer = Buffer.from(contentBase64, "base64");

      // optional checksum verification
      if (checksumSha256) {
        const actual = sha256Hex(buffer);
        if (actual !== checksumSha256.toLowerCase()) {
          return { content: [{ type: "text", text: "ERROR: checksum mismatch" }] };
        }
      }

      try {
        const url = `${apiPath}${apiPath.includes("?") ? "&" : "?"}filename=${encodeURIComponent(filename)}`;
        const headers: any = { "Content-Type": contentType || "application/octet-stream" };
        if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

        const response = await api.post(url, buffer, { headers });
        return {
          content: [
            { type: "text", text: `Uploaded attachment ${filename}` },
            { type: "text", text: JSON.stringify(response.data) },
          ],
        };
      } catch (error: unknown) {
        const errorMsg = getErrorMessage(error);
        return { content: [{ type: "text", text: `ERROR: ${errorMsg}` }] };
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
        return { content: [{ type: "text", text: `ERROR: ${errorMsg}` }] };
      }
    })
  );

  // --- Search tasks ---
  server.tool(
    "openproject-search-tasks",
    "Search tasks with simple filters (status, assignee, dueBefore, text). Returns concise items + nextOffset.",
    {
      projectId: z.string().optional().describe("Optional project ID to scope search"),
      status: z.string().optional().describe("Status title to filter by"),
      assignee: z.string().optional().describe("Assignee name to filter by"),
      dueBefore: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "Date must be YYYY-MM-DD").optional().describe("Date must be YYYY-MM-DD"),
      text: z.string().optional().describe("Substring to match in subject/description"),
      pageSize: pageSizeSchema.optional(),
      offset: offsetSchema.optional(),
    },
    withOpenProject(async (api, { projectId, status, assignee, dueBefore, text, pageSize = 25, offset = 1 }: any) => {
      const url = projectId ? `/projects/${projectId}/work_packages` : `/work_packages`;
      const resp = await api.get(url, { params: { pageSize, offset } });
      const els = resp.data?._embedded?.elements ?? [];

      // Client-side simple filters
      const filtered = els.filter((w: any) => {
        if (status && String(w._links?.status?.title ?? "").toLowerCase() !== String(status).toLowerCase()) return false;
        if (assignee && String(w._links?.assignee?.title ?? "").toLowerCase() !== String(assignee).toLowerCase()) return false;
        if (dueBefore && w.dueDate) {
          if (w.dueDate >= dueBefore) return false;
        }
        if (text) {
          const hay = `${w.subject ?? ""} ${(w.description?.raw) ?? ""}`.toLowerCase();
          if (!hay.includes(String(text).toLowerCase())) return false;
        }
        return true;
      });

      const concise = filtered.map((w: any) => ({
        id: w.id,
        subject: w.subject,
        startDate: w.startDate ?? null,
        dueDate: w.dueDate ?? null,
        status: w._links?.status?.title ?? null,
        assignee: w._links?.assignee?.title ?? null,
        priority: w._links?.priority?.title ?? null,
        project: w._links?.project?.title ?? null,
      }));

      const nextOffset = concise.length < pageSize ? null : offset + 1;
      return {
        content: [
          { type: "text", text: `Tasks: ${concise.length} (page=${offset}, size=${pageSize}) nextOffset=${nextOffset ?? "none"}` },
          { type: "text", text: JSON.stringify({ items: concise, nextOffset }) },
        ],
      };
    })
  );

  // --- Bulk update tasks ---
  server.tool(
    "openproject-bulk-update-tasks",
    "Bulk update tasks. ops: [{id, lockVersion?, subject?, description?, statusName?, assigneeName?}]",
    {
      ops: z.array(z.object({
        id: z.number().optional(),
        lockVersion: z.number().optional(),
        subject: z.string().optional(),
        description: z.string().optional(),
        statusName: z.string().optional(),
        assigneeName: z.string().optional(),
      })).describe("Array of operations"),
    },
    withOpenProject(async (api, params: any) => {
      const { ops } = params;
      const results: any[] = [];
      for (const op of ops) {
        try {
          const payload: any = {};
          if (op.subject) payload.subject = op.subject;
          if (op.description) payload.description = { raw: op.description };
          if (typeof op.lockVersion === "number") payload.lockVersion = op.lockVersion;

          // Resolve statusName and assigneeName -> _links
          if (op.statusName) {
            const href = await resolveByName(api, "/statuses", op.statusName);
            if (href) payload._links = payload._links || {}; payload._links.status = { href };
          }
          if (op.assigneeName) {
            const href = await resolveByName(api, "/users", op.assigneeName);
            if (href) payload._links = payload._links || {}; payload._links.assignee = { href };
          }

          if (!op.id) {
            results.push({ op, error: "no id provided" });
            continue;
          }
          if (Object.keys(payload).length === 0) {
            results.push({ op, result: "noop" });
            continue;
          }

          // Apply patch with conflict retry
          const resp = await patchWithConflictRetry(api, `/work_packages/${op.id}`, `/work_packages/${op.id}`, payload);
          results.push({ op, result: resp.data });
        } catch (err) {
          results.push({ op, error: getErrorMessage(err) });
        }
      }
      return {
        content: [
          { type: "text", text: `Bulk update completed: ops=${ops.length}` },
          { type: "text", text: JSON.stringify(results) },
        ],
      };
    })
  );

  // --- list statuses/priorities/users (concise) ---
  server.tool(
    "openproject-list-statuses",
    "Lists statuses (concise)",
    {},
    withOpenProject(async (api) => {
      const r = await api.get("/statuses");
      const els = r.data?._embedded?.elements ?? [];
      const concise = els.map((s: any) => ({ id: s.id, name: s.name ?? s.title, href: s._links?.self?.href ?? null }));
      return {
        content: [
          { type: "text", text: `Statuses: ${concise.length}` },
          { type: "text", text: JSON.stringify(concise) },
        ],
      };
    })
  );

  server.tool(
    "openproject-list-priorities",
    "Lists priorities (concise)",
    {},
    withOpenProject(async (api) => {
      const r = await api.get("/priorities");
      const els = r.data?._embedded?.elements ?? [];
      const concise = els.map((s: any) => ({ id: s.id, name: s.name ?? s.title, href: s._links?.self?.href ?? null }));
      return {
        content: [
          { type: "text", text: `Priorities: ${concise.length}` },
          { type: "text", text: JSON.stringify(concise) },
        ],
      };
    })
  );

  server.tool(
    "openproject-list-users-concise",
    "Lists users (concise) — alias for openproject-list-users with concise output",
    {},
    withOpenProject(async (api) => {
      const r = await api.get("/users", { params: { pageSize: 100, offset: 1 } });
      const els = r.data?._embedded?.elements ?? [];
      const concise = els.map((u: any) => ({ id: u.id, name: u.name, login: u.login, href: u._links?.self?.href ?? null }));
      return {
        content: [
          { type: "text", text: `Users: ${concise.length}` },
          { type: "text", text: JSON.stringify(concise) },
        ],
      };
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
