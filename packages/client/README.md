# @adc/client

Typed client for the [Agent Device Cloud](https://github.com/zioon-tech/adc)
Control Plane API. One contract across HTTP, CLI, MCP and SDK.

## Install

```sh
# Read the versioned package URL from the official download manifest.
SDK_FILE=$(curl -fsSL https://adc.zioon.tech/downloads/sdk/manifest.json |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).archive.file))')
npm install "https://adc.zioon.tech/downloads/sdk/$SDK_FILE"
```

The release includes compiled JavaScript, TypeScript declarations, the ADC protocol
and Zod. Installation needs no private registry or separate `@adc/protocol` package.
The public npm package name is not currently a supported installation source.

## Usage

### Node client

```ts
import { AdcClient, buildInvocation } from "@adc/client";

const client = new AdcClient(
  "https://devices.example.com",
  process.env.ADC_ACCESS_KEY!, // Agent access key or owner PAT
  fetch // optional, defaults to global fetch
);

// Agent scope: one call returns grant + authorized nodes (with root paths
// and descriptions) + tool-to-node mapping.
const me = await client.me();
if (me.kind === "agent") {
  const invocation = buildInvocation({
    context: me.context,
    tool: "file.read",
    args: { absolutePath: "/workspace/README.md" },
    source: "sdk",
    intent: "Read the project setup instructions"
    // For an active screen control session, also pass controlSessionId.
  });
  const result = await client.invoke(invocation);
}

// Owner scope (owner PAT or session credential)
const nodes = await client.listNodes();
await client.updateNode(nodes[0]!.nodeId, {
  revision: nodes[0]!.revision ?? 1,
  label: "MacBook Pro",
  description: "主力本机 · M2 Pro / 32G",
  accessPolicy: nodes[0]!.accessPolicy ?? { rootAccess: "all", rootIds: [], readOnlyRootIds: [] }
});
const approvals = await client.listApprovalsPage({ status: "pending" });
```

The client currently uses Node crypto; use a bundler with the required adaptation
for other runtimes.

### Node-only device protocol

```ts
import { NodeApiClient, generateNodeKeyPair } from "@adc/client/node";
```

`@adc/client/node` carries the Ed25519-signed Connector protocol and requires
Node built-ins. Use it from the `adc-node` daemon; never from a browser.

## Authentication boundaries

- **Agent access key** — `adc connect` credential, scoped to one grant: inspect
  `/me`, submit invocations, poll tasks.
- **Owner PAT** — `adc pat create`, account-level management identity, optional
  `readOnly`. Cross-origin friendly (no cookies involved).
- **Session** — console cookie / CLI management session.

Tokens are shown once at creation; the server stores only a SHA-256 hash.
