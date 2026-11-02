export interface ReleaseArchive {
  file: string;
  sha256: string;
  bytes: number;
}

export interface ReleaseManifestInput {
  version: string;
  runtimeVersion: string;
  buildId: string;
  archives: Record<string, ReleaseArchive>;
}

export function releaseManifests(input: ReleaseManifestInput) {
  return {
    legacy: {
      ...input,
      archives: Object.fromEntries(
        Object.entries(input.archives).filter(([, archive]) => archive.file.endsWith(".tar.gz"))
      )
    },
    current: input
  };
}
