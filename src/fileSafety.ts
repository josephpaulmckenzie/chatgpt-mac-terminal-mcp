import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { sha256Text } from "./writePreflight.js";
const BLOCKED_SEGMENTS = new Set([".git", "node_modules", ".aws", ".ssh", "secret", "secrets"]);
const BLOCKED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
const pathLocks = new Map<string, Promise<void>>();

async function withPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === "darwin" ? path.toLowerCase() : path;
  const previous = pathLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolveLock => { release = resolveLock; });
  pathLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pathLocks.get(key) === current) pathLocks.delete(key);
  }
}

function validateRelativePath(relativePath: string): string[] {
  if (!relativePath.trim() || isAbsolute(relativePath) || /[\u0000-\u001f]/.test(relativePath)) throw new Error("A valid repository-relative file path is required.");
  const segments = relativePath.replaceAll("\\", "/").split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..") || isProtectedRepositoryPath(relativePath)) throw new Error("Sensitive or protected paths are prohibited.");
  return segments;
}

export function isProtectedRepositoryPath(relativePath: string): boolean {
  const segments = relativePath.replaceAll("\\", "/").split("/").map(segment => segment.toLowerCase());
  const leaf = segments.at(-1) ?? "";
  return segments.some(segment =>
    BLOCKED_SEGMENTS.has(segment) ||
    segment === ".env" ||
    segment.startsWith(".env.") ||
    segment.includes("secret") ||
    segment.includes("credential")
  ) || BLOCKED_EXTENSIONS.some(extension => leaf.endsWith(extension));
}

export async function resolveRepositoryFile(repository: string, relativePath: string, allowMissingLeaf = false): Promise<string> {
  const segments = validateRelativePath(relativePath);
  const root = await realpath(repository);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    if (current !== root && !current.startsWith(root + sep)) throw new Error("Access outside the repository is prohibited.");
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Symbolic links are prohibited in repository paths.");
      const leaf = index === segments.length - 1;
      if (leaf ? !info.isFile() : !info.isDirectory()) throw new Error("Repository path components must be directories ending in a regular file.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !allowMissingLeaf || index !== segments.length - 1) throw error;
    }
  }
  const parent = await realpath(resolve(current, ".."));
  if (parent !== root && !parent.startsWith(root + sep)) throw new Error("Access outside the repository is prohibited.");
  return current;
}
export async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("Only regular files within the configured size limit may be read.");
    const chunks: Buffer[] = [];
    let position = 0;
    while (position <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > maxBytes) {
        throw new Error("Only regular files within the configured size limit may be read.");
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, position);
  } finally { await handle.close(); }
}
async function writeRegularFileUnlocked(path: string, content: string, overwrite: boolean, expectedCurrentSha256: string | null): Promise<void> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  if (!overwrite) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Target must be a regular file.");
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
    } finally { await handle.close(); }
    return;
  }
  const handle = await open(path, constants.O_RDWR | noFollow | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 150_000) {
      throw new Error("Only regular files within the configured size limit may be overwritten.");
    }

    const chunks: Buffer[] = [];
    let position = 0;
    while (position < info.size) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, info.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }

    if (position !== info.size || sha256Text(Buffer.concat(chunks, position)) !== expectedCurrentSha256) {
      throw new Error("Target changed after preflight; run preview_write again.");
    }

    await handle.truncate(0);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
}

export async function writeRegularFile(path: string, content: string, overwrite: boolean, expectedCurrentSha256: string | null): Promise<void> {
  return withPathLock(path, () => writeRegularFileUnlocked(path, content, overwrite, expectedCurrentSha256));
}

async function deleteRegularFileUnlocked(path: string, expectedCurrentSha256: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let identity: { dev: number; ino: number };
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 150_000) {
      throw new Error("Only regular files within the configured size limit may be deleted.");
    }
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < info.size) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, info.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (position !== info.size || sha256Text(Buffer.concat(chunks, position)) !== expectedCurrentSha256) {
      throw new Error("Target changed after preflight; deletion was refused.");
    }
    identity = { dev: info.dev, ino: info.ino };
  } finally { await handle.close(); }
  const latest = await lstat(path);
  if (latest.isSymbolicLink() || !latest.isFile() || latest.dev !== identity.dev || latest.ino !== identity.ino) throw new Error("Target identity changed after preflight; deletion was refused.");
  await unlink(path);
}

export async function deleteRegularFile(path: string, expectedCurrentSha256: string): Promise<void> {
  return withPathLock(path, () => deleteRegularFileUnlocked(path, expectedCurrentSha256));
}