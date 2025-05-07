import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  JSONRPCError,
} from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios'; // Added for making HTTP requests

// OpenProject Configuration - Read from environment variables
const OPENPROJECT_API_KEY = process.env.OPENPROJECT_API_KEY;
const OPENPROJECT_URL = process.env.OPENPROJECT_URL;
const OPENPROJECT_API_VERSION = process.env.OPENPROJECT_API_VERSION || "v3"; // Default to v3 if not set

// Check if essential variables are defined
if (!OPENPROJECT_API_KEY || !OPENPROJECT_URL) {
  console.error("FATAL: Missing OpenProject environment variables (OPENPROJECT_API_KEY, OPENPROJECT_URL)");
  // Optionally, you could throw an error here to prevent the server from starting incorrectly
  // For a serverless function, this might mean it fails on invocation if not caught earlier.
}

const openProjectApi = axios.create({
  baseURL: `${OPENPROJECT_URL}/api/${OPENPROJECT_API_VERSION}`,
  headers: {
    // Ensure OPENPROJECT_API_KEY is a string before using it in Buffer.from
    'Authorization': `Basic ${Buffer.from(`apikey:${OPENPROJECT_API_KEY || ""}`).toString('base64')}`,
    'Content-Type': 'application/json'
  }
});

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
        // Wait for the specified interval
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

  server.tool(
    "openproject-create-project",
    "Creates a new project in OpenProject",
    {
      name: z.string().describe("Name of the project"),
      identifier: z.string().describe("Identifier of the project (unique)"),
      description: z.string().optional().describe("Optional description for the project"),
    },
    async ({ name, identifier, description }): Promise<CallToolResult> => {
      try {
        const response = await openProjectApi.post('/projects', {
          name,
          identifier,
          description: description || "", // Ensure description is a string
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
        console.error("Error creating OpenProject project:", error.response?.data || error.message);
        // It's good practice to return a structured error that the MCP client can understand
        const errorData = error.response?.data || { message: error.message };
        return {
          // Error content should ideally be in a format the client expects for errors
          // For now, returning it as text. Consider a more structured error object.
          content: [
            {
              type: "text",
              text: `Error creating project: ${JSON.stringify(errorData)}`,
            },
          ],
          // You might also want to throw a JSONRPCError if the SDK/transport supports it well
          // This requires the error to be caught and transformed by the transport layer
          // or handled in a way that it becomes a JSONRPCError response.
          // For simplicity, we're returning an error message in the content.
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
      // Add other relevant fields like assignee, status, priority as needed
    },
    async ({ projectId, subject, description, type }): Promise<CallToolResult> => {
      try {
        // First, ensure the project exists or get its numerical ID if an identifier is passed
        // For simplicity, this example assumes projectId is the numerical ID.
        // A more robust implementation would look up the project by identifier if it's not a number.

        const response = await openProjectApi.post(`/projects/${projectId}/work_packages`, {
          subject,
          description: { raw: description || "" }, // OpenProject expects description in a specific format
          _links: {
            type: {
              href: type
            },
            project: {
              href: `/api/v3/projects/${projectId}`
            }
            // Add other links like assignee, status, priority here
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
        console.error("Error creating OpenProject task:", error.response?.data || error.message);
        const errorData = error.response?.data || { message: error.message };
        return {
          content: [
            {
              type: "text",
              text: `Error creating task: ${JSON.stringify(errorData)}`,
            },
          ],
        };
      }
    }
  );

  // --- OpenProject Tools (Continued) ---

  server.tool(
    "openproject-get-project",
    "Gets a specific project by its ID from OpenProject",
    {
      projectId: z.string().describe("The ID of the project to retrieve"),
    },
    async ({ projectId }): Promise<CallToolResult> => {
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
        console.error("Error getting OpenProject project:", error.response?.data || error.message);
        const errorData = error.response?.data || { message: error.message };
        return {
          content: [
            {
              type: "text",
              text: `Error getting project: ${JSON.stringify(errorData)}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "openproject-list-projects",
    "Lists all projects in OpenProject",
    { // No parameters for now, could add pagination/filters later
      pageSize: z.number().optional().describe("Number of projects per page"),
      offset: z.number().optional().describe("Page number to retrieve (1-indexed)")
    },
    async ({ pageSize, offset }): Promise<CallToolResult> => {
      try {
        const params: any = {};
        if (pageSize) params.pageSize = pageSize;
        if (offset) params.offset = offset; // OpenProject API uses offset for page number

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
        console.error("Error listing OpenProject projects:", error.response?.data || error.message);
        const errorData = error.response?.data || { message: error.message };
        return {
          content: [
            {
              type: "text",
              text: `Error listing projects: ${JSON.stringify(errorData)}`,
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
    async ({ taskId }): Promise<CallToolResult> => {
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
        console.error("Error getting OpenProject task:", error.response?.data || error.message);
        const errorData = error.response?.data || { message: error.message };
        return {
          content: [
            {
              type: "text",
              text: `Error getting task: ${JSON.stringify(errorData)}`,
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
      // We could add more filters like status, type, assignee later
    },
    async ({ projectId, pageSize, offset }): Promise<CallToolResult> => {
      try {
        let url = '/work_packages';
        const params: any = {};
        if (pageSize) params.pageSize = pageSize;
        if (offset) params.offset = offset;

        if (projectId) {
          // If projectId is provided, OpenProject expects filters in a specific JSON format for GET requests
          // This typically involves a 'filters' parameter with a JSON string.
          // Example: filters=[{"status":{"operator":"o","values":[]}}]
          // For filtering by project, the endpoint /projects/{projectId}/work_packages is simpler.
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
        console.error("Error listing OpenProject tasks:", error.response?.data || error.message);
        const errorData = error.response?.data || { message: error.message };
        return {
          content: [
            {
              type: "text",
              text: `Error listing tasks: ${JSON.stringify(errorData)}`,
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
      // Add other updatable fields as optional parameters here
    },
    async (params): Promise<CallToolResult> => {
      const { projectId, ...updatePayload } = params;
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
        // OpenProject API for project update might require a lockVersion if changes are frequent
        // For simplicity, we are not fetching it first. If conflicts occur, this might need adjustment.
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
        console.error("Error updating OpenProject project:", error.response?.data || error.message);
        const errorData = error.response?.data || { message: error.message };
        return {
          content: [
            {
              type: "text",
              text: `Error updating project: ${JSON.stringify(errorData)}`,
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
      // Potentially add other updatable fields like type, status, assignee, parent, dates etc.
      // For linked resources like type or status, you'd send: _links: { type: { href: "/api/v3/types/ID" } }
    },
    async (params): Promise<CallToolResult> => {
      const { taskId, lockVersion, description, ...otherFields } = params;
      
      const updatePayload: any = { lockVersion, ...otherFields };

      if (description !== undefined) {
        updatePayload.description = { raw: description }; // OpenProject expects description in a specific format
      }

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
        console.error("Error updating OpenProject task:", error.response?.data || error.message);
        const errorData = error.response?.data || { message: error.message };
        return {
          content: [
            {
              type: "text",
              text: `Error updating task: ${JSON.stringify(errorData)}`,
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
    async ({ projectId }): Promise<CallToolResult> => {
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
        console.error("Error deleting OpenProject project:", error.response?.data || error.message);
        const errorData = error.response?.data || { message: error.message };
        // Check if the error is a 404, meaning the project was already deleted or never existed
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
              text: `Error deleting project: ${JSON.stringify(errorData)}`,
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
    async ({ taskId }): Promise<CallToolResult> => {
      try {
        // Note: Deleting tasks in OpenProject might require a lockVersion or specific permissions.
        // The API typically returns a 204 No Content on successful deletion.
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
        console.error("Error deleting OpenProject task:", error.response?.data || error.message);
        const errorData = error.response?.data || { message: error.message };
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
              text: `Error deleting task: ${JSON.stringify(errorData)}`,
            },
          ],
        };
      }
    }
  );

  return server;
};
