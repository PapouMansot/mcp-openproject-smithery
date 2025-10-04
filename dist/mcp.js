import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withOpenProject, isNotFoundError, } from "./helpers.js";
import { logger } from "./logger.js";
export const setupMCPServer = () => {
    const server = new McpServer({
        name: "stateless-server",
        version: "1.0.0",
    }, { capabilities: { logging: {} } });
    // Prompt template
    server.prompt("greeting-template", "A simple greeting prompt template", {
        name: z.string().describe("Name to include in greeting"),
    }, async ({ name }) => {
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
    });
    // Notification stream test tool
    server.tool("start-notification-stream", "Starts sending periodic notifications for testing resumability", {
        interval: z
            .number()
            .describe("Interval in milliseconds between notifications")
            .default(100),
        count: z
            .number()
            .describe("Number of notifications to send (0 for 100)")
            .default(10),
    }, async ({ interval, count }, { sendNotification }) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
            }
            catch (error) {
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
    });
    // Greeting resource
    server.resource("greeting-resource", "https://example.com/greetings/default", { mimeType: "text/plain" }, async () => {
        return {
            contents: [
                {
                    uri: "https://example.com/greetings/default",
                    text: "Hello, world!",
                },
            ],
        };
    });
    // --- OpenProject tools (use withOpenProject to remove repetition) ---
    server.tool("openproject-list-users", "Lists all users in OpenProject", {
        pageSize: z.number().optional(),
        offset: z.number().optional(),
    }, withOpenProject(async (api, params) => {
        const response = await api.get("/users", { params });
        return {
            content: [
                { type: "text", text: `Found ${response.data.count} users` },
                { type: "text", text: JSON.stringify(response.data) },
            ],
        };
    }));
    server.tool("openproject-create-project", "Creates a new project in OpenProject", {
        name: z.string().describe("Name of the project"),
        identifier: z.string().describe("Identifier of the project (unique)"),
        description: z.string().optional().describe("Optional description for the project"),
    }, withOpenProject(async (api, params) => {
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
    }));
    server.tool("openproject-create-task", "Creates a new task (work package) in an OpenProject project", {
        projectId: z.string().describe("The ID or identifier of the project to add the task to"),
        subject: z.string().describe("Subject/title of the task"),
        description: z.string().optional().describe("Optional description for the task"),
        type: z.string().default("/api/v3/types/1").describe("Type of the work package (e.g., /api/v3/types/1 for Task)"),
    }, withOpenProject(async (api, params) => {
        const { projectId, subject, description, type } = params;
        const response = await api.post(`/projects/${projectId}/work_packages`, {
            subject,
            description: { raw: description || "" },
            _links: {
                type: { href: type },
                project: { href: `/api/v3/projects/${projectId}` },
            },
        });
        return {
            content: [
                {
                    type: "text",
                    text: `Successfully created task: ${response.data.subject} (ID: ${response.data.id}) in project ${projectId}`,
                },
                { type: "text", text: JSON.stringify(response.data) },
            ],
        };
    }));
    server.tool("openproject-get-project", "Gets a specific project by its ID from OpenProject", {
        projectId: z.string().describe("The ID of the project to retrieve"),
    }, withOpenProject(async (api, params) => {
        const { projectId } = params;
        const response = await api.get(`/projects/${projectId}`);
        return {
            content: [
                { type: "text", text: `Successfully retrieved project: ${response.data.name}` },
                { type: "text", text: JSON.stringify(response.data) },
            ],
        };
    }));
    server.tool("openproject-list-projects", "Lists all projects in OpenProject", {
        pageSize: z.number().optional().describe("Number of projects per page"),
        offset: z.number().optional().describe("Page number to retrieve (1-indexed)"),
    }, withOpenProject(async (api, params) => {
        const { pageSize, offset } = params;
        const qparams = {};
        if (pageSize)
            qparams.pageSize = pageSize;
        if (offset)
            qparams.offset = offset;
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
    }));
    server.tool("openproject-get-task", "Gets a specific task (work package) by its ID from OpenProject", {
        taskId: z.string().describe("The ID of the task to retrieve"),
    }, withOpenProject(async (api, params) => {
        const { taskId } = params;
        const response = await api.get(`/work_packages/${taskId}`);
        return {
            content: [
                { type: "text", text: `Successfully retrieved task: ${response.data.subject}` },
                { type: "text", text: JSON.stringify(response.data) },
            ],
        };
    }));
    server.tool("openproject-list-tasks", "Lists tasks (work packages) in OpenProject, optionally filtered by project ID", {
        projectId: z.string().optional().describe("Optional ID of the project to filter tasks by"),
        pageSize: z.number().optional().describe("Number of tasks per page"),
        offset: z.number().optional().describe("Page number to retrieve (1-indexed)"),
    }, withOpenProject(async (api, params) => {
        const { projectId, pageSize, offset } = params;
        let url = "/work_packages";
        const qparams = {};
        if (pageSize)
            qparams.pageSize = pageSize;
        if (offset)
            qparams.offset = offset;
        if (projectId)
            url = `/projects/${projectId}/work_packages`;
        const response = await api.get(url, { params: qparams });
        const count = response.data?._embedded?.elements?.length ?? 0;
        const total = response.data?.total ?? "unknown";
        return {
            content: [
                { type: "text", text: `Successfully retrieved ${count} tasks (Total: ${total})` },
                { type: "text", text: JSON.stringify(response.data) },
            ],
        };
    }));
    server.tool("openproject-update-project", "Updates an existing project in OpenProject. Only include fields to be changed.", {
        projectId: z.string().describe("The ID of the project to update"),
        name: z.string().optional().describe("New name for the project"),
        description: z.string().optional().describe("New description for the project"),
    }, withOpenProject(async (api, params) => {
        const { projectId, name, description } = params;
        const updatePayload = {};
        if (name)
            updatePayload.name = name;
        if (description)
            updatePayload.description = description;
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
    }));
    server.tool("openproject-update-task", "Updates an existing task (work package) in OpenProject. Only include fields to be changed.", {
        taskId: z.string().describe("The ID of the task to update"),
        lockVersion: z.number().describe("The lockVersion of the task (obtained from a GET request)"),
        subject: z.string().optional().describe("New subject/title for the task"),
        description: z.string().optional().describe("New description for the task (provide as raw text)"),
    }, withOpenProject(async (api, params) => {
        const { taskId, lockVersion, subject, description } = params;
        const updatePayload = { lockVersion };
        if (subject)
            updatePayload.subject = subject;
        if (description)
            updatePayload.description = { raw: description };
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
    }));
    server.tool("openproject-delete-project", "Deletes a project from OpenProject. This action is irreversible.", {
        projectId: z.string().describe("The ID of the project to delete"),
    }, withOpenProject(async (api, params) => {
        const { projectId } = params;
        try {
            await api.delete(`/projects/${projectId}`);
            return {
                content: [{ type: "text", text: `Successfully deleted project with ID: ${projectId}` }],
            };
        }
        catch (error) {
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
    }));
    server.tool("openproject-delete-task", "Deletes a task (work package) from OpenProject. This action is irreversible.", {
        taskId: z.string().describe("The ID of the task to delete"),
    }, withOpenProject(async (api, params) => {
        const { taskId } = params;
        try {
            await api.delete(`/work_packages/${taskId}`);
            return {
                content: [{ type: "text", text: `Successfully deleted task with ID: ${taskId}` }],
            };
        }
        catch (error) {
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
    }));
    logger.info("MCP server configured with OpenProject tools");
    return server;
};
