export interface LlamaModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
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
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
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
