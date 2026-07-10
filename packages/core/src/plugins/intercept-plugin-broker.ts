// Plugin-facing broker for sdk.intercept Worker requests. Translates
// Worker-side requests (intercept.register / unregister / alloc-rings)
// into calls on the InterceptBroker. Emits notify events back to the
// originating plugin via the runtime's per-plugin emit.

import type { InterceptBroker } from "../intercept/broker.js";
import type {
  RingsAllocPayload, RingsAllocResult,
} from "../intercept/worker-state.js";
import type { InterceptSpec } from "@overdraw/intercept-types";

export const INTERCEPT_NOT_HANDLED = Symbol("intercept-plugin-broker:not-handled");

export interface InterceptPluginBrokerDeps {
  interceptBroker: InterceptBroker;
  // Emit a one-way event to a specific plugin. Used to push matched /
  // unmatched / unmatched notifications + the ring alloc result.
  emitToPlugin: (pluginName: string, name: string, data: unknown) => void;
}

export type InterceptPluginBroker = (
  pluginName: string, method: string, params: unknown,
) => Promise<unknown> | unknown | typeof INTERCEPT_NOT_HANDLED;

export function createInterceptPluginBroker(deps: InterceptPluginBrokerDeps): InterceptPluginBroker {
  // Per-plugin registration tracker: registration id -> pluginName for
  // forwarding alloc-rings calls back to the right plugin.
  const ownerOfRegistration = new Map<number, string>();

  return async function onRequest(pluginName: string, method: string, params: unknown) {
    if (method === "intercept.register") {
      return await handleRegister(pluginName, params);
    }
    if (method === "intercept.unregister") {
      return await handleUnregister(params);
    }
    if (method === "intercept.alloc-rings") {
      return await handleAllocRings(params);
    }
    if (method === "intercept.unmatch-ack") {
      return handleUnmatchAck(params);
    }
    return INTERCEPT_NOT_HANDLED;
  };

  function handleUnmatchAck(params: unknown): null {
    if (!params || typeof params !== "object") {
      throw new Error("intercept.unmatch-ack: malformed params");
    }
    // eslint-disable-next-line no-restricted-syntax -- trusted SDK shape
    const p = params as unknown as { registrationId: number; surfaceId: number };
    if (typeof p.registrationId !== "number" || typeof p.surfaceId !== "number") {
      throw new Error("intercept.unmatch-ack: registrationId + surfaceId required");
    }
    deps.interceptBroker.ackUnmatched(p.registrationId, p.surfaceId);
    return null;
  }

  async function handleRegister(pluginName: string, params: unknown): Promise<{ registrationId: number }> {
    if (!params || typeof params !== "object") {
      throw new Error("intercept.register: malformed params");
    }
    // eslint-disable-next-line no-restricted-syntax -- trusted SDK shape
    const p = params as unknown as { match: InterceptSpec["match"]; priority?: number };
    if (!p.match || typeof p.match !== "object") {
      throw new Error("intercept.register: match required");
    }
    if (p.priority !== undefined && (typeof p.priority !== "number" || !Number.isFinite(p.priority))) {
      throw new Error("intercept.register: priority must be a finite number");
    }
    const id = await deps.interceptBroker.registerWorker({
      match: p.match,
      pluginName,
      priority: p.priority,
      notifyMatched: async (n) => {
        deps.emitToPlugin(pluginName, "intercept.matched", {
          registrationId: id,
          surfaceId: n.info.surfaceId,
          appId: n.info.appId ?? null,
          title: n.info.title ?? null,
          role: n.info.role,
          width: n.width,
          height: n.height,
          opaque: n.opaque,
        });
      },
      notifyUnmatched: async (info) => {
        deps.emitToPlugin(pluginName, "intercept.unmatched", {
          registrationId: id,
          surfaceId: info.surfaceId,
        });
      },
    });
    ownerOfRegistration.set(id, pluginName);
    return { registrationId: id };
  }

  async function handleUnregister(params: unknown): Promise<null> {
    if (!params || typeof params !== "object") {
      throw new Error("intercept.unregister: malformed params");
    }
    // eslint-disable-next-line no-restricted-syntax -- trusted SDK shape
    const p = params as unknown as { registrationId: number };
    if (typeof p.registrationId !== "number") {
      throw new Error("intercept.unregister: registrationId required");
    }
    ownerOfRegistration.delete(p.registrationId);
    await deps.interceptBroker.unregister(p.registrationId);
    return null;
  }

  async function handleAllocRings(params: unknown): Promise<RingsAllocResult> {
    if (!params || typeof params !== "object") {
      throw new Error("intercept.alloc-rings: malformed params");
    }
    // eslint-disable-next-line no-restricted-syntax -- trusted SDK shape
    const p = params as unknown as {
      registrationId: number;
      surfaceId: number;
      width: number;
      height: number;
      inputConsumers: RingsAllocPayload["inputConsumers"];
      outputProducers: RingsAllocPayload["outputProducers"];
    };
    if (typeof p.registrationId !== "number" || typeof p.surfaceId !== "number") {
      throw new Error("intercept.alloc-rings: registrationId + surfaceId required");
    }
    return await deps.interceptBroker.allocateWorkerRings(p.registrationId, p.surfaceId, {
      width: p.width,
      height: p.height,
      inputConsumers: p.inputConsumers,
      outputProducers: p.outputProducers,
    });
  }
}
