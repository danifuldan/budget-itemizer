import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";

vi.mock("fs");

import { getHistory, addRecord, type ImportRecord } from "./history";

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFs.mkdirSync.mockReturnValue(undefined);
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.writeFileSync.mockReturnValue(undefined);
});

const makeRecord = (overrides: Partial<ImportRecord> = {}): ImportRecord => ({
  id: "r1",
  filename: "receipt.pdf",
  merchant: "Walmart",
  totalAmount: 42.99,
  itemCount: 3,
  transactionDate: "2024-01-01",
  importedAt: "2024-01-01T00:00:00.000Z",
  success: true,
  ...overrides,
});

describe("getHistory", () => {
  it("returns empty array when no history file exists", () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(getHistory()).toEqual([]);
  });

  it("returns records up to specified limit", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ id: `r${i}` })
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(records));

    const result = getHistory(3);
    expect(result).toHaveLength(3);
  });

  it("defaults to limit of 50", () => {
    const records = Array.from({ length: 60 }, (_, i) =>
      makeRecord({ id: `r${i}` })
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(records));

    const result = getHistory();
    expect(result).toHaveLength(50);
  });
});

describe("addRecord", () => {
  it("prepends record with id and timestamp", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([]));

    addRecord({
      filename: "test.pdf",
      merchant: "Target",
      totalAmount: 25.0,
      itemCount: 2,
      transactionDate: "2024-06-15",
      success: true,
    });

    expect(mockedFs.writeFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string
    );
    expect(written).toHaveLength(1);
    expect(written[0].id).toBeTypeOf("string");
    expect(written[0].id.length).toBeGreaterThan(0);
    expect(written[0].importedAt).toBeDefined();
    expect(written[0].merchant).toBe("Target");
  });

  it("trims history to 200 records", () => {
    const existing = Array.from({ length: 200 }, (_, i) =>
      makeRecord({ id: `r${i}` })
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

    addRecord({
      filename: "new.pdf",
      merchant: "New Store",
      totalAmount: 10,
      itemCount: 1,
      transactionDate: "2024-07-01",
      success: true,
    });

    expect(mockedFs.writeFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(
      mockedFs.writeFileSync.mock.calls[0][1] as string
    );
    expect(written).toHaveLength(200);
    // New record is first
    expect(written[0].merchant).toBe("New Store");
  });
});
