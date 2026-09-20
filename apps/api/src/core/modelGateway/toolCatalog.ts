/**
 * Compatibility exports for the model gateway. The actual registry is shared
 * with the execution broker under core/tools.
 */
export {
  InMemoryToolRegistry,
  InMemoryToolRegistry as InMemoryToolDescriptorCatalog,
} from '../tools/registry.js';
export type {
  RegisteredTool,
  ToolRegistration,
  ToolRegistry,
  ToolRegistry as ToolDescriptorCatalog,
} from '../tools/registry.js';
