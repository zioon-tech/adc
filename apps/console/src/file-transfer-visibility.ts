// Keep cloud-mediated transfers out of new Console grants and public promotion
// until a governed direct/relay transport is available. Existing grants remain manageable.
export const showCloudFileTransfers = false;

export function isConsoleToolVisible(tool: string): boolean {
  return showCloudFileTransfers || tool !== "file.transfer";
}
