/** Production wiring; the synthesis engine can also run with deterministic test doubles. */
import {
  synthesiseGraph as synthesise,
  type SynthesisRequest,
  type SynthesisResult,
} from '../core/graph/synthesizer.js';
import { providers } from './runtime.js';
import { listToolCatalog } from './toolCatalog.js';

// Preserve the existing service API for chat and optimization callers.
export { SynthesisError, type SynthesisResult } from '../core/graph/synthesizer.js';

export function synthesiseGraph(args: SynthesisRequest): Promise<SynthesisResult> {
  return synthesise(args, {
    listTools: listToolCatalog,
    complete: (input, context) => providers.provider('text.model').complete(input, context),
  });
}
