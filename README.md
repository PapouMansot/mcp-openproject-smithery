[![smithery badge](https://smithery.ai/badge/@jessebautista/mcp-openproject-smithery)](https://smithery.ai/server/@jessebautista/mcp-openproject-smithery)

# MCP Server for OpenProject (Smithery Edition)

This project provides a Model Context Protocol (MCP) server for OpenProject, designed for deployment and use with [Smithery](https://smithery.ai/). It exposes a set of tools for interacting with a self-hosted OpenProject instance, and is compatible with Smithery's HTTP transport and tool listing requirements.

## About this MCP Server

- Built with TypeScript and Node.js using the [@modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk).
- Exposes OpenProject CRUD tools for projects and tasks (work packages).
- Designed for easy deployment to Smithery, with Docker support and a minimal, production-ready structure.
- Supports local development and testing with MCP Inspector and Smithery tools.

## Implemented OpenProject Tools

*   **Projects:**
    *   `openproject-create-project`: Creates a new project.
    *   `openproject-get-project`: Retrieves a specific project by ID.
    *   `openproject-list-projects`: Lists all projects (supports pagination).
    *   `openproject-update-project`: Updates an existing project's details.
    *   `openproject-delete-project`: Deletes a project.
*   **Tasks (Work Packages):**
    *   `openproject-create-task`: Creates a new task within a project.
    *   `openproject-get-task`: Retrieves a specific task by ID.
    *   `openproject-list-tasks`: Lists tasks, optionally filtered by project ID (supports pagination).
    *   `openproject-update-task`: Updates an existing task (requires `lockVersion`).
    *   `openproject-delete-task`: Deletes a task.

## Prerequisites

* Node.js (v18 or later recommended)
* npm
* An OpenProject instance accessible via URL
* An OpenProject API Key
* (Optional) Docker for containerized builds

## HTTP Entrypoint and Local Development

This MCP server now uses Express and the official MCP Streamable HTTP transport. The server is accessible at `http://localhost:8000/mcp` after running `npm run dev` or `npm start`.

**Entrypoint code (see `src/index.ts`):**

```typescript
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json());

const mcpServer = setupMCPServer();
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
mcpServer.connect(transport);

app.all("/mcp", (req, res) => {
  transport.handleRequest(req, res, req.body);
});

app.get("/", (_req, res) => res.send("MCP OpenProject server is running!"));

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`MCP server running on port ${PORT}`);
});
```

- The `/mcp` endpoint is the main MCP HTTP endpoint for Smithery and MCP clients.
- The root `/` endpoint is a health check.

## Running Locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the project:
   ```bash
   npm run build
   ```
3. Start the server (dev mode):
   ```bash
   npm run dev
   # or for production
   npm start
   ```
4. Access the MCP endpoint at [http://localhost:8000/mcp](http://localhost:8000/mcp)

## Docker Usage

Build and run as before:
```bash
docker build -t mcp-openproject-smithery .
docker run --rm -p 8000:8000 --env-file .env mcp-openproject-smithery
```

## Smithery Deployment

This project is ready for Smithery. The `/mcp` endpoint is compatible with Smithery's HTTP transport requirements.

See your live Smithery server here:
[![smithery badge](https://smithery.ai/badge/@jessebautista/mcp-openproject-smithery)](https://smithery.ai/server/@jessebautista/mcp-openproject-smithery)

## Local Testing with MCP Inspector

You can test your MCP server locally using the [MCP Inspector](https://www.npmjs.com/package/@modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector npx mcp-remote@next http://localhost:8000/mcp
```

Open the Inspector URL (usually `http://localhost:6274`) in your browser to interact with your tools.

## Project Structure

- `src/index.ts` — Main MCP server logic
- `smithery.yaml` — Smithery server configuration
- `Dockerfile` — Production-ready Docker build
- `tsconfig.json` — TypeScript configuration
- `package.json` — Project dependencies and scripts

## License

MIT

---

This project is maintained for use with Smithery and the Model Context Protocol. For more information, see:
- [Smithery Documentation](https://smithery.ai/docs)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [TypeScript SDK for MCP](https://github.com/modelcontextprotocol/typescript-sdk)


