export interface LlamaModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  status?: {
    value?: string;
    args?: string[];
    preset?: string;
  };
}

export interface ParsedModelArgs {
  /** Per-request context window: floor(ctx-size / parallel). Null if not present in args. */
  contextWindow: number | null;
  /**
   * Whether the model has extended reasoning enabled.
   * True/false if --reasoning on/off is explicit; null means absent (fall back to name heuristic).
   */
  reasoning: boolean | null;
}

/**
 * Extracts per-request context window and reasoning flag from a model's launch args.
 * Router setups embed the full llama-server argv in each model's status.args, so this
 * is the authoritative source on router deployments where /props returns n_ctx:0.
 *
 * Context: floor(ctx-size / parallel) — each parallel slot gets an equal share of the KV cache.
 * Reasoning: explicit --reasoning on/off wins; absent means caller should fall back to name regex.
 */
export function parseModelArgs(model: LlamaModel): ParsedModelArgs {
  const args = model.status?.args;
  if (!args) return { contextWindow: null, reasoning: null };

  // --- context window ---
  let contextWindow: number | null = null;
  const ctxIdx = args.indexOf('--ctx-size');
  if (ctxIdx !== -1 && ctxIdx + 1 < args.length) {
    const ctxSize = parseInt(args[ctxIdx + 1], 10);
    if (!isNaN(ctxSize) && ctxSize > 0) {
      const parallelIdx = args.indexOf('--parallel');
      let parallel = 1;
      if (parallelIdx !== -1 && parallelIdx + 1 < args.length) {
        const p = parseInt(args[parallelIdx + 1], 10);
        if (!isNaN(p) && p > 0) parallel = p;
      }
      contextWindow = Math.floor(ctxSize / parallel);
    }
  }

  // --- reasoning ---
  let reasoning: boolean | null = null;
  const reasoningIdx = args.indexOf('--reasoning');
  if (reasoningIdx !== -1 && reasoningIdx + 1 < args.length) {
    const val = args[reasoningIdx + 1].toLowerCase();
    if (val === 'on') reasoning = true;
    else if (val === 'off') reasoning = false;
  }

  return { contextWindow, reasoning };
}

export interface LlamaChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LlamaProps {
  [key: string]: any;
}

/** 
 * Represents the metadata we want to sync with pi's provider model definition.
 */
export interface ModelMetadata {
  id: string;
  contextWindow: number;
  parameterSize?: string;
  family?: string;
}

export class LlamaClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    // Strip trailing slash and /v1 suffix so that root-level endpoints
    // (/health, /props) and versioned endpoints (/v1/models) are all constructed
    // correctly regardless of whether the caller's baseUrl includes /v1.
    this.baseUrl = baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
  }

  async getStatus(): Promise<{ ok: boolean; message: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      if (response.ok) {
        return { ok: true, message: 'Connected' };
      } else {
        return { ok: false, message: `Server returned ${response.status}` };
      }
    } catch (error: any) {
      return { ok: false, message: error.message };
    }
  }

  async getModels(): Promise<LlamaModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`);
      if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`);
      const data = await response.json() as { data: LlamaModel[] };
      return data.data;
    } catch (error: any) {
      throw new Error(`Error fetching models: ${error.message}`);
    }
  }

  /**
   * Fetches the server properties which contain context and model info.
   */
  async getProps(): Promise<LlamaProps> {
    try {
      const response = await fetch(`${this.baseUrl}/props`);
      if (!response.ok) throw new Error(`Failed to fetch props: ${response.statusText}`);
      return await response.json() as LlamaProps;
    } catch (error: any) {
      throw new Error(`Error fetching props: ${error.message}`);
    }
  }

  /**
   * A helper that attempts to synthesize model metadata from the /props endpoint.
   * Since llama-server usually hosts one primary model, we extract its info here.
   */
  async getActiveModelMetadata(): Promise<ModelMetadata | null> {
    try {
      const props = await this.getProps();
      // In many llama.cpp builds, the /props endpoint returns a flat object 
      // or an object containing model details. We look for common keys.
      
      // This is heuristic-based as different versions of llama.cpp might vary slightly.
      const ctx = props.n_ctx || props.context_length || props.ctx_size;
      if (!ctx) return null;

      return {
        id: props.model_name || "llama-cpp-model", // Fallback if name isn't in props
        contextWindow: Number(ctx),
        parameterSize: props.model_size || props.param_count,
        family: props.model_family || props.architecture
      };
    } catch (e) {
      return null;
    }
  }

  async chatCompletion(messages: Array<{ role: string; content: string }>, options: any = {}): Promise<LlamaChatCompletionResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, ...options }),
      });

      if (!response.ok) throw new Error(`Chat completion failed: ${response.statusText}`);
      return await response.json() as LlamaChatCompletionResponse;
    } catch (error: any) {
      throw new Error(`Error in chat completion: ${error.message}`);
    }
  }
}
