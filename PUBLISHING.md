# Publishing dsh-local-llm

The package is complete, installed and verified locally. This file records what
remains to publish it, and why each step needs a human.

## State

| Item | Status |
|---|---|
| Source in `E:\答题\dsh-local-llm` | ✅ complete |
| Local git repo + first commit | ✅ `bb354f1` |
| Installed in the desktop profile | ✅ `application: applied` |
| Tools live (`local_llm_scan`, `local_llm_register`) | ✅ verified against a live LM Studio server |
| Remote repository | ❌ none configured |
| npm / plugin market listing | ❌ not published |

## Blocked on credentials

Both remaining steps need an account this session does not hold. Nothing in the
package is unfinished.

### 1. GitHub

```bash
cd "E:\答题\dsh-local-llm"

# create the repo first (gh, or the web UI), then:
git remote add origin https://github.com/<you>/dsh-local-llm.git
git branch -M main
git push -u origin main
```

`gh` alternative, which creates and pushes in one step:

```bash
gh repo create dsh-local-llm --public --source=. --push \
  --description "Detect and register local OpenAI-compatible LLMs as DeepSeek Harness providers"
```

### 2. Plugin market

The bundle is a normal directory package: `package.json` declares
`dsh.bundle.patch`, and `cordis.patch.yml` mounts one row. A market listing
generally needs a public repository URL plus the package name, version and the
`dsh` metadata already present in `package.json`.

If the market expects an npm tarball, publish with:

```bash
npm publish --access public
```

Drop `"private": true` from `package.json` first. Keep it for GitHub-only
distribution.

## Verification already performed

- `node --check index.js` — syntax clean
- `Config['~standard'].validate({...})` and `.validate(null)` — returns `{value}`, never throws
- Live scan against LM Studio on `127.0.0.1:1234` — detected vendor, `loadedContext: 32768`,
  `maxContext: 262144`, tool calling `true`
- Installed bundle reports `application: applied`, and both tools appear in the
  agent's tool list with correct schemas

## Not yet verified

- The `local_llm_register` write path against the real `configEditor`. It was
  exercised against a stub, not the live service, because writing a provider
  config mid-session changes profile state. `dryRun: true` shows the exact
  config that would be written.
- Display metadata and icon rendering in Plugin Manager. Installation succeeded;
  the rendered card was not inspected.
