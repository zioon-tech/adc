import { createHash } from "node:crypto";
import { ErrorCodes, ProtocolError, type InvocationResult } from "@adc/protocol";

export interface StoragePolicy {
  deliveryGraceMs: number;
  temporaryTtlMs: number;
  detailTtlMs: number;
  summaryTtlMs: number;
  maxResultBytes: number;
  maxInvocationBytes: number;
  maxMetadataBytes: number;
  accountBytes: number;
  globalBytes: number;
  batchSize: number;
  batchBytes: number;
  intervalMs: number;
}

export const defaultStoragePolicy: StoragePolicy = {
  deliveryGraceMs: 10 * 60_000,
  temporaryTtlMs: 24 * 60 * 60_000,
  detailTtlMs: 7 * 24 * 60 * 60_000,
  summaryTtlMs: 30 * 24 * 60 * 60_000,
  maxResultBytes: 25 * 1024 * 1024,
  maxInvocationBytes: 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
  accountBytes: 256 * 1024 * 1024,
  globalBytes: 2 * 1024 * 1024 * 1024,
  batchSize: 100,
  batchBytes: 64 * 1024 * 1024,
  intervalMs: 60_000
};

export function storagePolicy(overrides: Partial<StoragePolicy> = {}): StoragePolicy {
  const policy = { ...defaultStoragePolicy, ...overrides };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Invalid storage policy: ${key}`);
  }
  if (
    policy.deliveryGraceMs > policy.temporaryTtlMs ||
    policy.temporaryTtlMs > policy.detailTtlMs ||
    policy.detailTtlMs > policy.summaryTtlMs ||
    policy.accountBytes > policy.globalBytes
  ) {
    throw new Error("Storage policy deadlines or quotas are out of order");
  }
  return policy;
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "");
}

export function bodyHash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex")}`;
}

export function assertMetadataBudget(value: unknown, policy: StoragePolicy): void {
  if (jsonBytes(value) > policy.maxMetadataBytes) {
    throw new ProtocolError(
      ErrorCodes.INVALID_REQUEST,
      "Execution metadata exceeds storage limit",
      false
    );
  }
}

export function retireResult(
  result: InvocationResult,
  now: Date,
  reason: "expired" | "quota_exceeded" | "size_exceeded",
  byteSize = jsonBytes(result.output),
  sha256 = bodyHash(result.output)
): InvocationResult {
  const summary = { ...result };
  delete summary.output;
  return {
    ...summary,
    output: {
      contentRetired: true,
      contentRetiredAt: now.toISOString(),
      contentRetiredReason: reason,
      byteSize,
      sha256
    }
  };
}

export interface StorageUsage {
  temporaryBytes: number;
  expiredBytes: number;
  oldestExpiredAt?: string;
  retiredResults: number;
  retiredArtifacts: number;
  databaseBytes?: number;
  walBytes?: number;
}

export interface StorageMaintenanceResult {
  results: number;
  artifacts: number;
  audits: number;
  details: number;
  approvals: number;
}
