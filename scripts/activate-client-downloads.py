"""Activate independently deployed, qualified CLI/SDK files with guarded rollback."""
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
Environment=ADC_CONSOLE_DIR=/srv/adc-console/current ADC_SKILL_RELEASE_DIR=/opt/agent-device-cloud/current/dist/skills ADC_PLUGIN_RELEASE_DIR=/opt/agent-device-cloud/current/dist/plugins
ExecStart=
ExecStart=/usr/bin/env ADC_CONSOLE_DIR=/srv/adc-console/current ADC_SKILL_RELEASE_DIR=/opt/agent-device-cloud/current/dist/skills ADC_PLUGIN_RELEASE_DIR=/opt/agent-device-cloud/current/dist/plugins /usr/local/bin/node --import tsx apps/control-plane/src/main.ts
"""
CONFIG = """[Service]
Environment=ADC_CONSOLE_DIR=/srv/adc-console/current ADC_SKILL_RELEASE_DIR=/opt/agent-device-cloud/current/dist/skills ADC_PLUGIN_RELEASE_DIR=/opt/agent-device-cloud/current/dist/plugins ADC_NODE_RELEASE_DIR=/srv/adc-client-tools/current/node ADC_SDK_RELEASE_DIR=/srv/adc-client-tools/current/sdk
ExecStart=
ExecStart=/usr/bin/env ADC_CONSOLE_DIR=/srv/adc-console/current ADC_SKILL_RELEASE_DIR=/opt/agent-device-cloud/current/dist/skills ADC_PLUGIN_RELEASE_DIR=/opt/agent-device-cloud/current/dist/plugins ADC_NODE_RELEASE_DIR=/srv/adc-client-tools/current/node ADC_SDK_RELEASE_DIR=/srv/adc-client-tools/current/sdk /usr/local/bin/node --import tsx apps/control-plane/src/main.ts
"""


def remote_source(sha, run, check_only):
    source = (WORKFLOWS / "deploy.py").read_text()
    source += "\nEXPECTED = " + repr(dict(commit=sha, ciRun=run)) + "\n"
    source += "\nCHECK_ONLY = " + repr(check_only) + "\n"
    source += "\nBEFORE = " + repr(BEFORE.encode()) + "\nCONFIG = " + repr(CONFIG.encode()) + "\n"
    return source + r'''
import contextlib
unit = "agent-device-cloud.service"
service = pathlib.Path("/opt/agent-device-cloud")
clients = pathlib.Path("/srv/adc-client-tools")
drop = pathlib.Path("/etc/systemd/system/agent-device-cloud.service.d/40-product-release.conf")

def environment():
    pid = int(subprocess.check_output(["systemctl", "show", unit, "-p", "MainPID", "--value"],
                                     universal_newlines=True).strip())
    if pid <= 0:
        raise RuntimeError("ADC main process is not running")
    process = pathlib.Path("/proc") / str(pid)
    if os.path.realpath(str(process / "cwd")) != str((service / "current").resolve()):
        raise RuntimeError("ADC process has not activated the qualified service")
    values = {}
    for item in (process / "environ").read_bytes().split(b"\0"):
        name, _, value = item.partition(b"=")
        if name in (b"ADC_NODE_RELEASE_DIR", b"ADC_SDK_RELEASE_DIR"):
            values[name.decode()] = value.decode()
    return values

def fetch_hash(path):
    with urllib.request.urlopen("http://127.0.0.1:8788" + path, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError("Download is unavailable: " + path)
        return hashlib.sha256(response.read()).hexdigest()

def verify():
    ready(["http://127.0.0.1:8788/health"])
    if environment() != expected_environment:
        raise RuntimeError("Effective client directory overrides do not match current")
    for path, checksum in download_hashes.items():
        if fetch_hash(path) != checksum:
            raise RuntimeError("Published download does not match qualified client artifact")

def atomic_write(path, content):
    temporary = path.with_name(path.name + ".client-tools-next")
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

with contextlib.ExitStack() as locks:
    for root in (service, clients):
        lock = locks.enter_context((root / ".deploy.lock").open("a"))
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    for root, component in ((service, "service"), (clients, "client-tools")):
        pointer = root / "current"
        if not pointer.is_symlink():
            raise RuntimeError("Qualified component pointer is missing")
        release = root / "releases" / (EXPECTED["commit"] + "-" + EXPECTED["ciRun"])
        if pointer.resolve() != release:
            raise RuntimeError("Current pointer differs from selected green CI")
        manifest = json.loads((pointer / ".release-manifest.json").read_text())
        if any(manifest.get(key) != value for key, value in dict(
            repository="zioon-tech/adc", component=component, commit=EXPECTED["commit"]).items()
        ) or str(manifest.get("ciRun")) != EXPECTED["ciRun"]:
            raise RuntimeError("Component provenance mismatch")
    expected_environment = dict(ADC_NODE_RELEASE_DIR=str(clients / "current/node"),
                                ADC_SDK_RELEASE_DIR=str(clients / "current/sdk"))
    download_hashes = {}
    for kind, file in (("node", "manifest-v2.json"), ("sdk", "manifest.json")):
        path = clients / "current" / kind / file
        download_hashes["/downloads/" + kind + "/" + file] = digest(path)
        manifest = json.loads(path.read_text())
        archives = list(manifest["archives"].values()) if kind == "node" else [manifest["archive"]]
        for archive in archives:
            name = archive["file"]
            if pathlib.Path(name).name != name or digest(clients / "current" / kind / name) != archive["sha256"]:
                raise RuntimeError("Qualified client archive checksum mismatch")
            download_hashes["/downloads/" + kind + "/" + name] = archive["sha256"]
    if drop.is_symlink() or not drop.is_file():
        raise RuntimeError("Canonical service configuration is not a regular file")
    previous = drop.read_bytes()
    if previous == CONFIG:
        verify()
        print(json.dumps(dict(status="client_downloads_already_active", checkOnly=CHECK_ONLY)), flush=True)
    else:
        if previous != BEFORE:
            raise RuntimeError("Production drop-in changed; reconcile before activation")
        previous_environment = environment()
        if previous_environment != dict(ADC_NODE_RELEASE_DIR=
            "/opt/agent-device-cloud/releases/console-refinement-20261101/dist/node"):
            raise RuntimeError("Production download overrides changed; obtain a fresh inventory")
        ready(["http://127.0.0.1:8788/health"])
        if CHECK_ONLY:
            print(json.dumps(dict(status="client_downloads_preflight_passed", checkOnly=True,
                                  commit=EXPECTED["commit"], ciRun=EXPECTED["ciRun"])), flush=True)
        else:
            backup = pathlib.Path("/var/backups/zioon-adc-client-tools") / EXPECTED["ciRun"]
            backup.mkdir(mode=0o700, parents=True, exist_ok=True)
            saved = backup / "40-product-release.conf"
            if saved.exists():
                if saved.is_symlink() or saved.read_bytes() != previous:
                    raise RuntimeError("Existing configuration backup differs")
            else:
                atomic_write(saved, previous)
            journal = service / "client-download-activations.jsonl"
            operation = dict(operation="activate_client_downloads", commit=EXPECTED["commit"],
                             ciRun=EXPECTED["ciRun"], backup=str(saved), timestamp=int(time.time()))
            def record(status):
                with journal.open("a") as stream:
                    stream.write(json.dumps(dict(operation, status=status)) + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
            record("configuring")
            try:
                atomic_write(drop, CONFIG)
                subprocess.check_call(["systemctl", "daemon-reload"])
                subprocess.check_call(["systemctl", "restart", unit])
                verify()
                record("activated")
            except BaseException:
                atomic_write(drop, previous)
                subprocess.check_call(["systemctl", "daemon-reload"])
                subprocess.check_call(["systemctl", "restart", unit])
                try:
                    ready(["http://127.0.0.1:8788/health"])
                    if environment() != previous_environment:
                        raise RuntimeError("Rollback download overrides mismatch")
                    record("rolled_back")
                except BaseException:
                    record("rollback_failed")
                    raise
                raise
            print(json.dumps(dict(operation, status="client_downloads_activated",
                                  restartedServices=[unit], archiveChecksumsVerified=True,
                                  httpReadinessPassed=True)), flush=True)
'''


def main():
    if os.environ["GITHUB_REPOSITORY"] != "zioon-tech/adc" or os.environ["GITHUB_REF"] != "refs/heads/main":
        raise RuntimeError("Client activation must run from ADC main")
    run_id = os.environ["CLIENT_CI_RUN"]
    raw = os.environ["CHECK_ONLY"]
    if not run_id.isdecimal() or raw not in ("true", "false"):
        raise ValueError("Explicit numeric CI run and check-only boolean are required")
    headers = {"Authorization": "Bearer " + os.environ["GH_TOKEN"]}
    api = "https://api.github.com/repos/zioon-tech/adc/actions/"
    run = json.loads(request(api + "runs/" + run_id, headers=headers))
    workflow = json.loads(request(api + "workflows/" + str(run["workflow_id"]), headers=headers))
    if (run["status"] != "completed" or run["conclusion"] != "success" or run["head_branch"] != "main"
        or run["event"] not in ("push", "workflow_dispatch") or workflow["path"] != ".github/workflows/ci.yml"):
        raise RuntimeError("Selected CI is not a successful main product build")
    command = python_command(remote_source(run["head_sha"], run_id, raw == "true"))
    oidc = json.loads(request(
        os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=sts.aliyuncs.com",
        headers={"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]},
    ))["value"]
    credentials = rpc("sts.cn-shanghai.aliyuncs.com", "2015-04-01", "AssumeRoleWithOIDC", dict(
        RoleArn=os.environ["DEPLOY_ROLE_ARN"], OIDCProviderArn=os.environ["DEPLOY_OIDC_PROVIDER_ARN"],
        OIDCToken=oidc, RoleSessionName="client-activate-" + os.environ["GITHUB_RUN_ID"], DurationSeconds=3600,
    ))["Credentials"]
    result = rpc("ecs.cn-shanghai.aliyuncs.com", "2014-05-26", "RunCommand", dict(
        RegionId="cn-shanghai", **{"InstanceId.1": os.environ["DEPLOY_INSTANCE_ID"]},
        CommandContent=base64.b64encode(command.encode()).decode(), ContentEncoding="Base64",
        Type="RunShellScript", Name="adc-client-activate-" + os.environ["GITHUB_RUN_ID"],
        Timeout=600, KeepCommand="false",
    ), credentials)
    invocation = result["InvokeId"]
    print(json.dumps(dict(invocationId=invocation, operation="activate_client_downloads",
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
                raise RuntimeError("Activation failed; inspect invocation " + invocation)
            return
        time.sleep(3)
    raise RuntimeError("Activation outcome unknown; inspect invocation " + invocation + " before retrying")


if __name__ == "__main__":
    main()
