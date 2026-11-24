import { constants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { open, realpath } from "node:fs/promises";

export async function openSecureLog(path: string) {
  if (constants.O_NOFOLLOW === undefined) {
    throw new Error("This platform cannot safely open the command log without following symlinks.");
  }

  const absolutePath = resolve(path);
  const fileName = basename(absolutePath);
  if (!fileName || fileName === "." || fileName === "..") {
    throw new Error("A valid command log filename is required.");
  }

  const parent = await realpath(dirname(absolutePath));
  const target = resolve(parent, fileName);
  const flags =
    constants.O_WRONLY |
    constants.O_APPEND |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (constants.O_NONBLOCK ?? 0);

  const handle = await open(target, flags, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("The command log must be a regular file.");
    if (info.nlink !== 1) throw new Error("The command log must not have additional hard links.");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("The command log must be owned by the MCP process user.");
    }
    await handle.chmod(0o600);
    return handle.createWriteStream({ autoClose: true });
  } catch (error) {
    await handle.close();
    throw error;
  }
}