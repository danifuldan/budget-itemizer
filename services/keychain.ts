import { execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const SERVICE_PREFIX = "com.budget-itemizer";

/** macOS Keychain wrapper — uses the built-in `security` CLI so we don't
 *  need a native Node module bundled by pkg. Falls back to no-op on
 *  non-macOS platforms (the app currently only ships for macOS, but
 *  keep the interface compatible so dev on Linux doesn't crash). */

function isMacOS(): boolean {
  return process.platform === "darwin";
}

/** When set, all Keychain reads return null and writes are no-ops. Used by the
 *  smoke runner and any other CI-shaped path where the sidecar runs from a
 *  binary identity macOS hasn't authorized yet — without this guard, every
 *  config-load triggers a Keychain access dialog that the smoke can't dismiss. */
function keychainDisabled(): boolean {
  return process.env.BUDGET_ITEMIZER_NO_KEYCHAIN === "1";
}

function serviceName(key: string): string {
  return `${SERVICE_PREFIX}.${key}`;
}

/** Read a secret from the macOS Keychain. Returns null if missing. */
export async function getSecret(key: string): Promise<string | null> {
  if (!isMacOS() || keychainDisabled()) return null;
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-s", serviceName(key),
      "-w",
    ]);
    return stdout.replace(/\n$/, "");
  } catch {
    return null;
  }
}

/** Write a secret to the macOS Keychain. -U updates if present.
 *  Pipes the secret value via stdin rather than passing it as -w <value>
 *  on argv — the latter is visible in `ps` listings to any same-user
 *  process during the brief execution window. With `-w` and no value
 *  `security` reads the password from stdin. */
export async function setSecret(key: string, value: string): Promise<void> {
  if (!isMacOS() || keychainDisabled()) return;
  if (!value) {
    await deleteSecret(key);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    // `-w` must be the *last* option to trigger stdin prompting (per
    // `security`'s own help text). It prompts "password data for new item:"
    // and "retype password for new item:" — feed the secret twice.
    const child = spawn("/usr/bin/security", [
      "add-generic-password",
      "-s", serviceName(key),
      "-a", process.env.USER || "budget-itemizer",
      "-U",
      "-w",
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`security exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(value + "\n" + value + "\n");
    child.stdin.end();
  });
}

/** Remove a secret from the macOS Keychain. Silent on missing key. */
export async function deleteSecret(key: string): Promise<void> {
  if (!isMacOS() || keychainDisabled()) return;
  try {
    await execFileAsync("/usr/bin/security", [
      "delete-generic-password",
      "-s", serviceName(key),
    ]);
  } catch {
    // Already absent — nothing to do
  }
}

export const KEYCHAIN_KEYS = {
  ynabApiKey: "ynab-api-key",
  actualPassword: "actual-password",
  appApiKey: "app-api-key",
  appApiSecret: "app-api-secret",
} as const;
