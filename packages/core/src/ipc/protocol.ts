// JSON-RPC 2.0 protocol types + small helpers.
// Reference: https://www.jsonrpc.org/specification
//
// Hand-rolled (no jayson / json-rpc-2.0 dep): the spec is ~100 lines and we
// don't need the surface the libraries provide (HTTP transports, batch
// semantics beyond what we use, server-side reflection, etc.). Same posture
// as the worker Endpoint in src/plugins/protocol.ts.
//
// Wire format: newline-delimited JSON. Each message is a complete JSON object
// terminated by '\n'. The IPC server reads from a Unix stream socket; this
// module is transport-agnostic and just deals with messages.
//
// Server-pushed events (subscriptions) are NOT in the JSON-RPC 2.0 spec; we
// layer a documented convention on top:
//   method: "event"
//   params: { subscription: string, name: string, payload: unknown }
// Notifications are id-less per the spec, so this fits naturally.

// Standardized error codes from the spec (Errors section, table 5.1).
export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // -32000 .. -32099 are reserved for implementation-defined server errors.
  // We use a few documented ones below.
  ACTION_FAILED: -32000,
  SUBSCRIPTION_UNKNOWN: -32001,
} as const;

// JSON values (the wire payload is JSON, not structured-clone; no bigint).
export type Json =
  | null | boolean | number | string
  | Json[] | { [k: string]: Json };

// A request or notification has a method + optional params. Per spec, an id
// MUST be present on a request and MUST be absent on a notification.
export interface Request {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Json;
}

export interface Notification {
  jsonrpc: "2.0";
  method: string;
  params?: Json;
}

// A response has the same id as the request. Either `result` OR `error`,
// never both.
export interface SuccessResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result: Json;
}

export interface ErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: Json };
}

export type Response = SuccessResponse | ErrorResponse;

export type Message = Request | Notification | Response;

// Parse a single JSON-RPC message from a string. Throws TypeError on parse
// failures (caller maps to a Parse Error response). Returns the message; the
// caller is responsible for further validation (e.g. distinguishing request
// vs notification vs response by id presence).
export function parseMessage(text: string): unknown {
  return JSON.parse(text);
}

// True if `m` is a request (jsonrpc 2.0 + method string + id present + params
// is JSON or absent). Notifications are NOT requests for our purposes (we
// drop them with a separate predicate); the IPC server only invokes request
// handlers when this returns true.
export function isRequest(m: unknown): m is Request {
  if (!isJsonRpcShape(m)) return false;
  const o = m as { [k: string]: unknown };
  if (typeof o.method !== "string" || o.method.length === 0) return false;
  if (!(typeof o.id === "number" || typeof o.id === "string")) return false;
  // params is optional; when present must be a JSON value (array or object per
  // spec, but we accept any JSON value -- clients sometimes pass scalars).
  return true;
}

function isJsonRpcShape(m: unknown): m is { [k: string]: unknown } {
  return typeof m === "object" && m !== null && !Array.isArray(m)
    && (m as { jsonrpc?: unknown }).jsonrpc === "2.0";
}

// Build a success response.
export function ok(id: number | string | null, result: Json): SuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

// Build an error response.
export function err(
  id: number | string | null, code: number, message: string, data?: Json,
): ErrorResponse {
  const e: ErrorResponse["error"] = { code, message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: "2.0", id, error: e };
}

// Build a notification (server -> client one-way; used for `event`
// notifications carrying subscription deliveries).
export function notify(method: string, params: Json): Notification {
  return { jsonrpc: "2.0", method, params };
}

// Serialize a message to the wire (newline-delimited JSON).
export function encode(m: Message): string {
  return JSON.stringify(m) + "\n";
}
