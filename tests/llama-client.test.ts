import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlamaClient, parseModelArgs } from '../src/llama-client';

describe('LlamaClient', () => {
  const baseUrl = 'http://localhost:8080';
  let client: LlamaClient;

  beforeEach(() => {
    client = new LlamaClient(baseUrl);
    // Mock global fetch
    global.fetch = vi.fn();
  });

  it('should strip trailing slash from baseUrl', async () => {
    const badClient = new LlamaClient('http://localhost:8080/');
    await (badClient as any).getStatus();
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('http://localhost:8080/health'));
  });

  it('should strip /v1 suffix from baseUrl so root endpoints resolve correctly', async () => {
    (global.fetch as any).mockResolvedValue({ ok: true });
    const v1Client = new LlamaClient('http://server.example.com:8000/v1');
    await v1Client.getStatus();
    expect(global.fetch).toHaveBeenCalledWith('http://server.example.com:8000/health');
  });

  it('should hit /v1/models correctly when baseUrl includes /v1', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    const v1Client = new LlamaClient('http://server.example.com:8000/v1');
    await v1Client.getModels();
    expect(global.fetch).toHaveBeenCalledWith('http://server.example.com:8000/v1/models');
  });

  it('getStatus returns ok when response is successful', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
    });

    const status = await client.getStatus();
    expect(status.ok).toBe(true);
    expect(status.message).toBe('Connected');
  });

  it('getStatus returns error when response fails', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
    });

    const status = await client.getStatus();
    expect(status.ok).toBe(false);
    expect(status.message).toContain('500');
  });

  it('getModels returns models array', async () => {
    const mockModels = [
      { id: 'llama3', object: 'model', created: 123, owned_by: 'user' },
      { id: 'mistral', object: 'model', created: 456, owned_by: 'user' }
    ];

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const models = await client.getModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('llama3');
  });

  it('getActiveModelMetadata extracts correct info from props', async () => {
    const mockProps = {
      n_ctx: 8192,
      model_name: 'test-model',
      model_size: '7B',
      architecture: 'llama'
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockProps,
    });

    const metadata = await client.getActiveModelMetadata();
    expect(metadata?.contextWindow).toBe(8192);
    expect(metadata?.id).toBe('test-model');
    expect(metadata?.parameterSize).toBe('7B');
    expect(metadata?.family).toBe('llama');
  });

  it('chatCompletion sends correct payload', async () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const options = { temperature: 0.7 };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    await client.chatCompletion(messages, options);

    expect(global.fetch).toHaveBeenCalledWith(
      `${baseUrl}/v1/chat/completions`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ messages, ...options }),
      })
    );
  });

  // ---------------------------------------------------------------------------
  // getProps
  // ---------------------------------------------------------------------------

  it('getProps returns the raw props object', async () => {
    const mockProps = { n_ctx: 4096, model_name: 'llama3', batch_size: 512 };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockProps,
    });
    const props = await client.getProps();
    expect(props).toEqual(mockProps);
    expect(global.fetch).toHaveBeenCalledWith(`${baseUrl}/props`);
  });

  it('getProps throws when server returns non-ok status', async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, statusText: 'Not Found' });
    await expect(client.getProps()).rejects.toThrow('Not Found');
  });

  // ---------------------------------------------------------------------------
  // getStatus edge cases
  // ---------------------------------------------------------------------------

  it('getStatus returns error message when fetch throws (network failure)', async () => {
    (global.fetch as any).mockRejectedValue(new Error('ECONNREFUSED'));
    const status = await client.getStatus();
    expect(status.ok).toBe(false);
    expect(status.message).toContain('ECONNREFUSED');
  });

  // ---------------------------------------------------------------------------
  // getModels edge cases
  // ---------------------------------------------------------------------------

  it('getModels throws a descriptive error when server returns non-ok status', async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, statusText: 'Service Unavailable' });
    await expect(client.getModels()).rejects.toThrow('Service Unavailable');
  });

  it('getModels returns an empty array when server returns no models', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    const models = await client.getModels();
    expect(models).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // getActiveModelMetadata edge cases
  // ---------------------------------------------------------------------------

  it('getActiveModelMetadata returns null when /props has no context field', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ model_name: 'llama3' }), // missing n_ctx / context_length / ctx_size
    });
    const metadata = await client.getActiveModelMetadata();
    expect(metadata).toBeNull();
  });

  it('getActiveModelMetadata accepts context_length as fallback key', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ context_length: 16384 }),
    });
    const metadata = await client.getActiveModelMetadata();
    expect(metadata?.contextWindow).toBe(16384);
  });

  it('getActiveModelMetadata accepts ctx_size as fallback key', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ ctx_size: 2048 }),
    });
    const metadata = await client.getActiveModelMetadata();
    expect(metadata?.contextWindow).toBe(2048);
  });

  it('getActiveModelMetadata returns null when getProps throws', async () => {
    (global.fetch as any).mockRejectedValue(new Error('network error'));
    const metadata = await client.getActiveModelMetadata();
    expect(metadata).toBeNull();
  });

  it('getActiveModelMetadata uses fallback model name when model_name is absent', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ n_ctx: 8192 }),
    });
    const metadata = await client.getActiveModelMetadata();
    expect(metadata?.id).toBe('llama-cpp-model');
  });
});

