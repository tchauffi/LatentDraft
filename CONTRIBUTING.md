# Contributing to LatentDraft

Thanks for your interest! Issues and pull requests are welcome.

## Dev setup

```sh
npm install       # client + server (npm workspaces)
npm run setup     # fetches the Tectonic binary + creates the Python venv
npm run dev       # API on :5174, Vite dev server on :5173
```

See the [README](README.md) for the full requirements (Node 20+, optionally Ollama for the default agent).

## Before opening a PR

```sh
npm run typecheck
npm test          # node:test suites in server/test and client/test
```

CI runs the same checks plus a production-serve smoke test; PRs need a green run. If you add behavior, add a test next to the existing ones (`server/test/*.test.ts`, `client/test/*.test.ts`).

## License

LatentDraft is licensed under the [AGPL-3.0](LICENSE); contributions are accepted under the same license.
