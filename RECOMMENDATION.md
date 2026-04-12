# Recommendation: Smart Provider Registration

## Current Issue

The extension always registers a "llama-cpp" provider, even if the user has already configured the OpenAI provider to point to their llama.cpp server. This creates duplication.

## Proposed Solution

**Option 1: Detect and Warn (Minimal Change)**

Check if an OpenAI provider is already configured for the same baseUrl:
- If yes: Skip registration and show a notification with instructions
- If no: Register as "llama-cpp" provider as usual

Benefits:
- Avoids duplication
- Minimal code changes
- Still provides diagnostic commands
- Educates users about the built-in OpenAI provider

```typescript
// Check for existing OpenAI models with same baseUrl
const existingModels = ctx.modelRegistry.getAll();
const openaiModelsWithSameBase = existingModels.filter(
  m => m.provider === "openai" && m.baseUrl === baseUrl
);

if (openaiModelsWithSameBase.length > 0) {
  // User already configured OpenAI provider
  ctx.ui.notify(
    `OpenAI provider already configured for ${baseUrl}. ` +
    `Skipping llama-cpp registration. Use diagnostic commands: /llama-status, /llama-models, /llama-info`,
    "info"
  );
  return {};
}

// Otherwise register as llama-cpp provider...
```

---

**Option 2: Always Register with Metadata Enhancement (Current + Improvement)**

Keep the current behavior but add context window info to notification:
- Always register "llama-cpp" provider
- Show detected context window in notification
- Add a command to compare OpenAI vs llama-cpp provider settings

Benefits:
- Auto-detects context window (main value of this extension!)
- No breaking changes
- Users can choose which provider to use
- Diagnostic commands always available

```typescript
ctx.ui.notify(
  `Registered ${dynamicModels.length} models from llama.cpp ` +
  `(context: ${metadata?.contextWindow || 4096}). ` +
  `Use /llama-info for details.`,
  "info"
);
```

---

**Option 3: Configuration Flag (Advanced)**

Add a setting to control behavior:
```json
{
  "llama": {
    "baseUrl": "http://localhost:8080",
    "registerProvider": "auto" | "always" | "never"
  }
}
```

- `"auto"`: Register only if no OpenAI provider exists for this baseUrl (Option 1)
- `"always"`: Always register (current behavior)
- `"never"`: Only provide diagnostic commands, no provider registration

---

## Why NOT Wrap OpenAI Provider?

The pi API doesn't support "augmenting" providers - calling `registerProvider("openai", ...)` would **replace ALL OpenAI models**, including real OpenAI models from api.anthropic.com.

## The Real Value

The main advantage of this extension over manually configuring the OpenAI provider is:

1. **Auto-detects context window** from `/props` endpoint
2. **Auto-detects reasoning capability** based on model name
3. **Provides diagnostic commands** for troubleshooting

Without this extension, users must manually specify context window in their models.json, and they may get it wrong.

## Recommended Immediate Action

Implement **Option 1** (Detect and Warn):
- Check for duplicate OpenAI configuration
- Skip registration if found
- Show helpful notification
- Always keep diagnostic commands available

This prevents duplication while preserving the extension's diagnostic value.
