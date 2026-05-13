import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ImportRecord } from "../shared/types";
import { writeRestrictedFile, ensureRestrictedDir } from "../utils/restricted-file";

// Re-exported for the test file's `import { ..., type ImportRecord } from "./history"`
// callers; new code should import from "../shared/types" directly.
export type { ImportRecord };

const HISTORY_DIR = path.join(os.homedir(), ".config", "budget-itemizer");
const HISTORY_FILE = path.join(HISTORY_DIR, "history.json");

const ensureDir = () => ensureRestrictedDir(HISTORY_DIR);

const readHistory = (): ImportRecord[] => {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
  } catch {
    return [];
  }
};

const writeHistory = (records: ImportRecord[]) => {
  ensureDir();
  try {
    writeRestrictedFile(HISTORY_FILE, JSON.stringify(records, null, 2));
  } catch (err) {
    console.error("Failed to write history file:", err);
  }
};

export const addRecord = (record: Omit<ImportRecord, "id" | "importedAt">) => {
  const records = readHistory();
  records.unshift({
    ...record,
    id: crypto.randomUUID(),
    importedAt: new Date().toISOString(),
  });
  // Keep last 200 records
  if (records.length > 200) records.length = 200;
  writeHistory(records);
};

export const deleteRecord = (id: string): boolean => {
  const records = readHistory();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  records.splice(idx, 1);
  writeHistory(records);
  return true;
};

export const getHistory = (limit = 50): ImportRecord[] => {
  return readHistory().slice(0, limit);
};
