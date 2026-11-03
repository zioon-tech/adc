# Product direction

## Positioning

Agent Device Cloud is device connectivity and tool-routing infrastructure for AI agents.

It separates where an Agent runs from where its tools execute. An Agent can discover and use
authorized capabilities on several computers, servers or phones; multiple authorized Agents can
reuse a device through independent grants. The Agent or its Runtime calls the model, plans the task
and supplies tool arguments. ADC does not call a model to generate commands or coordinate business
workflows.

A lightweight control plane handles discovery, identity, policy, placement, approvals, task state
and evidence. The selected device remains the execution environment and the final authorization
boundary. A target computer needs the Connector and its task dependencies, not another conversational
Agent or model account. Supported surfaces include macOS, Linux and Windows connectors, Android
capabilities and registered local MCP Providers.

macOS and Linux connectors are available. Windows Node and Android Node are currently in testing;
installation, system/phone compatibility and runtime reliability remain under validation. The
presence of an installer or an individual verified capability is not a broad production claim.

The product is not a hosted shell, public compute marketplace, chat application, generic RPA system
or network tunnel.

## The problem

Useful work context already exists on machines users control:

- source repositories, dependencies and configured development tools;
- home servers, NAS devices, GPU workstations and private services;
- local credentials, VPN access and environments that are expensive or unsafe to reproduce;
- files and workflows that should not be copied wholesale into every Agent provider.

Agents increasingly run somewhere else: an MCP host, browser, IDE, mobile client, scheduled job or
third-party platform. Connecting these environments requires a maintained way to reach the device,
discover its tools, select a target, manage authorization and track results. Existing SSH, private
networking and task systems can supply these capabilities too.

ADC packages this device service behind a shared contract for MCP, CLI, Skill, plugins, SDK and HTTP.
Authorization and receipts support the connection; they are not the entire product positioning.

For a cloud personal Agent, the device layer is necessary when a task must happen on the user's
actual machine rather than in a cloud sandbox or online service. Its own shell has no authority over
that machine. ADC supplies device discovery, scoped access, remote tool invocation and result
handling as a reusable service. Agent vendors may also provide equivalent connectivity internally;
the need for this layer is distinct from choosing one particular vendor.

## Initial audience

### Individual developers

Continue work on an existing repository from another Agent interface, apply a focused change and run
the project's real test command on the machine where the environment already works.

### Cloud and personal Agent users

Use a home or work computer, private server or supported phone capability from an Agent running
elsewhere. A phone chat interface does not itself provide local computer access. The user's Agent
needs a supported ADC integration, and the execution device needs a Connector and its task
dependencies.

### Self-hosters and technical operators

Expose narrowly selected folders or command templates from a home server, NAS or private workstation
without opening an inbound service on that device.

### Agent and tool builders

Integrate device capability through MCP, CLI, Skill, SDK or HTTP while relying on one versioned Tool
IR and one set of authorization and failure semantics.

### Teams with distributed environments

Share devices with named people or a team and set per-member device policies. Each caller authorizes
their own Agent. This enables reuse of existing environments without requiring another Agent on
every target. Business workflow coordination still belongs to the Agent and application.

Enterprise SSO and broader device integrations remain later expansions. Existing team and named
sharing workflows are documented in [collaboration.md](collaboration.md).

## Product contract

1. **Execution is local.** The Control Plane never runs the user's device tools.
2. **Connections are outbound.** A Node does not require an inbound public port.
3. **Authorization is an intersection.** Account, Agent, device, folder and capability policy must
   all permit an operation.
4. **The device has final authority.** Cloud policy can narrow locally exposed access, never expand
   it.
5. **Side effects leave evidence.** Mutating operations require idempotency and produce a durable
   receipt.
6. **Failure is explicit.** Denied, approval-required, offline, cancelled and unknown outcomes remain
   distinct states.
7. **Interfaces do not create new authority.** MCP, CLI, Skill, SDK and HTTP use the same
   authorization, dispatch and receipt path.
8. **Hosted and self-hosted are the same product.** Deployment choice does not remove identity,
   authorization or audit controls.

## Data contract

The Control Plane stores account and device metadata, disclosed absolute path names, grants,
invocation arguments, returned results, uploaded artifacts, policy decisions and receipts. Operators
must protect and retain this data accordingly.

The device private key, unrequested files and local environment remain on the device. The Control
Plane does not proactively crawl or mirror a filesystem. An authorized tool result can still contain
sensitive content; output redaction is a best-effort safeguard, not a confidentiality guarantee.

## Core scenarios

| Scenario                   | User outcome                                                        | Typical capability                         |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| Continue local development | Inspect, edit and test an existing checkout                         | `file.read`, `file.patch`, `test.run`      |
| Use private infrastructure | Execute approved work where private resources are already available | `file.search`, `command.template.run`      |
| Move across interfaces     | Start from MCP, CLI, Skill or SDK without changing policy semantics | shared authorization and invocation model  |
| Controlled automation      | Run repeatable work with explicit boundaries and evidence           | templates, approval, idempotency, receipts |

