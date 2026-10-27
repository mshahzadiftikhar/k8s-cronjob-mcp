# Publishing to npm

Publishing is public and permanent: a version number can never be reused or fully removed (it can only be deprecated). Work through this in order, and stop at the dry run if anything looks wrong.

## 0. Decide the name (once)

`package.json` currently says `k8-cronjob-mcp`, while the README and examples use `k8s-cronjob-mcp`. Pick one and use it everywhere (`package.json` `name`, `bin`, README commands, Dockerfile tag). A scoped name such as `@your-npm-username/k8s-cronjob-mcp` cannot be squatted and shows who made it.

Check it is free:

```bash
npm view <name> name   # E404 means it is available
```

## 1. One-time `package.json` fixes

Add these fields. Without `files`, the tarball includes tests, scripts and demo manifests.

```json
{
  "description": "Read-only MCP server that finds Kubernetes CronJobs failing silently",
  "keywords": ["mcp", "model-context-protocol", "kubernetes", "k8s", "cronjob", "monitoring"],
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/<you>/<repo>.git" },
  "files": ["dist", "deploy/rbac.yaml", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" }
}
```

- Add a `LICENSE` file matching the `license` field.
- `publishConfig.access` is required for scoped names (they default to private); it is harmless otherwise.
- `bin` must point at `dist/index.js`, which already starts with `#!/usr/bin/env node`.

## 2. Verify before publishing

```bash
npm run typecheck && npm test      # unit tests
npm run demo:up && npm run check:rbac && npm run test:integration   # optional but recommended
npm pack --dry-run                 # confirm only dist/, rbac.yaml, README, LICENSE are listed
```

Test the real tarball the way users will run it:

```bash
npm run build && npm pack          # creates <name>-<version>.tgz
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | (cat; sleep 3) | npx -y ./<name>-<version>.tgz
```

You should see all four tools listed. Delete the `.tgz` afterwards.

## 3. Log in

```bash
npm login
npm whoami
```

Enable two-factor authentication on the npm account (use "authorization and publishing" mode); npm will prompt for a one-time code when you publish.

## 4. Version and publish

```bash
npm version 0.1.0 --no-git-tag-version   # or patch / minor / major for later releases
npm publish                              # `prepublishOnly` rebuilds dist/ first
```

First release of a scoped package: `npm publish --access public`.

If it goes wrong within 72 hours, `npm unpublish <name>@<version>` is possible; after that, use `npm deprecate <name>@<version> "reason"` and publish a fixed version.

## 5. Check the published package

```bash
npm view <name> version dist.tarball
claude mcp add k8s-cronjobs --env K8S_CONTEXT=<your-context> -- npx -y <name>
claude mcp list
```

Pin a version in shared configs: `npx -y <name>@0.1.0`.

## 6. Releasing updates

1. Make the change, run `npm test`.
2. Bump with `npm version patch|minor|major`.
3. `npm publish`.
4. Tag the commit and note the changes (a changelog or GitHub release).

Use a new minor version when you add a tool or an input, and a major version when you rename or remove a tool or change an output shape, because agents and saved prompts depend on them.

## Optional

- **Docker image.** Tag and push (`docker build -t <registry>/<name>:0.1.0 .`) if you want users to run it as a container.
- **MCP directories.** Some MCP registries and directories list community servers; check their submission steps once the package is live.
- **CI publishing.** For automated releases, publish from CI with an npm automation token and `npm publish --provenance`, which links the package to its source build.
