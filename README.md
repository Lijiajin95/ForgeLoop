# ForgeLoop

English | [简体中文](README.zh-CN.md)

**Multi-agent software development and operations, built on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).**

ForgeLoop aims to help people who need software but do not work in software engineering turn business goals into running applications. Customers define the goals and authorization boundaries; agents handle routine engineering and bring exceptions back for a human decision. Requirements, changes, verification results, and delivery evidence remain traceable throughout the process.

> **Early development.** ForgeLoop has a native TypeScript plugin foundation. The complete autonomous development, deployment, and operations workflow is still being built and validated. Product goals are not claims of completed capability.

## What ForgeLoop is building

- **A path from requirements to running software.** Coordinate analysis, technical planning, implementation, independent verification, release, and checks in the running environment.
- **Clear customer decisions.** Escalate conflicting goals, changes to authorization boundaries, major architecture changes, and other defined exceptions with evidence and understandable options.
- **Delivery you can inspect.** Connect each requirement to its tasks, candidate changes, test results, review findings, and release artifacts.
- **Continuous improvement.** Turn authorized operational feedback into recovery work and follow-up development requirements.

The intended workflow is:

```text
Requirements → Analysis & planning → Implementation → Independent verification
             → Business acceptance → Deployment → Checks in the running environment
```

The first use case is ForgeLoop itself: build a usable seed, use it for real improvements, and measure how much external help each iteration requires. Development and operations are assessed separately; the long-term target is less than 10% human intervention in each, not a result already achieved.

## Built for DeepSeek Harness

DSH is the only persistent host. It provides sessions, model access, tools, UI integration, and process lifecycle services. ForgeLoop adds the software delivery workflow and its business records.

| Layer | Responsibility |
| --- | --- |
| DSH host | Sessions, models, tools, permissions, and plugin UI integration |
| ForgeLoop domain | Requirements, task plans, authorization, failure accounting, and delivery rules |
| ForgeLoop runtime | Durable coordination, Agent execution, workspaces, review, and formal test execution |
| Records and evidence | SQLite business records; files for diffs, logs, reports, and candidate artifacts |

The active implementation lives in [`packages/forgeloop`](packages/forgeloop). It uses TypeScript and Node's built-in SQLite support. ForgeLoop does not require a separate persistent backend.

The target design defines three roles: **Requirements Agent**, **Development Agent**, and **Verification Agent**. The Verification Agent is now implemented with two enforced gates: a pre-implementation review that must pass before approval, and an independent verification whose evidence must pass before acceptance. These are in-process Agent sessions with runtime checks, not OS-level role isolation. See the [architecture](docs/architecture.md) and [product plan](docs/product.md) for the distinction.

A first-version **Operations Agent** is also in place: registered resource checks and a small catalog of recovery actions, a tool-free diagnosis session, recovery actions executed only with catalog or owner authorization and re-checked afterwards, and linked fix requirements when a diagnosis calls for permanent repair. Actions run in the host account with no OS isolation, and online incidents have not been exercised yet — see the [operations design](docs/ops-agent.md).

## Current foundation and priorities

The repository includes versioned requirements and task plans, snapshot workspaces, candidate diffs, pre-implementation plan review, independent verification, independent diff review, formal test execution, durable requests, and evidence records. DSH tools and a web board expose project information.

Some workflow operations remain internal, and availability depends on the revision being used. A successful tool call, test run, or package installation does not by itself prove complete delivery. The [status record](docs/status.md) documents implementation, actual validation, and known gaps.

Current priorities are:

1. **A usable DSH workbench:** unified navigation, requirement and task details, execution activity, errors, and evidence for everyday use and debugging.
2. **Controlled execution:** role permissions, reliable stopping and recovery, and consistent authorization and failure accounting at action boundaries.
3. **A verified delivery loop:** carry the same candidate through verification, controlled deployment, and checks of the running version.
4. **Real self-improvement:** record outcomes, failures, external intervention, and operational recovery before assessing autonomy.

## Development

Use Node.js, npm, and a DSH version compatible with the [workspace](package.json) and [plugin](packages/forgeloop/package.json) manifests. The first target environment is macOS.

```sh
git clone https://github.com/Lijiajin95/ForgeLoop.git
cd ForgeLoop
make setup       # Install dependencies
make check       # Type checking, architecture contracts, and behavior tests
make build       # Compile the plugin
make package     # Build a candidate tarball and artifact manifest
```

For installation, model configuration, and profile selection, follow the [deployment guide](docs/deployment.md) and [plugin guide](packages/forgeloop/README.md). `make verify-plugin` runs a real host/model smoke test and requires a separate test DSH home with working model authentication; see the deployment guide before running it.

## Documentation

Most detailed project documentation is currently in Chinese.

| Document | Contents |
| --- | --- |
| [Product and first-release plan](docs/product.md) | Goals, scope, design decisions, and validation rules |
| [Status and evidence](docs/status.md) | Implemented capabilities, checks, installation records, and known gaps |
| [Architecture](docs/architecture.md) | Current modules, persistence, and external interfaces |
| [Domain language](CONTEXT.md) | Business objects, identities, and lifecycle terminology |
| [Plugin guide](packages/forgeloop/README.md) | Plugin entry points and configuration |
| [Deployment guide](docs/deployment.md) | Installation, upgrades, validation, and recovery |
| [Documentation index](docs/README.md) | Design decisions and historical records |

## Contributing and license

Read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. Keep changes scoped, preserve ongoing work, and support critical behavior with tests and actual execution evidence.

A license for the code and documentation has not yet been selected. See [CONTRIBUTING.md](CONTRIBUTING.md) for the current distribution policy.
