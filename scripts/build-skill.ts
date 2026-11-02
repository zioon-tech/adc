import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync, type Zippable } from "fflate";

const root = resolve(import.meta.dirname, "..");
const name = "agent-device-cloud";

export async function buildSkill(
  output = resolve(root, "dist/skills"),
  source = resolve(root, "skills", name)
) {
  const files: Record<string, Buffer> = {};
  async function collect(directory: string, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}${entry.name}`;
      if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || entry.name.startsWith(".")) {
        throw new Error(`Unsupported Skill resource: ${relative}`);
      }
      if (entry.isDirectory()) await collect(resolve(directory, entry.name), `${relative}/`);
      else if (entry.isFile()) files[relative] = await readFile(resolve(directory, entry.name));
      else throw new Error(`Skill resources must be regular files: ${relative}`);
    }
  }
  await collect(source);
  const content = files["SKILL.md"]?.toString("utf8") ?? "";
  const description = content.match(/^description: (.+)$/m)?.[1];
  const version = content.match(/^version: ([0-9]+\.[0-9]+\.[0-9]+)$/m)?.[1];
  if (!content.startsWith(`---\nname: ${name}\n`) || !description || !version) {
    throw new Error("Skill metadata requires the official name, description and version.");
  }
  const entries: Zippable = {};
  for (const [file, bytes] of Object.entries(files)) {
    entries[file] = [bytes, { mtime: new Date("2000-01-01T00:00:00Z") }];
  }
  const archive = zipSync(entries, { level: 9 });
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const archiveFile = `${name}-${version}-${sha256.slice(0, 16)}.zip`;
  const manifest = {
    name,
    version,
    description,
    files: Object.keys(files),
    archive: { file: archiveFile, sha256, bytes: archive.byteLength }
  };
  await mkdir(resolve(output, name), { recursive: true });
  for (const [file, bytes] of Object.entries(files)) {
    const path = resolve(output, name, file);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  }
  await writeFile(resolve(output, archiveFile), archive);
  await writeFile(resolve(output, `${name}.zip`), archive);
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(
    resolve(output, "index.json"),
    json({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name,
          description,
          type: "archive",
          url: `/downloads/skills/${archiveFile}`,
          digest: `sha256:${sha256}`
        }
      ]
    })
  );
  await writeFile(
    resolve(output, "legacy-index.json"),
    json({ skills: [{ name, description, files: manifest.files }] })
  );
  await writeFile(resolve(output, "manifest.json"), json(manifest));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifest = await buildSkill();
  console.log(`Built ${manifest.archive.file} (${manifest.files.length} files)`);
}
