import axios, { AxiosInstance } from "axios";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import http from "http";
import https from "https";

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
 * Simple in-memory counters/metrics (Prometheus-like simple counters).
 */
export const metrics = {
  calls: 0,
  errors: 0,
  retries: 0,
  latencies: [] as number[],
  inc(callName: keyof typeof metrics) {
    // @ts-ignore
    this[callName] = (this[callName] || 0) + 1;
  },
} as unknown as {
  calls: number;
  errors: number;
  retries: number;
  latencies: number[];
  inc: (k: "calls" | "errors" | "retries") => void;
};

/**
 * Safe stringify for unknown values used when building readable error messages.
 * Also redacts Authorization header and obvious secrets from objects before stringifying.
 */
const redact = (value: unknown): unknown => {
  if (value == null) return value;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return value;
  try {
    const cloned: any = Array.isArray(value) ? [...(value as any)] : { ...(value as any) };
    const walk = (obj: any) => {
      if (!obj || typeof obj !== "object") return;
      if (obj.headers && typeof obj.headers === "object") {
        if ("authorization" in obj.headers) obj.headers.authorization = "[REDACTED]";
        if ("Authorization" in obj.headers) obj.headers.Authorization = "[REDACTED]";
        if ("set-cookie" in obj.headers) obj.headers["set-cookie"] = "[REDACTED]";
      }
      if ("config" in obj && typeof obj.config === "object") {
        if ("baseURL" in obj.config) obj.config.baseURL = "[REDACTED]";
        if ("url" in obj.config) obj.config.url = "[REDACTED]";
        if (obj.config.headers) {
          if ("authorization" in obj.config.headers) obj.config.headers.authorization = "[REDACTED]";
          if ("Authorization" in obj.config.headers) obj.config.headers.Authorization = "[REDACTED]";
        }
      }
      // remove common secret keys
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === "string" && /token|secret|apikey|api_key/i.test(k)) {
          obj[k] = "[REDACTED]";
        } else if (typeof obj[k] === "object") {
          walk(obj[k]);
        }
      }
    };
    walk(cloned);
    return cloned;
  } catch {
    return "[UNSERIALIZABLE]";
  }
};

export const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(redact(value));
  } catch {
    return String(value);
  }
};

/**
 * Extract a human-friendly message from an unknown error (including axios errors).
 * Ensures sensitive fields like Authorization and baseURL are redacted.
 */
export const getErrorMessage = (error: unknown): string => {
  // axios may be present at runtime; guard against import mismatch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axiosLike: any = axios;
  if (axiosLike && axiosLike.isAxiosError && axiosLike.isAxiosError(error)) {
    const resp = (error as any).response;
    if (resp !== undefined && resp.data !== undefined) {
      return safeStringify(resp.data);
    }
    // fallback to error message but redact config
    const cfg = (error as any).config ? redact((error as any).config) : null;
    const message = (error as any).message || safeStringify(error);
    return `${message}${cfg ? " - " + safeStringify(cfg) : ""}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
};

/**
 * Detect 404 from axios-like errors.
 */
export const isNotFoundError = (error: unknown): boolean =>
  axios.isAxiosError(error) && error.response?.status === 404;

/**
 * Simple pagination helper (1-indexed pages).
 */
export function paginateList(arr: any[], offset = 1, pageSize = 25) {
  const start = (offset - 1) * pageSize;
  const slice = arr.slice(start, start + pageSize);
  return { items: slice, nextOffset: start + slice.length < arr.length ? offset + 1 : null };
}

/**
 * Truncate an array safely and expose nextOffset for agent-friendly pagination.
 */
export function safeTruncate<T>(arr: T[], offset = 1, pageSize = 25) {
  return paginateList(arr, offset, pageSize);
}

/**
 * Zod schemas for common parameters.
 */
export const pageSizeSchema = z.number().int().positive().max(100).default(25);
export const offsetSchema = z.number().int().positive().default(1);

/**
 * ETag cache to avoid re-fetching unchanged lists.
 */
const etagCache = new Map<string, { etag: string; data: any }>();

/**
 * Create an axios instance configured for OpenProject with sensible defaults:
 * - timeout 15s
 * - gzip Accept-Encoding
 * - User-Agent 'mcp-openproject/1.0'
 * - HTTP keep-alive agents
 * - retry interceptor for 429/5xx with exponential backoff
 *
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

  const baseURL = `${OPENPROJECT_URL.replace(/\/$/, "")}/api/${OPENPROJECT_API_VERSION}`;

  const instance = axios.create({
    baseURL,
    timeout: 15_000,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`apikey:${OPENPROJECT_API_KEY}`).toString("base64")}`,
      "Accept-Encoding": "gzip, deflate",
      "User-Agent": "mcp-openproject/1.0",
    },
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
  });

  // Request interceptor: attach If-None-Match when we have a cached ETag for GETs
  instance.interceptors.request.use((req) => {
    try {
      metrics.inc("calls");
      if (req && req.method && req.method.toLowerCase() === "get") {
        const key = `${req.baseURL || ""}${req.url || ""}`;
        const cached = etagCache.get(key);
        if (cached?.etag) {
          req.headers = req.headers || {};
          // only set If-None-Match when we have one
          req.headers["If-None-Match"] = cached.etag;
        }
      }
    } catch {
      // ignore metrics/etag errors
    }
    return req;
  });

  // Response + retry interceptor
  instance.interceptors.response.use(
    (response) => {
      try {
        // store ETag for GET responses
        if (response.config && response.config.method === "get" && response.headers?.etag) {
          const key = `${response.config.baseURL || ""}${response.config.url || ""}`;
          etagCache.set(key, { etag: response.headers.etag, data: response.data });
        }
        // Handle 304 -> return cached body as fresh 200-like response
        if (response.status === 304) {
          const key = `${response.config.baseURL || ""}${response.config.url || ""}`;
          const cached = etagCache.get(key);
          if (cached) {
            return { ...response, status: 200, data: cached.data };
          }
        }
      } catch {
        // ignore cache errors
      }
      return response;
    },
    async (err) => {
      const config: any = err.config;
      metrics.inc("errors");
      if (!config) return Promise.reject(err);

      config.__retryCount = config.__retryCount || 0;
      const status = err.response?.status;

      // Retry on 429 or 5xx
      const shouldRetry = status === 429 || (status >= 500 && status < 600);
      const maxRetries = 4;
      if (shouldRetry && config.__retryCount < maxRetries) {
        config.__retryCount += 1;
        metrics.inc("retries");
        const delay = Math.pow(2, config.__retryCount) * 100 + Math.floor(Math.random() * 100);
        await new Promise((res) => setTimeout(res, delay));
        return instance.request(config);
      }

      return Promise.reject(err);
    }
  );

  return instance;
}

