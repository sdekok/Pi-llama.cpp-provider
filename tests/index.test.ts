import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock for LlamaClient instance — must be defined before vi.mock calls
// ---------------------------------------------------------------------------
const mockClient = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getModels: vi.fn(),
  getActiveModelMetadata: vi.fn(),
  getProps: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@mariozechner/pi-coding-agent', () => ({
  getAgentDir: vi.fn(() => '/mock/agent'),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('../src/llama-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llama-client')>();
  return {
    ...actual,
    // Must use a regular function (not an arrow function) so `new LlamaClient()`
    // works — arrow functions cannot be called as constructors.
    // Returning an object from a constructor causes `new` to return that object.
    LlamaClient: vi.fn(function () { return mockClient; }),
    // parseModelArgs is a pure function — keep the real implementation so index.ts
    // can call it against whatever model objects the tests pass in.
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import * as fs from 'node:fs';
import * as os from 'node:os';
import { getAgentDir } from '@mariozechner/pi-coding-agent';
import { LlamaClient } from '../src/llama-client';
import setupExtension, {
  findConfiguredServers,
  getFallbackBaseUrl,
  registerLlamaProvider,
} from '../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    cwd: '/mock/cwd',
    modelRegistry: { getAll: vi.fn(() => []) },
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

function makePi() {
  const commandHandlers: Record<string, (args: string, ctx: any) => Promise<void>> = {};
  let resourcesDiscoverHandler: ((event: any, ctx: any) => Promise<any>) | undefined;

  const pi = {
    on: vi.fn((event: string, handler: any) => {
      if (event === 'resources_discover') resourcesDiscoverHandler = handler;
    }),
    registerProvider: vi.fn(),
    registerCommand: vi.fn((name: string, config: any) => {
      commandHandlers[name] = config.handler;
    }),
    // Test helpers
    triggerResourcesDiscover: async (ctx: any, event: any = {}) => {
      if (!resourcesDiscoverHandler) throw new Error('resources_discover handler not registered');
      return resourcesDiscoverHandler({ type: 'resources_discover', cwd: ctx.cwd, ...event }, ctx);
    },
    triggerCommand: async (name: string, args: string, ctx: any) => {
      const handler = commandHandlers[name];
      if (!handler) throw new Error(`command "${name}" not registered`);
      return handler(args, ctx);
    },
  };
  return pi;
}

function makeModelsJson(providers: Record<string, any>): string {
  return JSON.stringify({ providers });
}

function mockModelsJsonFile(content: string) {
  vi.mocked(fs.existsSync).mockImplementation((p: any) =>
    String(p) === '/mock/agent/models.json'
  );
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    if (String(p) === '/mock/agent/models.json') return content;
    throw new Error('file not found');
  });
}

// ---------------------------------------------------------------------------
// findConfiguredServers
// ---------------------------------------------------------------------------

describe('findConfiguredServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty map when models.json does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(findConfiguredServers().size).toBe(0);
  });

  it('returns empty map when providers object is empty', () => {
    mockModelsJsonFile(makeModelsJson({}));
    expect(findConfiguredServers().size).toBe(0);
  });

  it('returns empty map when no provider has api:"llamacpp"', () => {
    mockModelsJsonFile(makeModelsJson({
      openrouter: { api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' },
    }));
    expect(findConfiguredServers().size).toBe(0);
  });

  it('returns single entry for one llamacpp provider', () => {
    mockModelsJsonFile(makeModelsJson({
      'my-server': { api: 'llamacpp', baseUrl: 'http://localhost:8080' },
    }));
    const result = findConfiguredServers();
    expect(result.size).toBe(1);
    expect(result.get('my-server')).toBe('http://localhost:8080');
  });

  it('returns multiple entries for multiple llamacpp providers', () => {
    mockModelsJsonFile(makeModelsJson({
      local:  { api: 'llamacpp', baseUrl: 'http://localhost:8080' },
      remote: { api: 'llamacpp', baseUrl: 'http://server.example.com:8000/v1' },
    }));
    const result = findConfiguredServers();
    expect(result.size).toBe(2);
    expect(result.get('local')).toBe('http://localhost:8080');
    expect(result.get('remote')).toBe('http://server.example.com:8000/v1');
  });

  it('ignores providers with other api types', () => {
    mockModelsJsonFile(makeModelsJson({
      'llama-cpp':  { api: 'llamacpp',          baseUrl: 'http://localhost:8080' },
      openrouter:   { api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' },
      anthropic:    { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
    }));
    const result = findConfiguredServers();
    expect(result.size).toBe(1);
    expect(result.has('llama-cpp')).toBe(true);
  });

  it('ignores llamacpp providers without a baseUrl', () => {
    mockModelsJsonFile(makeModelsJson({
      'no-url': { api: 'llamacpp' },
      'with-url': { api: 'llamacpp', baseUrl: 'http://localhost:8080' },
    }));
    const result = findConfiguredServers();
    expect(result.size).toBe(1);
    expect(result.has('with-url')).toBe(true);
    expect(result.has('no-url')).toBe(false);
  });

  it('returns empty map for malformed JSON', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{ not valid json }');
    expect(findConfiguredServers().size).toBe(0);
  });

  it('passes baseUrl through unmodified (including /v1 suffix)', () => {
    const url = 'http://server.example.com:8000/v1';
    mockModelsJsonFile(makeModelsJson({
      server: { api: 'llamacpp', baseUrl: url },
    }));
    expect(findConfiguredServers().get('server')).toBe(url);
  });
});

