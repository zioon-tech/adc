"""One-time, guarded repair of the inventoried ADC production download paths."""
import base64
import json
import os
import pathlib
import sys
import time

WORKFLOWS = pathlib.Path(__file__).resolve().parents[1] / ".production-workflows/scripts"
sys.path.insert(0, str(WORKFLOWS))
from cloud import python_command, request, rpc

BEFORE = """[Service]
Environment=ADC_CONSOLE_DIR=/srv/adc-console/current
ExecStart=
ExecStart=/usr/bin/env ADC_CONSOLE_DIR=/srv/adc-console/current /usr/local/bin/node --import tsx apps/control-plane/src/main.ts
"""
CONFIG = """[Service]
Environment=ADC_CONSOLE_DIR=/srv/adc-console/current ADC_NODE_RELEASE_DIR=/opt/agent-device-cloud/current/dist/node ADC_SKILL_RELEASE_DIR=/opt/agent-device-cloud/current/dist/skills ADC_PLUGIN_RELEASE_DIR=/opt/agent-device-cloud/current/dist/plugins
ExecStart=
ExecStart=/usr/bin/env ADC_CONSOLE_DIR=/srv/adc-console/current ADC_NODE_RELEASE_DIR=/opt/agent-device-cloud/current/dist/node ADC_SKILL_RELEASE_DIR=/opt/agent-device-cloud/current/dist/skills ADC_PLUGIN_RELEASE_DIR=/opt/agent-device-cloud/current/dist/plugins /usr/local/bin/node --import tsx apps/control-plane/src/main.ts
"""


def remote_source(check_only):
    source = (WORKFLOWS / "deploy.py").read_text()
    source += "\nCHECK_ONLY = " + repr(check_only)
    source += "\nBEFORE = " + repr(BEFORE.encode())
    source += "\nCONFIG = " + repr(CONFIG.encode()) + "\n"
    return source + """
root = pathlib.Path("/opt/agent-device-cloud")
unit = "agent-device-cloud.service"
drop = pathlib.Path("/etc/systemd/system/agent-device-cloud.service.d/40-product-release.conf")
expected_release = root / "releases/dc4be47385d9daf2ed816b22a0ae47f4f973bd58-41829701455"
hashes = {
    "skills/agent-device-cloud.zip": "10dad7dec974411f658f9157f4c6cf4d653683f7cd38cbc59f847ee521cfa6b9",
    "plugins/index.json": "578175a6562aafaebbd6f8fb7ac9df13e827859195c9d163104d8610f135c3b7",
}
variables = {
    "ADC_NODE_RELEASE_DIR": "node",
    "ADC_SKILL_RELEASE_DIR": "skills",
    "ADC_PLUGIN_RELEASE_DIR": "plugins",
}
legacy = "/opt/agent-device-cloud/releases/console-refinement-20261101/dist/"

def environment():
    pid = int(subprocess.check_output(
        ["systemctl", "show", unit, "-p", "MainPID", "--value"],
        universal_newlines=True).strip())
    if pid <= 0:
        raise RuntimeError("ADC has no main process")
    process = pathlib.Path("/proc") / str(pid)
    if os.path.realpath(str(process / "cwd")) != str(expected_release):
        raise RuntimeError("ADC process does not use the qualified release")
    arguments = [item.decode() for item in (process / "cmdline").read_bytes().split(b"\\0") if item]
    if arguments != ["/usr/local/bin/node", "--import", "tsx", "apps/control-plane/src/main.ts"]:
        raise RuntimeError("Unsupported ADC service entry point")
    result = {}
    for item in (process / "environ").read_bytes().split(b"\\0"):
        name, _, value = item.partition(b"=")
        if name.decode("utf-8", "replace") in variables:
            result[name.decode()] = value.decode()
    return result

def verify():
    ready(["http://127.0.0.1:8788/health"])
    expected = {key: str(root / "current/dist" / kind) for key, kind in variables.items()}
    if environment() != expected:
        raise RuntimeError("Effective download directories did not follow current")
    for path, checksum in hashes.items():
        with urllib.request.urlopen("http://127.0.0.1:8788/downloads/" + path, timeout=10) as response:
            if response.status != 200 or hashlib.sha256(response.read()).hexdigest() != checksum:
                raise RuntimeError("Published download does not match the qualified artifact")

def atomic_write(path, content):
    temporary = path.with_name(path.name + ".download-repair-next")
    with temporary.open("xb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(str(temporary), 0o644)
    os.replace(str(temporary), str(path))
    directory = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

with (root / ".deploy.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    pointer = root / "current"
    if not pointer.is_symlink() or pointer.resolve() != expected_release:
        raise RuntimeError("ADC current release changed; obtain a fresh inventory")
    manifest = json.loads((pointer / ".release-manifest.json").read_text())
    if (manifest.get("repository") != "zioon-tech/adc"
        or manifest.get("commit") != "dc4be47385d9daf2ed816b22a0ae47f4f973bd58"
        or str(manifest.get("ciRun")) != "41829701455"
        or manifest.get("component") != "service"):
        raise RuntimeError("Qualified release provenance changed")
    for path, checksum in hashes.items():
        if digest(pointer / "dist" / path) != checksum:
            raise RuntimeError("Qualified release distribution checksum mismatch")
    if not (pointer / "dist/node").is_dir():
        raise RuntimeError("Qualified node distribution is absent")
    if drop.is_symlink() or not drop.is_file():
        raise RuntimeError("Unsupported production drop-in")
    previous = drop.read_bytes()
    if previous == CONFIG:
        verify()
        print(json.dumps(dict(status="download_paths_already_repaired",
                              checkOnly=CHECK_ONLY, downloadsVerified=True)), flush=True)
    else:
        if previous != BEFORE:
            raise RuntimeError("Canonical drop-in has custom changes; reconcile before repair")
        if environment() != {key: legacy + kind for key, kind in variables.items()}:
            raise RuntimeError("Effective distribution overrides changed since inventory")
        ready(["http://127.0.0.1:8788/health"])
        if CHECK_ONLY:
            print(json.dumps(dict(status="download_paths_preflight_passed", checkOnly=True,
                                  release=str(expected_release), configSha256=hashlib.sha256(CONFIG).hexdigest(),
                                  qualifiedDownloadsVerified=True)), flush=True)
        else:
            backup = pathlib.Path("/var/backups/zioon-adc-download-paths-20261104")
            backup.mkdir(mode=0o700, exist_ok=True)
            saved = backup / "40-product-release.conf"
            if saved.exists():
                if saved.is_symlink() or saved.read_bytes() != previous:
                    raise RuntimeError("Existing repair backup differs; reconcile first")
            else:
                atomic_write(saved, previous)
            journal = root / "download-path-maintenance.jsonl"
            operation = dict(operation="repair_download_paths", release=str(expected_release),
                             backup=str(saved), configSha256=hashlib.sha256(CONFIG).hexdigest(),
                             timestamp=int(time.time()))
            def record(status):
                with journal.open("a") as stream:
                    stream.write(json.dumps(dict(operation, status=status)) + "\\n")
                    stream.flush()
                    os.fsync(stream.fileno())
            record("configuring")
            try:
                atomic_write(drop, CONFIG)
                subprocess.check_call(["systemctl", "daemon-reload"])
                subprocess.check_call(["systemctl", "restart", unit])
                verify()
                record("repaired")
            except BaseException:
                atomic_write(drop, previous)
                subprocess.check_call(["systemctl", "daemon-reload"])
                subprocess.check_call(["systemctl", "restart", unit])
                try:
                    ready(["http://127.0.0.1:8788/health"])
                    if environment() != {key: legacy + kind for key, kind in variables.items()}:
                        raise RuntimeError("Rollback effective directories mismatch")
                    record("rolled_back")
                except BaseException:
                    record("rollback_failed")
                    raise
                raise
            print(json.dumps(dict(operation, status="download_paths_repaired",
                                  restartedServices=[unit], httpReadinessPassed=True,
                                  downloadsVerified=True, configurationBackupVerified=True)), flush=True)
"""


