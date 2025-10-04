import axios, { AxiosInstance } from "axios";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";

export type OpenProjectConfig = {
  OPENPROJECT_API_KEY?: string;
  OPENPROJECT_URL?: string;
  OPENPROJECT_API_VERSION?: string;
};

export type ToolContext = RequestHandlerExtra<ServerRequest, ServerNotification> & {
  config?: OpenProjectConfig;
};

export const missingConfigMessage =
  "OpenProject configuration is missing. Please provide OPENPROJECT_API_KEY and OPENPROJECT_URL.";

export const missingConfigResult: CallToolResult = {
  content: [
    {
      type: "text",
      text: missingConfigMessage,
    },
  ],
};

/**
 * Safe stringify for unknown values used when building readable error messages.
 */
export const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * Extract a human-friendly message from an unknown error (including axios errors).
 */
export const getErrorMessage = (error: unknown): string => {
  // axios may be present at runtime; guard against import mismatch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axiosLike: any = axios;
  if (axiosLike && axiosLike.isAxiosError && axiosLike.isAxiosError(error)) {
    const data = (error as any).response?.data;
    if (data !== undefined) {
      return safeStringify(data);
    }
    return (error as any).message || safeStringify(error);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

/**
 * Detect 404 from axios-like errors.
 */
export const isNotFoundError = (error: unknown): boolean =>
  axios.isAxiosError(error) && error.response?.status === 404;

/**
 * Create an axios instance configured for OpenProject.
 * This function never throws; it returns null when required config is missing.
 */
export function getOpenProjectApi(config?: OpenProjectConfig): AxiosInstance | null {
  const OPENPROJECT_API_KEY = config?.OPENPROJECT_API_KEY || process.env.OPENPROJECT_API_KEY;
  const OPENPROJECT_URL = config?.OPENPROJECT_URL || process.env.OPENPROJECT_URL;
  const OPENPROJECT_API_VERSION =
    config?.OPENPROJECT_API_VERSION || process.env.OPENPROJECT_API_VERSION || "v3";

  if (!OPENPROJECT_API_KEY || !OPENPROJECT_URL) {
    return null;
  }

  const instance = axios.create({
    baseURL: `${OPENPROJECT_URL.replace(/\/$/, "")}/api/${OPENPROJECT_API_VERSION}`,
    timeout: 10_000,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`apikey:${OPENPROJECT_API_KEY}`).toString("base64")}`,
    },
  });

  return instance;
}

/**
 * Wrapper helper to reduce repetition when implementing OpenProject-backed tools.
 * It returns a function compatible with server.tool handler signature: (params, context) => Promise<CallToolResult>
 *
 * Usage:
 * server.tool("my-tool", "desc", schema, withOpenProject(async (api, params) => {
 *   const resp = await api.get('/projects');
 *   return { content: [...] };
 * }));
 */
export const withOpenProject =
  (
    handler: (api: AxiosInstance, params: any, context?: ToolContext) => Promise<CallToolResult>,
    options?: { allowMissingConfig?: boolean }
  ) =>
  async (params: any, context?: ToolContext): Promise<CallToolResult> => {
    const openProjectApi = getOpenProjectApi(context?.config);
    if (!openProjectApi) {
      if (options?.allowMissingConfig) {
        // let handler decide what to do
        return handler(null as unknown as AxiosInstance, params, context);
      }
      return missingConfigResult;
    }

    try {
      return await handler(openProjectApi, params, context);
    } catch (error: unknown) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${getErrorMessage(error)}`,
          },
        ],
      };
    }
  };