// ---------------------------------------------------------------------------
// getFallbackBaseUrl
// ---------------------------------------------------------------------------

describe('getFallbackBaseUrl', () => {
  const savedEnv = process.env.LLAMA_CPP_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LLAMA_CPP_BASE_URL;
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.LLAMA_CPP_BASE_URL = savedEnv;
    else delete process.env.LLAMA_CPP_BASE_URL;
  });

  it('returns LLAMA_CPP_BASE_URL env var when set', async () => {
    process.env.LLAMA_CPP_BASE_URL = 'http://env-server:9000';
    const ctx = makeCtx();
    expect(await getFallbackBaseUrl(ctx as any)).toBe('http://env-server:9000');
  });

  it('env var takes precedence over all config files', async () => {
    process.env.LLAMA_CPP_BASE_URL = 'http://env-server:9000';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ llama: { baseUrl: 'http://settings-server:8080' } })
    );
    const ctx = makeCtx();
    expect(await getFallbackBaseUrl(ctx as any)).toBe('http://env-server:9000');
  });

  it('returns project settings.json baseUrl when no env var', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) =>
      String(p) === '/mock/cwd/.pi/settings.json'
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ llama: { baseUrl: 'http://project-server:8080' } })
    );
    const ctx = makeCtx();
    expect(await getFallbackBaseUrl(ctx as any)).toBe('http://project-server:8080');
  });

  it('project settings take precedence over global settings', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes('/mock/cwd/'))  return JSON.stringify({ llama: { baseUrl: 'http://project:8080' } });
      if (String(p).includes('/mock/home/')) return JSON.stringify({ llama: { baseUrl: 'http://global:8080' } });
      return '';
    });
    const ctx = makeCtx();
    expect(await getFallbackBaseUrl(ctx as any)).toBe('http://project:8080');
  });

  it('returns global settings.json baseUrl when no env var or project config', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) =>
      String(p) === '/mock/home/.pi/agent/settings.json'
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ llama: { baseUrl: 'http://global-server:8080' } })
    );
    const ctx = makeCtx();
    expect(await getFallbackBaseUrl(ctx as any)).toBe('http://global-server:8080');
  });

  it('returns http://localhost:8080 when nothing is configured', async () => {
    const ctx = makeCtx();
    expect(await getFallbackBaseUrl(ctx as any)).toBe('http://localhost:8080');
  });

  it('skips project settings when llama.baseUrl is missing from the file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes('/mock/cwd/'))  return JSON.stringify({ other: 'stuff' });
      if (String(p).includes('/mock/home/')) return JSON.stringify({ llama: { baseUrl: 'http://global:8080' } });
      return '';
    });
    const ctx = makeCtx();
    expect(await getFallbackBaseUrl(ctx as any)).toBe('http://global:8080');
  });
});

// ---------------------------------------------------------------------------
// registerLlamaProvider
// ---------------------------------------------------------------------------