def main():
    if os.environ["GITHUB_REPOSITORY"] != "zioon-tech/adc" or os.environ["GITHUB_REF"] != "refs/heads/main":
        raise RuntimeError("Production repair must run from ADC main")
    raw = os.environ["CHECK_ONLY"]
    if raw not in ("true", "false"):
        raise ValueError("check-only must be an explicit boolean")
    command = python_command(remote_source(raw == "true"))
    oidc = json.loads(request(
        os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=sts.aliyuncs.com",
        headers={"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]},
    ))["value"]
    credentials = rpc("sts.cn-shanghai.aliyuncs.com", "2015-04-01", "AssumeRoleWithOIDC", dict(
        RoleArn=os.environ["DEPLOY_ROLE_ARN"], OIDCProviderArn=os.environ["DEPLOY_OIDC_PROVIDER_ARN"],
        OIDCToken=oidc, RoleSessionName="download-repair-" + os.environ["GITHUB_RUN_ID"],
        DurationSeconds=3600,
    ))["Credentials"]
    result = rpc("ecs.cn-shanghai.aliyuncs.com", "2014-05-26", "RunCommand", dict(
        RegionId="cn-shanghai", **{"InstanceId.1": os.environ["DEPLOY_INSTANCE_ID"]},
        CommandContent=base64.b64encode(command.encode()).decode(), ContentEncoding="Base64",
        Type="RunShellScript", Name="adc-download-repair-" + os.environ["GITHUB_RUN_ID"],
        Timeout=600, KeepCommand="false",
    ), credentials)
    invocation = result["InvokeId"]
    print(json.dumps(dict(invocationId=invocation, operation="repair_download_paths",
                          checkOnly=raw == "true")), flush=True)
    for _ in range(200):
        response = rpc("ecs.cn-shanghai.aliyuncs.com", "2014-05-26", "DescribeInvocationResults", dict(
            RegionId="cn-shanghai", InvokeId=invocation, InstanceId=os.environ["DEPLOY_INSTANCE_ID"],
            ContentEncoding="PlainText",
        ), credentials)
        rows = response.get("Invocation", {}).get("InvocationResults", {}).get("InvocationResult", [])
        if rows and rows[0]["InvocationStatus"] in ("Success", "Failed", "Stopped", "PartialFailed", "Finished"):
            outcome = rows[0]
            print(outcome.get("Output", ""), flush=True)
            if outcome["InvocationStatus"] != "Success" or int(outcome["ExitCode"]) != 0:
                raise RuntimeError("Download repair failed; inspect invocation " + invocation)
            return
        time.sleep(3)
    raise RuntimeError("Repair outcome unknown; inspect invocation " + invocation + " before retrying")


if __name__ == "__main__":
    main()
