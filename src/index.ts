import { z } from "zod";
import axios from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  JSONRPCError,
} from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Helper to create OpenProject API client from config or env, never throws
function getOpenProjectApi(config?: any) {
  const OPENPROJECT_API_KEY = config?.OPENPROJECT_API_KEY || process.env.OPENPROJECT_API_KEY;
  const OPENPROJECT_URL = config?.OPENPROJECT_URL || process.env.OPENPROJECT_URL;
  const OPENPROJECT_API_VERSION = config?.OPENPROJECT_API_VERSION || process.env.OPENPROJECT_API_VERSION || "v3";
  if (!OPENPROJECT_API_KEY || !OPENPROJECT_URL) {
    // Do not throw, just return null
    return null;
  }
  return axios.create({
    baseURL: `${OPENPROJECT_URL}/api/${OPENPROJECT_API_VERSION}`,
    headers: {
      'Authorization': `Basic ${Buffer.from(`apikey:${OPENPROJECT_API_KEY}`).toString('base64')}`,
      'Content-Type': 'application/json'
    }
  });
}

export const setupMCPServer = (): McpServer => {
  const server = new McpServer(
    {
      name: "stateless-server",
      version: "1.0.0",
    },
    { capabilities: { logging: {} } }
  );

  // Register a prompt template that allows the server to
  // provide the context structure and (optionally) the variables
  // that should be placed inside of the prompt for client to fill in.
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

  // Register a tool specifically for testing the ability
  // to resume notification streams to the client
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
    async (
      { interval, count },
      { sendNotification }
    ): Promise<CallToolResult> => {
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
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
        } catch (error) {
          console.error("Error sending notification:", error);
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

  // Create a resource that can be fetched by the client through
  // this MCP server.
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

  // --- OpenProject Tools ---
  // All OpenProject tools now lazy-load the API client and config
 server.tool("openproject-list-users", "Lists all users in OpenProject", {
      pageSize: z.number().optional(),
      offset: z.number().optional(),
  }, async (params) => {
      const openProjectApi = getOpenProjectApi();
      try {
          const response = await openProjectApi.get('/users', { params });
          return {
              content: [
                  { type: "text", text: `Found ${response.data.count} users` },
                  { type: "text", text: JSON.stringify(response.data) }
              ],
          };
      } catch (error) {
          return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
  });
  server.tool(
    "openproject-create-project",
    "Creates a new project in OpenProject",
    {
      name: z.string().describe("Name of the project"),
      identifier: z.string().describe("Identifier of the project (unique)"),
      description: z.string().optional().describe("Optional description for the project"),
    },
    async (params, context: any): Promise<CallToolResult> => {
      const { name, identifier, description } = params;
      const openProjectApi = getOpenProjectApi(context?.config);
      if (!openProjectApi) {
        return {
          content: [
            {
              type: "text",
              text: "OpenProject configuration is missing. Please provide OPENPROJECT_API_KEY and OPENPROJECT_URL."
            }
          ]
        };
      }
      try {
        const response = await openProjectApi.post('/projects', {
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
            {
              type: "text",
              text: JSON.stringify(response.data),
            }
          ],
        };
      } catch (error: any) {
        const errorMsg = error.message || (error.response?.data && JSON.stringify(error.response.data)) || "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error creating project: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "openproject-create-task",
    "Creates a new task (work package) in an OpenProject project",
    {
      projectId: z.string().describe("The ID or identifier of the project to add the task to"),
      subject: z.string().describe("Subject/title of the task"),
      description: z.string().optional().describe("Optional description for the task"),
      type: z.string().default("/api/v3/types/1").describe("Type of the work package (e.g., /api/v3/types/1 for Task)"),
    },
    async (params, context: any): Promise<CallToolResult> => {
      const { projectId, subject, description, type } = params;
      const openProjectApi = getOpenProjectApi(context?.config);
      if (!openProjectApi) {
        return {
          content: [
            {
              type: "text",
              text: "OpenProject configuration is missing. Please provide OPENPROJECT_API_KEY and OPENPROJECT_URL."
            }
          ]
        };
      }
      try {
        const response = await openProjectApi.post(`/projects/${projectId}/work_packages`, {
          subject,
          description: { raw: description || "" },
          _links: {
            type: {
              href: type
            },
            project: {
              href: `/api/v3/projects/${projectId}`
            }
          }
        });
        return {
          content: [
            {
              type: "text",
              text: `Successfully created task: ${response.data.subject} (ID: ${response.data.id}) in project ${projectId}`,
            },
            {
                type: "text",
                text: JSON.stringify(response.data),
            }
          ],
        };
      } catch (error: any) {
        const errorMsg = error.message || (error.response?.data && JSON.stringify(error.response.data)) || "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error creating task: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "openproject-get-project",
    "Gets a specific project by its ID from OpenProject",
    {
      projectId: z.string().describe("The ID of the project to retrieve"),
    },
    async (params, context: any): Promise<CallToolResult> => {
      const { projectId } = params;
      const openProjectApi = getOpenProjectApi(context?.config);
      if (!openProjectApi) {
        return {
          content: [
            {
              type: "text",
              text: "OpenProject configuration is missing. Please provide OPENPROJECT_API_KEY and OPENPROJECT_URL."
            }
          ]
        };
      }
      try {
        const response = await openProjectApi.get(`/projects/${projectId}`);
        return {
          content: [
            {
              type: "text",
              text: `Successfully retrieved project: ${response.data.name}`,
            },
            {
              type: "text",
              text: JSON.stringify(response.data),
            }
          ],
        };
      } catch (error: any) {
        const errorMsg = error.message || (error.response?.data && JSON.stringify(error.response.data)) || "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error getting project: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "openproject-list-projects",
    "Lists all projects in OpenProject",
    {
      pageSize: z.number().optional().describe("Number of projects per page"),
      offset: z.number().optional().describe("Page number to retrieve (1-indexed)")
    },
    async (params, context: any): Promise<CallToolResult> => {
      const { pageSize, offset } = params;
      const openProjectApi = getOpenProjectApi(context?.config);
      if (!openProjectApi) {
        return {
          content: [
            {
              type: "text",
              text: "OpenProject configuration is missing. Please provide OPENPROJECT_API_KEY and OPENPROJECT_URL."
            }
          ]
        };
      }
      try {
        const params: any = {};
        if (pageSize) params.pageSize = pageSize;
        if (offset) params.offset = offset;
        const response = await openProjectApi.get('/projects', { params });
        return {
          content: [
            {
              type: "text",
              text: `Successfully retrieved ${response.data._embedded.elements.length} projects (Total: ${response.data.total})`,
            },
            {
              type: "text",
              text: JSON.stringify(response.data),
            }
          ],
        };
      } catch (error: any) {
        const errorMsg = error.message || (error.response?.data && JSON.stringify(error.response.data)) || "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error listing projects: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "openproject-get-task",
    "Gets a specific task (work package) by its ID from OpenProject",
    {
      taskId: z.string().describe("The ID of the task to retrieve"),
    },
    async (params, context: any): Promise<CallToolResult> => {
      const { taskId } = params;
      const openProjectApi = getOpenProjectApi(context?.config);
      if (!openProjectApi) {
        return {
          content: [
            {
              type: "text",
              text: "OpenProject configuration is missing. Please provide OPENPROJECT_API_KEY and OPENPROJECT_URL."
            }
          ]
        };
      }
      try {
        const response = await openProjectApi.get(`/work_packages/${taskId}`);
        return {
          content: [
            {
              type: "text",
              text: `Successfully retrieved task: ${response.data.subject}`,
            },
            {
              type: "text",
              text: JSON.stringify(response.data),
            }
          ],
        };
      } catch (error: any) {
        const errorMsg = error.message || (error.response?.data && JSON.stringify(error.response.data)) || "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error getting task: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "openproject-list-tasks",
    "Lists tasks (work packages) in OpenProject, optionally filtered by project ID",
    {
      projectId: z.string().optional().describe("Optional ID of the project to filter tasks by"),
      pageSize: z.number().optional().describe("Number of tasks per page"),
      offset: z.number().optional().describe("Page number to retrieve (1-indexed)")
    },
    async (params, context: any): Promise<CallToolResult> => {
      const { projectId, pageSize, offset } = params;
      const openProjectApi = getOpenProjectApi(context?.config);
      if (!openProjectApi) {
        return {
          content: [
            {
              type: "text",
              text: "OpenProject configuration is missing. Please provide OPENPROJECT_API_KEY and OPENPROJECT_URL."
            }
          ]
        };
      }
      try {
        let url = '/work_packages';
        const params: any = {};
        if (pageSize) params.pageSize = pageSize;
        if (offset) params.offset = offset;
        if (projectId) {
          url = `/projects/${projectId}/work_packages`;
        }
        const response = await openProjectApi.get(url, { params });
        return {
          content: [
            {
              type: "text",
              text: `Successfully retrieved ${response.data._embedded.elements.length} tasks (Total: ${response.data.total})`,
            },
            {
              type: "text",
              text: JSON.stringify(response.data),
            }
          ],
        };
      } catch (error: any) {
        const errorMsg = error.message || (error.response?.data && JSON.stringify(error.response.data)) || "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error listing tasks: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "openproject-update-project",
    "Updates an existing project in OpenProject. Only include fields to be changed.",
    {
      projectId: z.string().describe("The ID of the project to update"),
      name: z.string().optional().describe("New name for the project"),
      description: z.string().optional().describe("New description for the project"),
    },
    async (params, context: any): Promise<CallToolResult> => {
      const { projectId, name, description } = params;
      const openProjectApi = getOpenProjectApi(context?.config);
      if (!openProjectApi) {
        return {
          content: [
            {
              type: "text",
              text: "OpenProject configuration is missing. Please provide OPENPROJECT_API_KEY and OPENPROJECT_URL."
            }
          ]
        };
      }
      const updatePayload: any = {};
      if (name) updatePayload.name = name;
      if (description) updatePayload.description = description;
      if (Object.keys(updatePayload).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No fields provided to update for the project."
            }
          ]
        }
      }
      try {
        const response = await openProjectApi.patch(`/projects/${projectId}`, updatePayload);
        return {
          content: [
            {
              type: "text",
              text: `Successfully updated project: ${response.data.name}`,
            },
            {
              type: "text",
              text: JSON.stringify(response.data),
            }
          ],
        };
      } catch (error: any) {
        const errorMsg = error.message || (error.response?.data && JSON.stringify(error.response.data)) || "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error updating project: ${errorMsg}`,
            },
          ],
        };
      }
    }
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
    async (params, context: any): Promise<CallToolResult> => {
      const { taskId, lockVersion, subject, description } = params;
      const openProjectApi = getOpenProjectApi(context?.config);
      if (!openProjectApi) {
        return {
          content: [
            {
              type: "text",
              text: "OpenProject configuration is missing. Please provide OPENPROJECT_API_KEY and OPENPROJECT_URL."
            }
          ]
        };
      }
      const updatePayload: any = { lockVersion };
      if (subject) updatePayload.subject = subject;
      if (description) updatePayload.description = { raw: description };
      if (Object.keys(updatePayload).filter(k => k !== 'lockVersion').length === 0) {
         return {
          content: [
            {
              type: "text",
              text: "Error: No fields (besides lockVersion) provided to update for the task."
            }
          ]
        }
      }
      try {
        const response = await openProjectApi.patch(`/work_packages/${taskId}`, updatePayload);
        return {
          content: [
            {
              type: "text",
              text: `Successfully updated task: ${response.data.subject}`,
            },
            {
              type: "text",
              text: JSON.stringify(response.data),
            }
          ],
        };
      } catch (error: any) {
        const errorMsg = error.message || (error.response?.data && JSON.stringify(error.response.data)) || "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error updating task: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "openproject-delete-project",
    "Deletes a project from OpenProject. This action is irreversible.",
    {
      projectId: z.string().describe("The ID of the project to delete"),
    },
    async (params, context: any): Promise<CallToolResult> => {
      const { projectId } = params;
      const openProjectApi = getOpenProjectApi(context?.config);
      if (!openProjectApi) {
        return {
          content: [
            {
              type: "text",
              text: "OpenProject configuration is missing. Please provide OPENPROJECT_API_KEY and OPENPROJECT_URL."
            }
          ]
        };
      }
      try {
        await openProjectApi.delete(`/projects/${projectId}`);
        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted project with ID: ${projectId}`,
            }
          ],
        };
      } catch (error: any) {
        const errorMsg = error.message || (error.response?.data && JSON.stringify(error.response.data)) || "Unknown error";
        if (error.response?.status === 404) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Project with ID ${projectId} not found. It might have already been deleted.`
                    }
                ]
            }
        }
        return {
          content: [
            {
              type: "text",
              text: `Error deleting project: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "openproject-delete-task",
    "Deletes a task (work package) from OpenProject. This action is irreversible.",
    {
      taskId: z.string().describe("The ID of the task to delete"),
    },
    async (params, context: any): Promise<CallToolResult> => {
      const { taskId } = params;
      const openProjectApi = getOpenProjectApi(context?.config);
      if (!openProjectApi) {
        return {
          content: [
            {
              type: "text",
              text: "OpenProject configuration is missing. Please provide OPENPROJECT_API_KEY and OPENPROJECT_URL."
            }
          ]
        };
      }
      try {
        await openProjectApi.delete(`/work_packages/${taskId}`);
        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted task with ID: ${taskId}`,
            }
          ],
        };
      } catch (error: any) {
        const errorMsg = error.message || (error.response?.data && JSON.stringify(error.response.data)) || "Unknown error";
        if (error.response?.status === 404) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Task with ID ${taskId} not found. It might have already been deleted.`
                    }
                ]
            }
        }
        return {
          content: [
            {
              type: "text",
              text: `Error deleting task: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  return server;
};

const app = express();
app.use(express.json());

const mcpServer = setupMCPServer();
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

// Connect the MCP server to the transport
mcpServer.connect(transport);

// Mount the MCP server at /mcp
app.all("/mcp", (req: Request, res: Response) => {
  // Pass the parsed body if available (for POST)
  transport.handleRequest(req, res, req.body);
});

// Health check endpoint
app.get("/", (_req: Request, res: Response) => res.send("MCP OpenProject server is running!"));

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`MCP server running on port ${PORT}`);
});
