import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlamaClient } from '../src/llama-client';

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
});
