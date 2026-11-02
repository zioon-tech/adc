# Getting Started

Use this procedure when the user asks to start using ADC, register, install the CLI, connect a
device or authorize this Agent. Match the user's language and explain only the next missing step.
The official service is `https://adc.zioon.tech`; use a different origin when the user selects
their own installation. Do not silently move an existing connection to another service.

## 1. Inspect The CLI

Run `adc --version` and `adc status --json`. If `adc` is not on PATH, check the documented
user-level launcher before downloading anything:

- macOS/Linux — `~/.local/bin/adc`
- Windows — `%LOCALAPPDATA%\AgentDeviceCloud\bin\adc.cmd`

If the CLI is missing and installation is requested, use the official installer in CLI-only mode.
It includes its own runtime; Node.js and a source checkout are not required to run ADC.

macOS or glibc Linux:

```sh
curl -fsSL https://adc.zioon.tech/downloads/node/install.sh | sh -s -- --cli-only
export PATH="$HOME/.local/bin:$PATH"
adc --version
adc status --json
```

Windows PowerShell:

```powershell
$p = Join-Path $env:TEMP ('adc-install-' + [guid]::NewGuid().ToString('N') + '.ps1')
try {
  Invoke-WebRequest -UseBasicParsing -Uri https://adc.zioon.tech/downloads/node/install.ps1 -OutFile $p
  & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $p -CliOnly
  if ($LASTEXITCODE -ne 0) { throw "ADC installation failed." }
} finally {
  Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
}
$env:PATH = (Join-Path $env:LOCALAPPDATA 'AgentDeviceCloud\bin') + ';' + $env:PATH
adc --version
adc status --json
```

CLI-only installation does not pair this computer or start a Connector. Use the installer's
reported launcher if the user overrides installation paths. For self-hosting, substitute the
selected origin and pass `--download-url ORIGIN/downloads/node` or `-DownloadUrl` explicitly.
If the CLI exists but is incompatible, explain the required version and follow the update
procedure in the account-management reference.

If `connection.authenticated` is true, go straight to device and tool discovery in `SKILL.md`.
Owner login is unnecessary for ordinary tool work.

## 2. Let The User Sign In Or Register

For authorized setup, run:

```sh
adc login --url https://adc.zioon.tech
```

Give the user the CLI's browser URL and short-lived code. Keep the pending process alive while
the user signs in and confirms the code; use `--no-open` if this host cannot open a browser.
Do not repeat login while the existing attempt is pending.

New users choose **Create account** on that login page, or register at
`https://adc.zioon.tech/register`. GitHub and email sign-in use the same CLI confirmation flow.
The user enters their credentials and completes email verification when required. Never ask
for or enter their password, retrieve their mail, or confirm the browser code on their behalf.
After confirmation, run `adc status --json` and require `login.authenticated: true`.
This owner session manages devices and access; it does not authorize device tool invocation.

## 3. Reuse Or Pair The Selected Device

Inspect existing resources:

```sh
adc device list --json
adc access list --json
adc connection list --json
```

Reuse an appropriate existing device and access. When a choice is missing, ask which device and
folder the user wants to connect. A device can be the user's computer, another computer or an
Android phone; installing a Skill on an Agent host does not make that host a device automatically.

For a new desktop device, generate its installation command with the correct target platform:

```sh
adc device add --name "Work Mac" --platform unix --ttl 600 --access none --json
```

Use `--platform windows` for native Windows or `--platform wsl` for WSL. Give the returned
`installCommand` to the user to run on that device; execute it locally only when the user has
authorized pairing this computer and starting its Connector. Do not substitute a device name or
platform the user did not select. For Android, guide the user through the official APK download
and pairing screen at `https://adc.zioon.tech/docs/quickstart` instead of a desktop installer.

Wait for the same named desktop device:

```sh
adc device wait "Work Mac" --timeout 120 --json
adc device show "Work Mac" --json
```

If desktop access was set to `none`, have the user expose their chosen folder on that device.
For a requested read-only folder, run locally:

```sh
adc-node roots add "/Users/me/work/project" --read-only
adc-node roots list
```

Substitute the actual folder selected by the user. Windows Connector commands accept native
local paths; use the advertised POSIX path returned by `adc device show` in cloud commands.
Never alter local Connector settings through remote `shell.exec`.

## 4. Connect This Agent

Use existing access if it matches the intended device, folder and capabilities. Otherwise,
create access for the explicitly selected scope. A first file-reading workflow can use:

```sh
adc access create --name "Repository reader" \
  --devices "Work Mac" --folders "/Users/me/work/project" \
  --capabilities read --approval never --json
adc connect "Repository reader" --name "Agent workspace" --expires 30 --json
adc status --json
```

Choose unique user-facing names and replace the example scope with discovered values.
`adc connect` stores the scoped credential; do not read or print its private storage.
Require `connection.authenticated: true`. Add write or execution only when the user requests
that workflow; never broaden access to recover from a denial.

## 5. Verify And Continue

Return to the normal workflow in `SKILL.md`: discover online devices, list tools, inspect the
selected tool's current schema, then make a read-only call such as `file.list` within the chosen
folder with `--source skill --wait 4000 --json`. Follow the task state machine until there is
a verified result. If the device is offline or no matching tool is available, state the missing
condition rather than claiming setup succeeded.

Report the connected device and authorized folder, then continue the user's requested task.
On later use, reuse the scoped connection, discover current capabilities and apply the invocation
reference. Read the account-management reference only for pairing, access, connections, audit,
updates or local Connector changes.