// ---------------------------------------------------------------------------
// parseModelArgs
// ---------------------------------------------------------------------------

describe('parseModelArgs', () => {
  it('returns null contextWindow and null reasoning when no status.args', () => {
    const model = { id: 'test', object: 'model' as const, created: 0, owned_by: 'test' };
    expect(parseModelArgs(model)).toEqual({ contextWindow: null, reasoning: null });
  });

  it('extracts ctx-size and divides by parallel', () => {
    const model = {
      id: 'test', object: 'model' as const, created: 0, owned_by: 'test',
      status: { args: ['--ctx-size', '262144', '--parallel', '3'] },
    };
    expect(parseModelArgs(model).contextWindow).toBe(Math.floor(262144 / 3));
  });

  it('uses parallel=1 when --parallel is absent', () => {
    const model = {
      id: 'test', object: 'model' as const, created: 0, owned_by: 'test',
      status: { args: ['--ctx-size', '131072'] },
    };
    expect(parseModelArgs(model).contextWindow).toBe(131072);
  });

  it('returns null contextWindow when --ctx-size is absent', () => {
    const model = {
      id: 'test', object: 'model' as const, created: 0, owned_by: 'test',
      status: { args: ['--parallel', '3'] },
    };
    expect(parseModelArgs(model).contextWindow).toBeNull();
  });

  it('returns reasoning=false when --reasoning off', () => {
    const model = {
      id: 'test', object: 'model' as const, created: 0, owned_by: 'test',
      status: { args: ['--reasoning', 'off'] },
    };
    expect(parseModelArgs(model).reasoning).toBe(false);
  });

  it('returns reasoning=true when --reasoning on', () => {
    const model = {
      id: 'test', object: 'model' as const, created: 0, owned_by: 'test',
      status: { args: ['--reasoning', 'on'] },
    };
    expect(parseModelArgs(model).reasoning).toBe(true);
  });

  it('returns reasoning=null when --reasoning is absent', () => {
    const model = {
      id: 'test', object: 'model' as const, created: 0, owned_by: 'test',
      status: { args: ['--ctx-size', '8192'] },
    };
    expect(parseModelArgs(model).reasoning).toBeNull();
  });

  it('handles realistic router model args', () => {
    const model = {
      id: 'unsloth/gemma-4-26B-A4B-it-GGUF:IQ4_NL',
      object: 'model' as const, created: 0, owned_by: 'llamacpp',
      status: {
        args: [
          '/app/llama-server', '--host', '127.0.0.1', '--jinja',
          '--ctx-size', '262144', '--parallel', '3',
          '--flash-attn', 'on', '--n-gpu-layers', '-1',
        ],
      },
    };
    const result = parseModelArgs(model);
    expect(result.contextWindow).toBe(Math.floor(262144 / 3));
    expect(result.reasoning).toBeNull();
  });
});
