# llama.cpp pi connector

A specialized extension for [pi-coding-agent](https://github.com/badlogic/pi-mono) that provides deep integration and diagnostic capabilities for `llama.cpp` HTTP servers (`llama-server`).

While you can use the built-in OpenAI provider in `pi` to talk to a llama.cpp backend, this extension adds "white-box" visibility and management tools that go beyond simple chat completions.

## 🚀 How It Works

This extension acts as a diagnostic companion for your running `llama-server`. Instead of treating the LLM as a black box via standard API calls, it communicates directly with llama.cpp's specific endpoints:

* **Connectivity**: Uses `/health` to ensure the server is responsive and ready for requests.
* **Model Discovery**: Queries `/v1/models` (OpenAI-compatible) to list all currently loaded models in the instance.
* **Deep Inspection**: Leverages the llama.cpp native `/props` endpoint to extract detailed metadata, such as:
    * Maximum context window size (`n_ctx`)
    * Model parameters and architecture details
    * Server configuration

## 🤝 Relationship with the OpenAI Provider

You might wonder: *"If I can already use the built-in OpenAI provider in `pi`, why do I need this?"*

This extension provides two key benefits:

### 1. **Auto-Registration with Smart Metadata**
- Automatically registers a `llama-cpp` provider on startup
- **Auto-detects context window** from the `/props` endpoint (no manual configuration needed!)
- **Auto-detects reasoning capability** based on model name patterns
- If you've already configured the OpenAI provider for the same llama.cpp server, you'll get a warning notification and can choose which provider to use

### 2. **Diagnostic Commands**
Provides specialized slash commands for troubleshooting and inspection:
- `/llama-status` - Check server connectivity
- `/llama-models` - List loaded models
- `/llama-info` - View server properties and configuration

**Comparison:**

| Feature | Built-in OpenAI Provider | llama.cpp Provider (This Extension) |
| :--- | :--- | :--- |
| **Configuration** | Manual setup in settings | Auto-discovered on startup |
| **Context Window** | Must specify manually | Auto-detected from `/props` |
| **Reasoning Detection** | Manual configuration | Auto-detected from model name |
| **Diagnostics** | None | `/llama-status`, `/llama-models`, `/llama-info` commands |
| **API Compatibility** | OpenAI-compatible | OpenAI-compatible (same underlying API) |

## ✨ Features & Commands

| Command        | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `/llama-status`  | Check if the llama.cpp server is reachable and healthy.|
| `/llama-models`  | List all models currently loaded in the server instance.|
| `/llama-info`    | Show detailed server properties (context, params, etc.)|

## 🔄 Auto-Registration Behavior

On startup, this extension:
1. Connects to your llama.cpp server
2. Discovers available models via `/v1/models`
3. Extracts metadata (context window, parameters) via `/props`
4. Registers a `llama-cpp` provider with the discovered models

**Duplicate Detection:**
- If you've already manually configured the OpenAI provider for the same llama.cpp server URL, you'll receive a warning notification
- Both providers will be available - you can choose which one to use
- The `llama-cpp` provider includes auto-detected metadata (context window, reasoning detection)
- The warning helps you decide whether to keep both or remove the manual OpenAI configuration

**Example notification:**
```
Registered 1 llama.cpp model(s) (context: 8192)
⚠️  Warning: 1 OpenAI model(s) also configured for http://localhost:8080
```

## 🛠️ Installation

### Local installation
Clone this repository or point to the directory:
```bash
pi install ./path/to/llama.cpp-pi-connector
```

## ⚙️ Configuration

The extension determines the llama.cpp `baseUrl` using the following precedence (highest first):

1. **Environment Variable**: `LLAMA_CPP_BASE_URL`
   ```bash
   export LLAMA_CPP_BASE_URL="http://localhost:8080"
   pi
   ```

2. **Project-local settings** (`.pi/settings.json`):
   ```json
   {
     "llama": { "baseUrl": "http://custom-host:8080" }
   }
   ```

3. **Global user settings** (`~/.pi/agent/settings.json`):
   ```json
   {
     "llama": { "baseUrl": "http://localhost:8080" }
   }
   ```

If no configuration is found, it defaults to `http://localhost:8080`.

## 📋 Requirements

* A running instance of [llama.cpp](https://github.com/ggml-org/llama.cpp) with the HTTP server enabled (`./llama-server`).
* [pi-coding-agent](https://github.com/badlogic/pi-mono).

## 📄 License

MIT © Your Name
