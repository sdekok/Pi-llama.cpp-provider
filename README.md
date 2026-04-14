# llama.cpp pi connector

A [pi-coding-agent](https://github.com/badlogic/pi-mono) extension that integrates with `llama-server` (llama.cpp HTTP server). Unlike the built-in OpenAI provider, this extension auto-discovers models and extracts metadata — context window size, parameter count, reasoning capability — directly from the server at startup.

## How It Works

On startup, the extension hooks into `resources_discover` and:

1. Finds llama.cpp servers to connect to (see Configuration below)
2. Checks server health via `/health`
3. Discovers loaded models via `/v1/models`
4. Extracts metadata (context window, model size) via the llama.cpp-native `/props` endpoint
5. Registers each server as an OpenAI-compatible provider with auto-detected model metadata

If an OpenAI provider is already manually configured for the same server URL, you'll get a warning notification so you can decide whether to remove the duplicate.

## Configuration

### Preferred: declare servers in `models.json`

Add providers with `api: "llamacpp"` to your pi `models.json`:

```json
{
  "providers": {
    "my-local":  { "baseUrl": "http://localhost:8080", "api": "llamacpp", "apiKey": "none" },
    "my-remote": { "baseUrl": "http://server.example.com:8000", "api": "llamacpp", "apiKey": "none" }
  }
}
```

The extension scans for all providers with `api: "llamacpp"`, connects to each, and re-registers them as `api: "openai-responses"` with live metadata. Multiple servers are supported. The provider name in pi's model picker matches whatever name you chose.

### Fallback: single auto-discovered server

If no `api: "llamacpp"` providers are found in `models.json`, the extension resolves a single server URL and registers it as `"llama-cpp"` using this precedence:

1. **Environment variable**: `LLAMA_CPP_BASE_URL`
2. **Project settings** (`.pi/settings.json`): `{ "llama": { "baseUrl": "..." } }`
3. **Global settings** (`~/.pi/agent/settings.json`): `{ "llama": { "baseUrl": "..." } }`
4. **Default**: `http://localhost:8080`

## Auto-detected Metadata

| Metadata | Source | Notes |
| :--- | :--- | :--- |
| Context window | `/props` (`n_ctx`, `context_length`, or `ctx_size`) | Per-model args take precedence over server-level `/props` |
| Reasoning capability | Model ID pattern match | Matches `coder`, `r1`, `deepseek`, `think`, `reason` |

Context window detection prefers per-model args over `/props` to handle router setups where `/props` returns `n_ctx: 0`.

## Installation

```bash
pi install ./path/to/llama.cpp-pi-connector
```

## Requirements

- A running [llama.cpp](https://github.com/ggml-org/llama.cpp) HTTP server (`./llama-server`)
- [pi-coding-agent](https://github.com/badlogic/pi-mono)

## Development

```bash
# Build (cleans dist/ and recompiles)
npm run build

# Test
npm test

# Run a single test file
npx vitest tests/llama-client.test.ts
```

## License

MIT
