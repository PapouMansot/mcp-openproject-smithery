![Netlify Examples](https://github.com/netlify/examples/assets/5865/4145aa2f-b915-404f-af02-deacee24f7bf)

# MCP Server for OpenProject with Netlify Express

**View the deployed MCP function endpoint:** https://gilded-fudge-69ca2e.netlify.app/mcp (Note: This endpoint is intended for MCP clients, not direct browser access).

[![Netlify Status](https://api.netlify.com/api/v1/badges/f15f03f9-55d8-4adc-97d5-f6e085141610/deploy-status)](https://app.netlify.com/sites/mcp-example-express/deploys)

## About this MCP Server

This project provides a Model Context Protocol (MCP) server, built with Express and deployed as a Netlify Function. It allows AI agents (like Langflow agents, Claude, Cursor, etc.) to interact with a self-hosted OpenProject instance via defined tools.

This example demonstrates:
- Setting up an MCP server using `@modelcontextprotocol/sdk`.
- Integrating with an external API (OpenProject).
- Deploying the MCP server serverlessly using Netlify Functions.
- Handling environment variables securely in Netlify.
- Providing a bridge for remote SSE clients (like cloud-hosted Langflow) to connect to the stateless Netlify function via `mcp-proxy` and `ngrok`.

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- [Docs: Netlify Functions](https://docs.netlify.com/functions/overview/?utm_campaign=dx-examples&utm_source=example-site&utm_medium=web&utm_content=example-mcp-express)

## Implemented OpenProject Tools

The server exposes the following tools for interacting with OpenProject:

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

*   Node.js (v18 or later recommended)
*   npm
*   Netlify CLI (`npm install -g netlify-cli`)
*   Python 3.10 or later (required for the `mcp-proxy` tool used for SSE bridging)
*   `pip` (Python package installer)
*   An OpenProject instance accessible via URL.
*   An OpenProject API Key.
*   (Optional) `ngrok` account and CLI for testing remote SSE clients.

## Setup Instructions

1.  **Clone the repository:**
    ```bash
    git clone git@github.com:jessebautista/mcp-openproject.git
    cd mcp-openproject
    ```

2.  **Install Node.js dependencies:**
    ```bash
    npm install
    ```

3.  **Install Python `mcp-proxy`:**
    *(Ensure you have Python 3.10+ active)*
    ```bash
    # Check your python version first if needed: python3 --version
    # Install mcp-proxy (using pip associated with Python 3.10+):
    python3.10 -m pip install mcp-proxy
    # Or python3.11, python3.12 etc. depending on your version
    # If pipx is installed and preferred: pipx install mcp-proxy
    ```

## Local Development

1.  **Create Environment File:**
    *   Create a file named `.env` in the project root.
    *   Add your OpenProject details:
      ```dotenv
      OPENPROJECT_API_KEY="your_openproject_api_key_here"
      OPENPROJECT_URL="https://your_openproject_instance.com"
      OPENPROJECT_API_VERSION="v3"
      ```
    *   **(Important):** Ensure `.env` is listed in your `.gitignore` file to avoid committing secrets.

2.  **Run Netlify Dev Server:**
    *   This command starts a local server, loads variables from `.env`, and makes your function available.
    ```bash
    netlify dev
    ```
    *   Your local MCP endpoint will typically be available at `http://localhost:8888/mcp`.

3.  **Test Locally with MCP Inspector:**
    *   In a **separate terminal**, run the MCP Inspector, pointing it to your local server via `mcp-remote`:
      ```bash
      npx @modelcontextprotocol/inspector npx mcp-remote@next http://localhost:8888/mcp
      ```
    *   Open the Inspector URL (usually `http://localhost:6274`) in your browser.
    *   Connect and use the "Tools" tab to test the OpenProject CRUD operations.

## Deployment to Netlify

1.  **Set Environment Variables in Netlify UI:**
    *   Go to your site's dashboard on Netlify (`https://app.netlify.com/sites/gilded-fudge-69ca2e/configuration/env`).
    *   Under "Environment variables", add the following variables (ensure they are available to "Functions"):
        *   `OPENPROJECT_API_KEY`: Your OpenProject API key.
        *   `OPENPROJECT_URL`: Your OpenProject instance URL (e.g., `https://project.bautistavirtualrockstars.com`).
        *   `OPENPROJECT_API_VERSION`: `v3`
    *   **(Security):** The code in `netlify/mcp-server/index.ts` reads these from `process.env`. The hardcoded values should be removed (already done in our steps).

2.  **Deploy via Git:**
    *   Commit your code changes:
      ```bash
      git add .
      git commit -m "Deploy OpenProject MCP server updates"
      ```
    *   Push to the branch Netlify is configured to deploy (e.g., `main`):
      ```bash
      git push origin main
      ```
    *   Netlify will automatically build and deploy the new version. Monitor progress in the "Deploys" section of your Netlify dashboard.

## Testing Deployed Version

1.  **Using MCP Inspector:**
    *   Run the inspector, pointing `mcp-remote` to your live Netlify function URL:
      ```bash
      npx @modelcontextprotocol/inspector npx mcp-remote@next https://gilded-fudge-69ca2e.netlify.app/mcp
      ```
    *   Open the Inspector URL and test the tools. Check Netlify function logs if errors occur.

2.  **Connecting Remote SSE Clients (e.g., Cloud-Hosted Langflow):**
    *   Since the Netlify function is stateless (doesn't handle SSE connections directly via GET), and remote clients like Langflow often prefer SSE, you need a bridge. We use the Python `mcp-proxy` tool combined with the JS `mcp-remote` tool, and `ngrok` for a public tunnel.

    *   **Step A: Start the Proxy Bridge Locally:**
        *   Run this command in a terminal on your local machine (ensure Python 3.10+ is active and `mcp-proxy` is installed):
          ```bash
          # Listen for SSE on local port 7865, run npx mcp-remote as the backend
          mcp-proxy --sse-port 7865 -- npx mcp-remote@next https://gilded-fudge-69ca2e.netlify.app/mcp
          ```
        *   Keep this terminal running. Check its output to ensure it started listening and spawned the `npx` command.

    *   **Step B: Create a Public Tunnel with `ngrok`:**
        *   In a **separate terminal**, run `ngrok` to expose the local port `mcp-proxy` is listening on:
          ```bash
          ngrok http 7865
          ```
        *   `ngrok` will display a public "Forwarding" URL (e.g., `https://<random-string>.ngrok-free.app`). Copy this HTTPS URL.

    *   **Step C: Configure Langflow:**
        *   In your Langflow MCP Connection component (running on `https://lang.singforhope.org/`):
            *   **Mode:** `SSE`
            *   **MCP SSE URL:** Paste the **full `ngrok` public URL** including the `/sse` path required by `mcp-proxy` (e.g., `https://<random-string>.ngrok-free.app/sse`).
        *   Langflow should now be able to connect and use the tools via the `ngrok` -> `mcp-proxy` -> `mcp-remote` -> Netlify chain.

    *   **(Note):** This `ngrok` setup is for testing/development. For a permanent solution, deploy the `mcp-proxy` bridge to a persistent public server.

## Netlify Function Configuration (`netlify.toml`)

Ensure your `netlify.toml` correctly redirects requests to the `/mcp` path to your Express function handler:

```toml
[[redirects]]
  force = true
  from = "/mcp/*" # Use wildcard to catch all sub-paths if needed
  status = 200
  to = "/.netlify/functions/express-mcp-server"

[[redirects]] # Also redirect the base path
  force = true
  from = "/mcp"
  status = 200
  to = "/.netlify/functions/express-mcp-server"
```
*(Adjust redirects as needed based on your Express routing)*


