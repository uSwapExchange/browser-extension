import type { BusEvent, ModuleId } from '../bus/protocol.js';

/**
 * Modules are the unit of extension features. Rules:
 * - a module may only import from core/* — never from another module
 * - every manifest permission is annotated with its owning module
 * - handler keys are message `type`s scoped under the module id on the bus
 */

export interface ModuleContext {
  /** Push an event to the exact frame connection that initiated the request. */
  pushToConnection(connectionKey: string, event: BusEvent): boolean;
}

export type ModuleHandler = (
  payload: unknown,
  sender: chrome.runtime.MessageSender,
) => Promise<unknown>;

export interface ExtensionModule {
  id: ModuleId;
  handlers: Record<string, ModuleHandler>;
  /** Called once at service-worker startup. Register chrome.* listeners synchronously here. */
  init?(ctx: ModuleContext): void;
}

const modules = new Map<ModuleId, ExtensionModule>();

export function registerModules(ctx: ModuleContext, list: ExtensionModule[]): void {
  for (const mod of list) {
    modules.set(mod.id, mod);
    mod.init?.(ctx);
  }
}

export function resolveHandler(module: ModuleId, type: string): ModuleHandler | null {
  return modules.get(module)?.handlers[type] ?? null;
}
