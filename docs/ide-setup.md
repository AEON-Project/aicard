# IDE Setup

The fastest path for most IDEs is the [skills CLI](https://agentskills.io), which auto-installs the bundled `skills/aicard/SKILL.md` into every detected agent:

```bash
npx skills add AEON-Project/aicard -g -y
```

For IDEs the skills CLI doesn't cover natively, copy the matching template from `templates/` into your project.

## Cursor

Cursor reads `.cursor/rules/*.mdc` from the project root.

```bash
mkdir -p .cursor/rules
cp node_modules/@aeon-ai-pay/aicard/templates/cursor/.cursor/rules/aicard.mdc .cursor/rules/
```

If you installed `@aeon-ai-pay/aicard` globally (`npm i -g`), substitute the `npm root -g` path. The `.mdc` file includes a `description:` line so Cursor can decide when to apply it.

## Windsurf

Windsurf reads `.windsurfrules` from the project root.

```bash
cp node_modules/@aeon-ai-pay/aicard/templates/windsurf/.windsurfrules ./.windsurfrules
```

If you already have project-level Windsurf rules, append the contents of the template instead of overwriting.

## Cline / Roo Code

Both Cline and Roo Code read `.clinerules` from the project root.

```bash
cp node_modules/@aeon-ai-pay/aicard/templates/cline/.clinerules ./.clinerules
```

## Codex / OpenAI Codex

Codex reads `AGENTS.md` from the project root (or nested folders).

```bash
cp node_modules/@aeon-ai-pay/aicard/templates/codex/AGENTS.md ./AGENTS.md
```

If your repo already has an `AGENTS.md`, append the `aicard` section rather than overwriting.

## Claude Code & 40+ Other Agents

For Claude Code, OpenClaw, Gemini CLI, GitHub Copilot, and 30+ others, the [skills CLI](https://agentskills.io) installs the full `SKILL.md` automatically. No manual copying needed.

## Verifying It Works

After installation, in your IDE chat say:

> Create me a $5 virtual card.

The agent should propose running `aicard setup --check` (one-time, auto-creates a wallet) followed by `aicard create --amount 5 --poll`. If it doesn't, the rule file isn't being picked up — check that the file path matches what your IDE expects and that the IDE has been restarted.
