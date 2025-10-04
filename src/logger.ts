import pino from "pino";

const level = process.env.LOG_LEVEL || "info";

/**
 * Cast to any to avoid TypeScript callable signature issues with different ESM/CommonJS interop.
 * This keeps runtime behaviour (pino factory call) while silencing the TS error.
 */
export const logger = (pino as any)({
  level,
  transport:
    process.env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});
