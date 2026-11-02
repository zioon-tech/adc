import { describe, expect, it, vi } from "vitest";
import { TaskWaitHub } from "./task-wait.ts";

describe("durable task wait", () => {
  it("does not lose completion notifications during the first read", async () => {
    const hub = new TaskWaitHub();
    let reads = 0;
    const result = await hub.wait(
      "dsp_one",
      async () => {
        if (++reads === 1) {
          hub.notify("dsp_one");
          return "queued";
        }
        return "succeeded";
      },
      (value) => value === "queued",
      10_000
    );
    expect(result).toBe("succeeded");
    expect(reads).toBe(2);
    hub.close();
  });

  it("finds completions from another replica without notifications", async () => {
    const hub = new TaskWaitHub();
    let reads = 0;
    expect(
      await hub.wait(
        "dsp_one",
        async () => (++reads === 1 ? "running" : "succeeded"),
        (value) => value === "running",
        500,
        undefined,
        5
      )
    ).toBe("succeeded");
    hub.close();
  });

  it("returns current state when the wait expires without cancelling the task", async () => {
    const hub = new TaskWaitHub();
    expect(
      await hub.wait(
        "dsp_one",
        async () => "queued",
        () => true,
        10
      )
    ).toBe("queued");
    hub.close();
  });

  it.each(["abort", "shutdown"])("releases listeners on %s", async (action) => {
    const hub = new TaskWaitHub();
    const abort = new AbortController();
    const read = vi.fn(async () => "running");
    const waiting = hub.wait("dsp_one", read, () => true, 30_000, abort.signal);
    await new Promise((resolve) => setImmediate(resolve));
    if (action === "abort") abort.abort();
    else hub.close();
    expect(await waiting).toBe("running");
    hub.notify("dsp_one");
    expect(read).toHaveBeenCalledTimes(2);
    hub.close();
  });

  it("rechecks authorization after completion", async () => {
    const hub = new TaskWaitHub();
    let allowed = true;
    const waiting = hub.wait(
      "dsp_one",
      async () => {
        if (!allowed) throw new Error("revoked");
        return "queued";
      },
      () => true,
      1000
    );
    await new Promise((resolve) => setImmediate(resolve));
    allowed = false;
    hub.notify("dsp_one");
    await expect(waiting).rejects.toThrow("revoked");
    hub.close();
  });
});
