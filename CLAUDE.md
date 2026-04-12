# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a TypeScript extension for [pi-coding-agent](https://github.com/badlogic/pi-mono) that provides deep integration with llama.cpp HTTP servers (`llama-server`). Unlike the built-in OpenAI provider which treats LLMs as a black box, this extension adds "white-box" visibility into llama.cpp server state, model metadata, and configuration.

The extension dynamically discovers and registers models from a running llama-server instance, then exposes diagnostic commands for troubleshooting and inspection.

## Development Commands

### Building
```bash
npx tsc
```
Compiles TypeScript sources from `src/` to `dist/`. The extension is loaded by pi from the compiled JavaScript output.

### Testing
```bash
npx vitest
```
Runs the test suite using vitest. Tests use mocked fetch calls to simulate llama.cpp server responses.

### Running Single Test
```bash
npx vitest tests/llama-client.test.ts
```

### Installing in pi
```bash
pi install ./path/to/llama.cpp-pi-connector
```
Installs the extension into the pi-coding-agent.

## Architecture

### Core Components

**`src/index.ts`** - Extension entry point and pi integration
- Hooks into `resources_discover` event to auto-register the llama-cpp provider before pi finishes startup
- Fetches models and metadata from llama-server, then registers a dynamic OpenAI-compatible provider
- Registers three diagnostic slash commands: `/llama-status`, `/llama-models`, `/llama-info`
- Implements configuration resolution with precedence: env var → project settings → global settings → default

**`src/llama-client.ts`** - HTTP client for llama.cpp server communication
- `getStatus()`: Checks `/health` endpoint for server connectivity
- `getModels()`: Queries `/v1/models` (OpenAI-compatible) to list loaded models
- `getProps()`: Fetches `/props` (llama.cpp-specific) for server configuration and parameters
- `getActiveModelMetadata()`: Synthesizes model metadata from `/props` (context window, parameter size, architecture)
- `chatCompletion()`: Sends chat completion requests via `/v1/chat/completions`

**`tests/llama-client.test.ts`** - Unit tests
- Uses vitest with mocked global fetch
- Tests all client methods and edge cases (trailing slashes, error handling, metadata extraction)

### Configuration Resolution

The extension determines the llama.cpp server URL using this precedence:

1. **Environment Variable**: `LLAMA_CPP_BASE_URL`
2. **Project Settings**: `.pi/settings.json` with `{ "llama": { "baseUrl": "..." } }`
3. **Global Settings**: `~/.pi/agent/settings.json` with same structure
4. **Default**: `http://localhost:8080`

Configuration is read in `getBaseUrl()` in index.ts.

### Provider Auto-Registration

On `resources_discover` event:
1. Check server health via `/health`
2. Fetch models from `/v1/models`
3. Fetch metadata from `/props` to extract context window and parameters
4. **Check for duplicate OpenAI provider configuration** - queries `ctx.modelRegistry.getAll()` to detect if an OpenAI provider is already configured for the same baseUrl
5. Map models to pi's Provider format with OpenAI-compatible API type
6. Register as "llama-cpp" provider with dynamic model list
7. Show notification with context window info and duplication warning if applicable

The provider uses `api: "openai-responses"` since llama.cpp implements OpenAI-compatible endpoints.

**Duplicate Detection:** If an OpenAI provider is already configured for the same baseUrl:
- A warning is logged to console
- The notification type changes from "info" to "warning"
- Both providers remain registered (user can choose which to use)
- The llama-cpp provider includes auto-detected metadata that the manual OpenAI config may lack

### llama.cpp Endpoint Usage

This extension queries llama.cpp-specific endpoints:
- `/health` - Server status check (standard health endpoint)
- `/v1/models` - OpenAI-compatible model listing
- `/props` - **llama.cpp native endpoint** returning server properties like `n_ctx`, `model_name`, `model_size`, etc.
- `/v1/chat/completions` - OpenAI-compatible chat completions (used by pi's OpenAI provider, not this extension)

The `/props` endpoint is heuristic-based; different llama.cpp versions may return varying property names. The code looks for common keys like `n_ctx`, `context_length`, `ctx_size` to extract context window size.

## Key Patterns

- **Dynamic Provider Registration**: Models are discovered at runtime rather than hardcoded
- **Graceful Degradation**: If server is unreachable, extension logs error but doesn't crash pi startup
- **Metadata Synthesis**: Extracts context window from `/props` since models may not report it via OpenAI API
- **Reasoning Detection**: Automatically marks models as "reasoning" if their ID matches patterns like `coder|r1|deepseek|think|reason`

## Testing Notes

Tests mock the global `fetch` function since LlamaClient uses native fetch. When adding new client methods, follow the existing pattern:
1. Mock fetch with `vi.fn()`
2. Set up mock response using `mockResolvedValue()`
3. Assert on method return values and fetch call arguments
