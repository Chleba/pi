# pi-chleba Extensions

Custom extensions for the pi-chleba fork.

## Extensions

- **model-params** — `/params` slash command to set temperature, top_p, etc. per model or globally. Config stored at `~/.pi/agent/model-params.json`.
- **omarchy-system-theme** — Syncs pi's light/dark theme with the active Omarchy desktop theme.

## Install

Copy extensions to your global pi extensions directory:

```bash
cp ~/.pi/agent/extensions/model-params.ts ~/.pi/agent/extensions/omarchy-system-theme.ts ~/.pi/agent/extensions/
```

Or symlink from this repo:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf "$(pwd)/pi-chleba-extensions/model-params.ts" ~/.pi/agent/extensions/
ln -sf "$(pwd)/pi-chleba-extensions/omarchy-system-theme.ts" ~/.pi/agent/extensions/
```

Pi loads extensions from `~/.pi/agent/extensions/` on startup. No restart needed — extensions reload with the next session.

## Usage

### model-params

```
/params                        # show current params for active model
/params temperature 0.6        # set global default
/params m:qwen3.6-27b temperature 0.8  # set model-specific
/params reset                  # clear all
/params reset qwen3.6-27b      # clear model-specific
```

Config file: `~/.pi/agent/model-params.json`

```json
{
  "default": {
    "temperature": 0.6,
    "top_p": 0.95
  },
  "models": {
    "lmstudio/unsloth/qwen3.6-27b": {
      "temperature": 0.8
    }
  }
}
```

### omarchy-system-theme

No configuration needed. Runs automatically — polls every 2 seconds for theme changes.