## Architecture

```text
Agent / MCP host / CLI / Skill / SDK
                 |
                 | HTTPS + scoped Agent identity
                 v
Control Plane
  identity -> authorization -> placement -> approval -> dispatch -> audit
                 |
                 | outbound WebSocket wake + signed poll/ACK/lease/receipt
                 v
Device Connector
                 |
                 v
Local Tool Runtime
  path validation -> local policy -> execution -> durable receipt
```

PostgreSQL deliberately provides identity state, durable dispatch, approvals and audit in one
transaction boundary. A separate broker is introduced only after measured contention or
multi-region requirements justify the additional consistency model.

## Differentiated choices

- **Reusable device service:** structured tools, shell execution and local MCP tools share discovery,
  device selection, authorization and result handling. Shell is an explicit capability. Checking its
  working directory and recording a receipt do not create operating-system process isolation.
- **Device-first authorization:** users expose resources locally before cloud grants can reference
  them.
- **Readable resources:** public operations use device ID plus absolute path so authorization and
  audit are understandable; internal root IDs remain compatibility bindings.
- **Honest delivery semantics:** dispatch is at-least-once. A crash window that cannot be reconciled
  becomes `unknown_outcome`, never an invented success or automatic duplicate.
- **No Agent lock-in:** each adapter submits the same governed invocation and receives the same
  Result and Receipt model.
- **Model-selected, system-constrained targets:** MCP exposes each logical tool once and restricts
  its target choices to granted devices that advertise that capability. The model selects the Node;
  the Control Plane validates the combination again before dispatch.
- **Local MCP composition:** a Connector can discover arbitrary stdio or Streamable HTTP MCP tools,
  advertise a schema-versioned logical ID and forward calls on the selected device. Provider secrets
  remain local, while registration and Agent authorization stay separate.
- **No deployment-tier security split:** self-hosted installations retain the complete account and
  authorization model.

## Roadmap

### Available now

- Personal account isolation, email/password and GitHub authentication.
- macOS and glibc Linux connectors for arm64 and x64.
- Windows x64 Connector and manually installed Android Mobile Node, both in testing.
- Local none, selected-folder, home and full-device access modes.
- Device policy, scoped Agent grants, approvals, audit and durable receipts.
- MCP OAuth, expiring Agent tokens, CLI, SDK and official Skill.
- Docker Compose self-hosting with PostgreSQL and Caddy.
- Official hosted service at `https://adc.zioon.tech`.
- Teams, member device policies and named device sharing.
- Linux-container isolation for shared work, with explicit prerequisites and discarded workspace
  writes.

### Next: reliability and operations

- Validate Windows and Android compatibility and runtime reliability.
- Signed release packages and unattended Connector updates.
- Keychain and keyring-backed device identity.
- External artifact storage, account quotas and retention jobs.
- Automated diagnostics, backup verification and restore workflows.
- Named MCP client interoperability testing and compatibility documentation.
- Operational SLOs, alerting and a hosted service status page.

### Later: enterprise features and broader devices

- Enterprise SSO, SCIM and SIEM export.
- Additional local executors, a Tool plugin SDK and a community Skill ecosystem.

Different Node platforms can contribute distinct capabilities to one workflow: Mac repositories,
Linux build or GPU programs, Windows local tools, and Android app actions. Household equipment,
printers, watches and laboratory instruments are exploration directions. They need actual
connectors or local tool integrations, observable results and authorization before being described
as supported devices.

Roadmap entries are direction, not shipped capability. Current behavior and known limits remain
authoritative in [implementation-status.md](implementation-status.md).

## Public documentation standard

The homepage should orient a visitor quickly, but documentation must supply enough explanation to
support a real decision and task. Product introductions explain why the device service exists and
where Agent, ADC and Connector responsibilities differ. Guides include prerequisites, actual
configuration, commands, results and common failures. References distinguish each tool's behavior
instead of repeating one description across a group. Engineering articles explain a concrete
problem, design choice and tradeoffs; release notes describe shipped changes and user actions.

Do not publish unsupported competitive claims, imply that structured shell calls provide a sandbox,
or turn internal website/SEO work into primary product news. Examples are illustrative unless backed
by a recorded execution, and future device categories must be labeled as direction rather than
current support.

## Security assurance goals

These are ongoing assurance goals. Completed checks and remaining gaps are recorded in
[implementation-status.md](implementation-status.md):

- source history in a dedicated repository with reviewable releases;
- published checksums, signatures and an SBOM for every client artifact;
- a maintained threat model and private vulnerability reporting channel;
- reproducible integration tests across every supported operating system and architecture;
- documented data retention, deletion, backup and incident-response behavior;
- external security review;
- an honest compatibility matrix for named MCP clients;
- public changelog, migration notes and support policy.

## Success criteria

The product is working when a new user can connect one device and complete a governed Agent tool call
in under ten minutes, understand exactly why it was allowed, find its receipt, revoke access without
re-pairing and diagnose an offline device without reading server source code.