describe('registerLlamaProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getStatus.mockResolvedValue({ ok: true, message: 'Connected' });
    mockClient.getModels.mockResolvedValue([
      { id: 'llama3', object: 'model', created: 0, owned_by: 'user' },
    ]);
    mockClient.getActiveModelMetadata.mockResolvedValue(null);
  });

  it('constructs LlamaClient with the provided baseUrl', async () => {
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-server', 'http://server:8080');
    expect(LlamaClient).toHaveBeenCalledWith('http://server:8080');
  });

  it('does not register provider when server is unreachable', async () => {
    mockClient.getStatus.mockResolvedValue({ ok: false, message: 'ECONNREFUSED' });
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-server', 'http://server:8080');
    expect(pi.registerProvider).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it('registers provider with the correct name and baseUrl', async () => {
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-llama', 'http://server:8080');
    expect(pi.registerProvider).toHaveBeenCalledWith('my-llama', expect.objectContaining({
      baseUrl: 'http://server:8080',
    }));
  });

  it('registers provider with api:"openai-responses" regardless of input api marker', async () => {
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-llama', 'http://server:8080');
    expect(pi.registerProvider).toHaveBeenCalledWith('my-llama', expect.objectContaining({
      api: 'openai-responses',
    }));
  });

  it('registers provider with apiKey:"none" for auth-free local models', async () => {
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-llama', 'http://server:8080');
    expect(pi.registerProvider).toHaveBeenCalledWith('my-llama', expect.objectContaining({
      apiKey: 'none',
    }));
  });

  it('includes context window from metadata in the registered models', async () => {
    mockClient.getActiveModelMetadata.mockResolvedValue({ id: 'test', contextWindow: 32768 });
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-llama', 'http://server:8080');
    const call = vi.mocked(pi.registerProvider).mock.calls[0][1];
    expect(call.models![0].contextWindow).toBe(32768);
    expect(call.models![0].maxTokens).toBe(32768);
  });

  it('defaults contextWindow to 4096 when metadata is unavailable', async () => {
    mockClient.getActiveModelMetadata.mockResolvedValue(null);
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-llama', 'http://server:8080');
    const call = vi.mocked(pi.registerProvider).mock.calls[0][1];
    expect(call.models![0].contextWindow).toBe(4096);
  });

  it('includes context window in the success notification', async () => {
    mockClient.getActiveModelMetadata.mockResolvedValue({ id: 'test', contextWindow: 16384 });
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-server', 'http://server:8080');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('16384'),
      'info'
    );
  });

  it('omits context window from notification when metadata is unavailable', async () => {
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-server', 'http://server:8080');
    const [msg] = vi.mocked(ctx.ui.notify).mock.calls[0];
    expect(msg).not.toMatch(/context/i);
  });

  it('shows warning notification when duplicate OpenAI provider exists at same URL', async () => {
    const ctx = makeCtx({
      modelRegistry: {
        getAll: vi.fn(() => [
          { provider: 'openai', baseUrl: 'http://server:8080' },
        ]),
      },
    });
    const pi = makePi();
    await registerLlamaProvider(pi as any, ctx as any, 'my-llama', 'http://server:8080');
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), 'warning');
  });

  it('shows info notification when no duplicate OpenAI provider', async () => {
    const ctx = makeCtx({
      modelRegistry: { getAll: vi.fn(() => []) },
    });
    const pi = makePi();
    await registerLlamaProvider(pi as any, ctx as any, 'my-llama', 'http://server:8080');
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), 'info');
  });

  it('marks models as reasoning when id matches known patterns', async () => {
    mockClient.getModels.mockResolvedValue([
      { id: 'deepseek-r1', object: 'model', created: 0, owned_by: 'user' },
      { id: 'qwen-think',  object: 'model', created: 0, owned_by: 'user' },
      { id: 'coder-7b',   object: 'model', created: 0, owned_by: 'user' },
      { id: 'llama3',     object: 'model', created: 0, owned_by: 'user' },
    ]);
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-llama', 'http://server:8080');
    const { models } = vi.mocked(pi.registerProvider).mock.calls[0][1];
    const byId = Object.fromEntries(models!.map(m => [m.id, m]));
    expect(byId['deepseek-r1'].reasoning).toBe(true);
    expect(byId['qwen-think'].reasoning).toBe(true);
    expect(byId['coder-7b'].reasoning).toBe(true);
    expect(byId['llama3'].reasoning).toBe(false);
  });

  it('sets zero cost for all models', async () => {
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-llama', 'http://server:8080');
    const { models } = vi.mocked(pi.registerProvider).mock.calls[0][1];
    expect(models![0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('registers all models returned by the server', async () => {
    mockClient.getModels.mockResolvedValue([
      { id: 'model-a', object: 'model', created: 0, owned_by: 'user' },
      { id: 'model-b', object: 'model', created: 0, owned_by: 'user' },
      { id: 'model-c', object: 'model', created: 0, owned_by: 'user' },
    ]);
    const pi = makePi();
    const ctx = makeCtx();
    await registerLlamaProvider(pi as any, ctx as any, 'my-llama', 'http://server:8080');
    const { models } = vi.mocked(pi.registerProvider).mock.calls[0][1];
    expect(models).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// resources_discover handler
// ---------------------------------------------------------------------------

describe('resources_discover handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockClient.getStatus.mockResolvedValue({ ok: true, message: 'Connected' });
    mockClient.getModels.mockResolvedValue([]);
    mockClient.getActiveModelMetadata.mockResolvedValue(null);
    delete process.env.LLAMA_CPP_BASE_URL;
  });

  it('registers servers found in models.json', async () => {
    mockModelsJsonFile(makeModelsJson({
      'my-llama': { api: 'llamacpp', baseUrl: 'http://server:8080' },
    }));
    const pi = makePi();
    const ctx = makeCtx();
    await setupExtension(pi as any);
    await pi.triggerResourcesDiscover(ctx);
    expect(pi.registerProvider).toHaveBeenCalledWith('my-llama', expect.objectContaining({
      baseUrl: 'http://server:8080',
    }));
  });

  it('falls back to getFallbackBaseUrl and registers as "llama-cpp" when no models.json config', async () => {
    // models.json exists but has no llamacpp providers
    mockModelsJsonFile(makeModelsJson({ openrouter: { api: 'openai-completions', baseUrl: 'https://x' } }));
    process.env.LLAMA_CPP_BASE_URL = 'http://env-server:9000';
    const pi = makePi();
    const ctx = makeCtx();
    await setupExtension(pi as any);
    await pi.triggerResourcesDiscover(ctx);
    expect(pi.registerProvider).toHaveBeenCalledWith('llama-cpp', expect.objectContaining({
      baseUrl: 'http://env-server:9000',
    }));
  });

  it('registers multiple servers in parallel when multiple configured', async () => {
    mockModelsJsonFile(makeModelsJson({
      local:  { api: 'llamacpp', baseUrl: 'http://localhost:8080' },
      remote: { api: 'llamacpp', baseUrl: 'http://remote:8000' },
    }));
    const pi = makePi();
    const ctx = makeCtx();
    await setupExtension(pi as any);
    await pi.triggerResourcesDiscover(ctx);
    expect(pi.registerProvider).toHaveBeenCalledTimes(2);
    const names = vi.mocked(pi.registerProvider).mock.calls.map(c => c[0]);
    expect(names).toContain('local');
    expect(names).toContain('remote');
  });

  it('does not crash when a server is unreachable', async () => {
    mockModelsJsonFile(makeModelsJson({
      down: { api: 'llamacpp', baseUrl: 'http://down:8080' },
    }));
    mockClient.getStatus.mockResolvedValue({ ok: false, message: 'ECONNREFUSED' });
    const pi = makePi();
    const ctx = makeCtx();
    await setupExtension(pi as any);
    await expect(pi.triggerResourcesDiscover(ctx)).resolves.not.toThrow();
    expect(pi.registerProvider).not.toHaveBeenCalled();
  });

  it('does not crash when an unexpected error is thrown', async () => {
    mockModelsJsonFile(makeModelsJson({
      server: { api: 'llamacpp', baseUrl: 'http://server:8080' },
    }));
    mockClient.getStatus.mockRejectedValue(new Error('unexpected'));
    const pi = makePi();
    const ctx = makeCtx();
    await setupExtension(pi as any);
    await expect(pi.triggerResourcesDiscover(ctx)).resolves.not.toThrow();
  });

  it('returns an empty object (required by pi event contract)', async () => {
    mockModelsJsonFile(makeModelsJson({}));
    const pi = makePi();
    const ctx = makeCtx();
    await setupExtension(pi as any);
    const result = await pi.triggerResourcesDiscover(ctx);
    expect(result).toEqual({});
  });
});

