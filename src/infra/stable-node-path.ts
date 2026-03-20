import fs from "node:fs/promises";
import path from "node:path";

async function resolveVersionManagerNodeAlias(nodePath: string): Promise<string | null> {
  const pathModule = nodePath.includes("\\") ? path.win32 : path.posix;
  const nvmMatch = nodePath.match(
    /^(.*?)[\\/]versions[\\/]node[\\/][^\\/]+[\\/]bin[\\/]node(?:\.exe)?$/,
  );
  if (nvmMatch) {
    return pathModule.join(nvmMatch[1], "current", "bin", pathModule.basename(nodePath));
  }

  const fnmMatch = nodePath.match(
    /^(.*?)[\\/]node-versions[\\/][^\\/]+[\\/]installation[\\/]bin[\\/]node(?:\.exe)?$/,
  );
  if (fnmMatch) {
    const currentAlias = pathModule.join(
      fnmMatch[1],
      "current",
      "bin",
      pathModule.basename(nodePath),
    );
    try {
      await fs.access(currentAlias);
      return currentAlias;
    } catch {
      const defaultAlias = pathModule.join(
        fnmMatch[1],
        "aliases",
        "default",
        "bin",
        pathModule.basename(nodePath),
      );
      return defaultAlias;
    }
  }

  return null;
}

async function resolveMatchingStableAlias(nodePath: string): Promise<string | null> {
  const aliasPath = await resolveVersionManagerNodeAlias(nodePath);
  if (!aliasPath) {
    return null;
  }

  try {
    await fs.access(aliasPath);
    const [nodeRealpath, aliasRealpath] = await Promise.all([
      fs.realpath(nodePath),
      fs.realpath(aliasPath),
    ]);
    if (nodeRealpath === aliasRealpath) {
      return aliasPath;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Homebrew Cellar paths (e.g. /opt/homebrew/Cellar/node/25.7.0/bin/node)
 * break when Homebrew upgrades Node and removes the old version directory.
 * Resolve these to a stable Homebrew-managed path that survives upgrades:
 *   - Default formula "node":  <prefix>/opt/node/bin/node  or  <prefix>/bin/node
 *   - Versioned formula "node@22":  <prefix>/opt/node@22/bin/node  (keg-only)
 */
export async function resolveStableNodePath(nodePath: string): Promise<string> {
  const versionManagerAlias = await resolveMatchingStableAlias(nodePath);
  if (versionManagerAlias) {
    return versionManagerAlias;
  }

  const cellarMatch = nodePath.match(
    /^(.+?)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node$/,
  );
  if (!cellarMatch) {
    return nodePath;
  }
  const prefix = cellarMatch[1]; // e.g. /opt/homebrew
  const formula = cellarMatch[2]; // e.g. "node" or "node@22"
  const pathModule = nodePath.includes("\\") ? path.win32 : path.posix;

  // Try the Homebrew opt symlink first — works for both default and versioned formulas.
  const optPath = pathModule.join(prefix, "opt", formula, "bin", "node");
  try {
    await fs.access(optPath);
    return optPath;
  } catch {
    // fall through
  }

  // For the default "node" formula, also try the direct bin symlink.
  if (formula === "node") {
    const binPath = pathModule.join(prefix, "bin", "node");
    try {
      await fs.access(binPath);
      return binPath;
    } catch {
      // fall through
    }
  }

  return nodePath;
}
