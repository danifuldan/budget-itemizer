import { execFile } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { z } from "zod";

const _currentDir = typeof import.meta.url === "string"
  ? path.dirname(fileURLToPath(import.meta.url))
  : __dirname;

// ── Binary lookup ──────────────────────────────────────────────────

function findSwiftBinary(): string {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    // Prod: sibling to the running binary (Contents/MacOS/)
    path.join(execDir, "swift-sidecar"),
    // Dev: source directory
    path.join(_currentDir, "swift-sidecar"),
    // Dev: built from swift-sidecar/ package
    path.join(_currentDir, "..", "swift-sidecar", ".build", "release", "swift-sidecar"),
    path.join(_currentDir, "swift-sidecar", ".build", "release", "swift-sidecar"),
    // Dev: in src-tauri/binaries with target triple suffix
    path.join(_currentDir, "..", "src-tauri", "binaries", "swift-sidecar-aarch64-apple-darwin"),
    path.join(_currentDir, "src-tauri", "binaries", "swift-sidecar-aarch64-apple-darwin"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("swift-sidecar binary not found");
}

// ── Schemas ────────────────────────────────────────────────────────

const capabilitiesSchema = z.object({
  visionAvailable: z.boolean(),
  // Older sidecar builds may omit this field. Default to false so
  // downstream callers can read it without an undefined check.
  documentRecognitionAvailable: z.boolean().optional().default(false),
});

const visionResultSchema = z.object({
  pages: z.array(
    z.object({
      pageNumber: z.number(),
      text: z.string(),
      lines: z.array(
        z.object({
          text: z.string(),
          confidence: z.number(),
          bbox: z.object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
          }),
        }),
      ),
      detectedAmounts: z.array(
        z.object({
          raw: z.string(),
          value: z.number(),
          offset: z.number(),
        }),
      ),
    }),
  ),
});

// ── Generic runner ─────────────────────────────────────────────────

function runSidecar<T>(
  command: string,
  schema: z.ZodSchema<T>,
  args: string[] = [],
  stdin?: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const bin = findSwiftBinary();
    const child = execFile(
      bin,
      [command, ...args],
      // signal kills the child on abort (Node's documented execFile
      // behavior; default SIGTERM) so a Discard-while-OCR'ing stops the
      // swift sidecar instead of letting it run to completion.
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (stderr) {
          // Swift sidecar uses stderr for logging — forward to console
          for (const line of stderr.split("\n").filter(Boolean)) {
            console.log(`[swift-sidecar] ${line}`);
          }
        }

        if (error) {
          // Aborted via the AbortSignal — surface as a clean Web-style
          // AbortError so callers can distinguish cancellation from a
          // real sidecar failure.
          if ((error as NodeJS.ErrnoException).code === "ABORT_ERR" || error.name === "AbortError") {
            const abortErr = new DOMException("Sidecar aborted", "AbortError");
            reject(abortErr);
            return;
          }
          // Try to parse stdout as JSON error even on failure
          try {
            const parsed = JSON.parse(stdout);
            if (parsed.error) {
              reject(new Error(`swift-sidecar ${command}: ${parsed.error}`));
              return;
            }
          } catch {
            // not JSON
          }
          reject(new Error(`swift-sidecar ${command} failed: ${error.message}`));
          return;
        }

        let raw: unknown;
        try {
          raw = JSON.parse(stdout);
        } catch {
          reject(new Error(`swift-sidecar ${command}: invalid JSON output`));
          return;
        }
        if (raw && typeof raw === "object" && "error" in raw && typeof (raw as { error: unknown }).error === "string") {
          reject(new Error(`swift-sidecar ${command}: ${(raw as { error: string }).error}`));
          return;
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          reject(new Error(`swift-sidecar ${command}: response failed schema validation: ${parsed.error.message}`));
          return;
        }
        resolve(parsed.data);
      },
    );

    if (stdin) {
      // Absorb async EPIPE if a signal-abort killed the child in the
      // tiny window between spawn and the stdin write: an unlistened
      // stdin 'error' event would otherwise propagate as an uncaught
      // exception and crash the sidecar (premortem Bug 2).
      child.stdin?.on("error", () => {});
      try {
        child.stdin?.write(stdin);
        child.stdin?.end();
      } catch {
        /* child already dead — the execFile callback rejects with AbortError */
      }
    }
  });
}

// ── Typed API ──────────────────────────────────────────────────────

export type SidecarCapabilities = z.infer<typeof capabilitiesSchema>;

let cachedCapabilities: SidecarCapabilities | null = null;

export async function getCapabilities(): Promise<SidecarCapabilities> {
  if (cachedCapabilities) return cachedCapabilities;

  try {
    cachedCapabilities = await runSidecar("capabilities", capabilitiesSchema);
    console.log(`[swift-sidecar] capabilities: vision=${cachedCapabilities.visionAvailable}`);
    return cachedCapabilities;
  } catch (err) {
    console.warn(`[swift-sidecar] not available: ${err}`);
    cachedCapabilities = { visionAvailable: false, documentRecognitionAvailable: false };
    return cachedCapabilities;
  }
}

export function isSidecarAvailable(): boolean {
  try {
    findSwiftBinary();
    return true;
  } catch {
    return false;
  }
}

export type VisionResult = z.infer<typeof visionResultSchema>;
export type VisionPageResult = VisionResult["pages"][number];

export interface CropRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function runVision(
  pdfPath: string,
  scale?: number,
  crop?: CropRegion,
  signal?: AbortSignal,
): Promise<VisionResult> {
  // Pass the PDF path via stdin JSON rather than --input argv so it
  // doesn't show up in `ps` listings visible to other same-user
  // processes. The Swift sidecar accepts either form.
  const stdinJson: Record<string, unknown> = { input: pdfPath };
  if (scale) stdinJson.scale = scale;
  if (crop) stdinJson.crop = `${crop.x},${crop.y},${crop.w},${crop.h}`;
  return runSidecar("vision", visionResultSchema, [], JSON.stringify(stdinJson), signal);
}