/**
 * Generic wrapper helper to reduce repetition when implementing OpenProject-backed tools.
 * It returns a function compatible with server.tool handler signature: (params, context) => Promise<CallToolResult>
 *
 * The wrapper centralizes error redaction and ensures returned errors are short and digestible:
 * Always returns content with a short "ERROR: ..." prefix. Does not leak tokens or base URLs.
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
      const short = getErrorMessage(error);
      return {
        content: [
          {
            type: "text",
            text: `ERROR: ${short}`,
          },
        ],
      };
    }
  };

/**
 * Resolve an element by name/title from a collection endpoint like /api/v3/statuses
 * Returns the element._links.self.href or null
 */
export async function resolveByName(api: AxiosInstance, path: string, name: string) {
  const r = await api.get(path);
  const el = (r.data?._embedded?.elements ?? []).find((e: any) => e.name === name || e.title === name);
  return el ? el._links?.self?.href : null;
}

/**
 * Guard an upload request: whitelist apiPath pattern, enforce size caps (base64 length)
 * and optional MIME checks. Returns null on success or a digestible error result.
 */
export function guardUpload(apiPath: string, contentBase64: string, contentType?: string) {
  // whitelist: /api/v3/(projects/:id|work_packages/:id)/attachments[?...] OR /api/v3/attachments/:id
  if (!/^\/api\/v3\/(projects\/\d+|work_packages\/\d+|attachments\/\d+)\/attachments?(\?.*)?$/.test(apiPath)) {
    return { content: [{ type: "text", text: "ERROR: invalid apiPath" }] };
  }
  // base64 overhead ~ 4/3 => to allow 20MB raw, check base64 length accordingly (slack factor 1.37)
  const maxBase64 = 20 * 1024 * 1024 * 1.37;
  if (contentBase64.length > maxBase64) {
    return { content: [{ type: "text", text: "ERROR: file too large (>20MB)" }] };
  }
  if (contentType) {
    const allowed = [
      /^application\/pdf$/,
      /^image\/.+$/,
      /^text\/.+$/,
      /^application\/octet-stream$/,
    ];
    if (!allowed.some((r) => r.test(contentType))) {
      return { content: [{ type: "text", text: "ERROR: unsupported contentType" }] };
    }
  }
  return null;
}

/**
 * Compute optional SHA256 checksum (hex) of Buffer data. Returns hex string.
 */
export function sha256Hex(buffer: Buffer) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Apply a PATCH with automatic 409 lockVersion recovery:
 * - If PATCH returns 409 and response includes lockVersion mismatch, GET the resource,
 *   set payload.lockVersion to latest and retry once.
 * - Returns the final axios response or throws the error.
 */
export async function patchWithConflictRetry(
  api: AxiosInstance,
  getUrl: string,
  patchUrl: string,
  payload: any,
  config?: any
) {
  try {
    return await api.patch(patchUrl, payload, config);
  } catch (err: any) {
    if (err?.response?.status === 409) {
      // try to recover: GET resource to obtain lockVersion
      try {
        const current = await api.get(getUrl);
        const latestLock = current.data?.lockVersion;
        if (typeof latestLock === "number") {
          const newPayload = { ...payload, lockVersion: latestLock };
          return await api.patch(patchUrl, newPayload, config);
        }
      } catch (err2) {
        throw err; // rethrow original 409 if recovery fails
      }
    }
    throw err;
  }
}
