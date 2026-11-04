"""Read-only production disk and release inventory through audited GitHub OIDC."""
import base64
import json
import os
import pathlib
import sys
import time

WORKFLOWS = pathlib.Path(__file__).resolve().parents[1] / ".production-workflows/scripts"
sys.path.insert(0, str(WORKFLOWS))
from cloud import python_command, request, rpc


def remote_source():
    if os.environ.get("INVENTORY_KIND") == "downloads":
        return """
import hashlib, json, os, pathlib, subprocess, urllib.request
root = pathlib.Path("/opt/agent-device-cloud")
pid = int(subprocess.check_output(
    ["systemctl", "show", "agent-device-cloud.service", "-p", "MainPID", "--value"],
    universal_newlines=True).strip())
if pid <= 0:
    raise RuntimeError("ADC service has no running main process")
process = pathlib.Path("/proc") / str(pid)
keys = ("ADC_SKILL_RELEASE_DIR", "ADC_PLUGIN_RELEASE_DIR",
        "ADC_NODE_RELEASE_DIR", "ADC_ANDROID_RELEASE_DIR", "ADC_CONSOLE_DIR")
environment = {}
for item in (process / "environ").read_bytes().split(b"\\0"):
    name, _, value = item.partition(b"=")
    if name.decode("utf-8", "replace") in keys:
        environment[name.decode()] = value.decode("utf-8", "replace")
arguments = [item.decode("utf-8", "replace")
             for item in (process / "cmdline").read_bytes().split(b"\\0") if item]
release = json.loads((root / "current/.release-manifest.json").read_text())
distributions = {}
for kind, variable in (("skills", "ADC_SKILL_RELEASE_DIR"), ("plugins", "ADC_PLUGIN_RELEASE_DIR")):
    directory = pathlib.Path(environment.get(variable, str(root / "current/dist" / kind)))
    row = dict(directory=str(directory), resolvedDirectory=str(directory.resolve()))
    index = directory / "index.json"
    if index.is_file():
        raw = index.read_bytes()
        row["indexSha256"] = hashlib.sha256(raw).hexdigest()
        row["version"] = json.loads(raw).get("version")
    distributions[kind] = row
with urllib.request.urlopen("http://127.0.0.1:8788/downloads/plugins/index.json", timeout=5) as response:
    raw = response.read()
    served = dict(version=json.loads(raw)["version"], sha256=hashlib.sha256(raw).hexdigest())
print(json.dumps(dict(
    status="production_download_inventory", readOnly=True,
    currentRelease=str((root / "current").resolve()), processCwd=os.path.realpath(str(process / "cwd")),
    supportedEntryPoint=arguments == ["/usr/local/bin/node", "--import", "tsx", "apps/control-plane/src/main.ts"],
    release={key: release.get(key) for key in ("repository", "commit", "ciRun", "component")},
    distributionEnvironment=environment, distributions=distributions, servedPlugins=served,
)), flush=True)
"""
    source = (WORKFLOWS / "disk.py").read_text() + "\n" + (WORKFLOWS / "retire.py").read_text()
    source += """
root = pathlib.Path("/opt/agent-device-cloud")
usage = shutil.disk_usage(str(root))
bases = list(RETIRED_BUILDS) + [
    "/opt/agent-device-cloud/releases/87489f74762bae0456f412774bf649eb4ddeb8ec-41686300466",
    "/opt/agent-device-cloud/backups/console-refinement-20261101",
    "/opt/agent-device-cloud/backups/root-sharing-20261101",
    "/opt/agent-device-cloud/backups/collaboration-20261031",
]
references = build_references(bases)
dependencies = []
for base in bases:
    try:
        paths = retired_dependencies(base)
        size = disk_command(["du", "-x", "-s", "-B1", *paths]) if paths else None
        dependencies.append(dict(base=base, paths=paths, references=references[base], sizes=size))
    except RuntimeError as error:
        dependencies.append(dict(base=base, validationError=str(error)))
pointers = {}
journals = {}
for parent in [pathlib.Path("/opt"), pathlib.Path("/srv")]:
    for path in parent.glob("*/current"):
        if path.is_symlink():
            pointers[str(path)] = str(path.resolve())
    for path in parent.glob("*/deployments.jsonl"):
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        journals[str(path)] = [
            {key: row[key] for key in ["release", "previous", "status", "commit", "ciRun", "timestamp"]
             if key in row}
            for row in rows[-2:]
        ]
print(json.dumps(dict(
    status="production_inventory", readOnly=True, freeBytes=usage.free,
    usedBytes=usage.used, totalBytes=usage.total,
    filesystems=disk_command(["df", "-B1", "-T"]),
    wholeDisk=disk_sizes("/", 2),
    varLib=disk_sizes("/var/lib", 3),
    releaseRoot=disk_sizes(root, 3),
    backups=disk_sizes(root / "backups", 4, 16),
    rootPackageStore=disk_sizes("/root/.local/share/pnpm", 5, 16),
    docker=disk_command(["docker", "system", "df"]),
    dependencies=dependencies, currentPointers=pointers, journals=journals,
)), flush=True)
"""
    return source


def main():
    if os.environ["GITHUB_REPOSITORY"] != "zioon-tech/adc" or os.environ["GITHUB_REF"] != "refs/heads/main":
        raise RuntimeError("Production inventory must run from ADC main")
    command = python_command(remote_source())
    oidc = json.loads(request(
        os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=sts.aliyuncs.com",
        headers={"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]},
    ))["value"]
    credentials = rpc("sts.cn-shanghai.aliyuncs.com", "2015-04-01", "AssumeRoleWithOIDC", dict(
        RoleArn=os.environ["DEPLOY_ROLE_ARN"], OIDCProviderArn=os.environ["DEPLOY_OIDC_PROVIDER_ARN"],
        OIDCToken=oidc, RoleSessionName="inventory-" + os.environ["GITHUB_RUN_ID"], DurationSeconds=3600,
    ))["Credentials"]
    response = rpc("ecs.cn-shanghai.aliyuncs.com", "2014-05-26", "RunCommand", dict(
        RegionId="cn-shanghai", **{"InstanceId.1": os.environ["DEPLOY_INSTANCE_ID"]},
        CommandContent=base64.b64encode(command.encode()).decode(), ContentEncoding="Base64",
        Type="RunShellScript", Name="adc-production-inventory-" + os.environ["GITHUB_RUN_ID"],
        Timeout=600, KeepCommand="false",
    ), credentials)
    invocation = response["InvokeId"]
    print(json.dumps(dict(invocationId=invocation, operation="production_inventory", readOnly=True)), flush=True)
    for _ in range(200):
        result = rpc("ecs.cn-shanghai.aliyuncs.com", "2014-05-26", "DescribeInvocationResults", dict(
            RegionId="cn-shanghai", InvokeId=invocation, InstanceId=os.environ["DEPLOY_INSTANCE_ID"],
            ContentEncoding="PlainText",
        ), credentials)
        rows = result.get("Invocation", {}).get("InvocationResults", {}).get("InvocationResult", [])
        if rows and rows[0]["InvocationStatus"] in ("Success", "Failed", "Stopped", "PartialFailed", "Finished"):
            outcome = rows[0]
            print(outcome.get("Output", ""), flush=True)
            if outcome["InvocationStatus"] != "Success" or int(outcome["ExitCode"]) != 0:
                raise RuntimeError("Inventory failed; inspect invocation " + invocation)
            return
        time.sleep(3)
    raise RuntimeError("Inventory outcome unknown; inspect invocation " + invocation + " before retrying")


if __name__ == "__main__":
    main()
