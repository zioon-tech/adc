import { PROTOCOL_VERSION, NodeWakeSignalSchema } from "@adc/protocol";
import WebSocket from "ws";

interface Connection {
  alive: boolean;
  socket: WebSocket;
}

export interface NodeWakeHubOptions {
  heartbeatIntervalMs?: number;
  now?: () => Date;
  onConnectionCount?: (count: number) => void;
  onError?: (error: unknown) => void;
  touchPresence: (nodeIds: string[]) => Promise<void>;
}

export class NodeWakeHub {
  private readonly connections = new Map<string, Connection>();
  private readonly generations = new Map<string, number>();
  private readonly wakeSequences = new Map<string, number>();
  private readonly waiters = new Map<string, Set<(woken: boolean) => void>>();
  private readonly heartbeatTimer: NodeJS.Timeout;
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: NodeWakeHubOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  generation(nodeId: string): number {
    return this.generations.get(nodeId) ?? 0;
  }

  wakeSequence(nodeId: string): number {
    return this.wakeSequences.get(nodeId) ?? 0;
  }

  wait(nodeId: string, afterSequence: number, timeoutMs: number): Promise<boolean> {
    if (this.wakeSequence(nodeId) !== afterSequence) return Promise.resolve(true);
    return new Promise((resolve) => {
      let finished = false;
      const finish = (woken: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const nodeWaiters = this.waiters.get(nodeId);
        nodeWaiters?.delete(finish);
        if (nodeWaiters?.size === 0) this.waiters.delete(nodeId);
        resolve(woken);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
      const nodeWaiters = this.waiters.get(nodeId) ?? new Set();
      nodeWaiters.add(finish);
      this.waiters.set(nodeId, nodeWaiters);
      if (this.wakeSequence(nodeId) !== afterSequence) finish(true);
    });
  }

  connect(nodeId: string, socket: WebSocket, generation = this.generation(nodeId)): boolean {
    if (generation !== this.generation(nodeId)) {
      socket.close(4001, "device credentials changed");
      return false;
    }
    const previous = this.connections.get(nodeId);
    const connection = { alive: true, socket };
    this.connections.set(nodeId, connection);
    this.options.onConnectionCount?.(this.connections.size);

    if (previous && previous.socket !== socket) {
      previous.socket.close(4001, "replaced by a newer connection");
    }

    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("close", () => {
      if (this.connections.get(nodeId)?.socket !== socket) return;
      this.connections.delete(nodeId);
      this.options.onConnectionCount?.(this.connections.size);
    });
    socket.on("error", (error) => this.options.onError?.(error));
    socket.ping();
    void this.touchPresence([nodeId]);
    return true;
  }

  wake(nodeId: string): boolean {
    this.wakeSequences.set(nodeId, this.wakeSequence(nodeId) + 1);
    const waiters = this.waiters.get(nodeId);
    const longPollDelivered = !!waiters?.size;
    for (const waiter of [...(waiters ?? [])]) waiter(true);
    const connection = this.connections.get(nodeId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) return longPollDelivered;
    const payload = NodeWakeSignalSchema.parse({
      schemaVersion: PROTOCOL_VERSION,
      type: "dispatch.available",
      nodeId,
      issuedAt: this.now().toISOString()
    });
    connection.socket.send(JSON.stringify(payload), (error) => {
      if (!error) return;
      this.options.onError?.(error);
      connection.socket.terminate();
    });
    return true;
  }

  has(nodeId: string): boolean {
    return this.connections.get(nodeId)?.socket.readyState === WebSocket.OPEN;
  }

  disconnect(nodeId: string, reason: string): void {
    this.generations.set(nodeId, this.generation(nodeId) + 1);
    for (const waiter of [...(this.waiters.get(nodeId) ?? [])]) waiter(false);
    const connection = this.connections.get(nodeId);
    if (!connection) return;
    this.connections.delete(nodeId);
    this.options.onConnectionCount?.(this.connections.size);
    connection.socket.close(4001, reason.slice(0, 123));
  }

  close(): void {
    clearInterval(this.heartbeatTimer);
    for (const waiters of this.waiters.values()) {
      for (const waiter of [...waiters]) waiter(false);
    }
    this.waiters.clear();
    for (const { socket } of this.connections.values()) {
      socket.terminate();
    }
    this.connections.clear();
    this.options.onConnectionCount?.(0);
  }

  private heartbeat(): void {
    const aliveNodeIds: string[] = [];
    for (const [nodeId, connection] of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        this.connections.delete(nodeId);
        continue;
      }
      connection.alive = false;
      aliveNodeIds.push(nodeId);
      connection.socket.ping();
    }
    this.options.onConnectionCount?.(this.connections.size);
    void this.touchPresence(aliveNodeIds);
  }

  private async touchPresence(nodeIds: string[]): Promise<void> {
    if (!nodeIds.length) return;
    try {
      await this.options.touchPresence(nodeIds);
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
