# Your tools

Drop any executable in this directory and your assistant can run it — it is on
the `PATH` of every shell the agent opens. Written in anything: bash, Python,
Node, a compiled binary.

Two rules:

1. **Make it executable** (`chmod +x`).
2. **Document it in `../AGENTS.md`**, under "Custom tools". A tool your
   assistant doesn't know about is a tool it will never use.

Design them like CLIs, not like APIs: one job each, arguments in, plain text
out, non-zero exit on failure. The assistant reads stdout.

## Example

`tools/weather`:

```bash
#!/usr/bin/env bash
set -euo pipefail
curl -fsSL "https://wttr.in/${1:-Johannesburg}?format=3"
```

Then in `AGENTS.md`:

```markdown
- `weather [city]` — current conditions, one line. Defaults to Johannesburg.
```

That's the whole extension mechanism. If a tool needs a secret, read it from the
environment (populated from SSM at boot) rather than hardcoding it here.
