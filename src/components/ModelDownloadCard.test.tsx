// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ModelDownloadCard from "./ModelDownloadCard";
import type { UseModelDownloadReturn } from "../hooks/useModelDownload";

function makeDownload(overrides: Partial<UseModelDownloadReturn> = {}): UseModelDownloadReturn {
  const base: UseModelDownloadReturn = {
    state: {
      downloading: false,
      percent: 0,
      error: "",
      done: false,
      confirmDeleteOpen: false,
    },
    installed: false,
    start: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    requestDelete: vi.fn(),
    cancelDelete: vi.fn(),
    performDelete: vi.fn().mockResolvedValue(undefined),
    primaryLabel: "Download Model",
    isPaused: false,
    deleteConfirmMessage: "Delete?",
  };
  return { ...base, ...overrides, state: { ...base.state, ...(overrides.state ?? {}) } } as UseModelDownloadReturn;
}

describe("ModelDownloadCard — settings variant", () => {
  it("renders the primary download button when not installed", () => {
    const download = makeDownload({ primaryLabel: "Download Model" });
    render(<ModelDownloadCard download={download} variant="settings" />);
    expect(screen.getByRole("button", { name: "Download Model" })).toBeTruthy();
  });

  it("clicking primary calls start when not downloading", async () => {
    const download = makeDownload({ primaryLabel: "Download Model" });
    render(<ModelDownloadCard download={download} variant="settings" />);
    await userEvent.click(screen.getByRole("button", { name: "Download Model" }));
    expect(download.start).toHaveBeenCalled();
  });

  it("clicking primary calls pause when downloading", async () => {
    const download = makeDownload({
      state: { downloading: true, percent: 42, error: "", done: false, confirmDeleteOpen: false },
      primaryLabel: "Pause download (42%)",
    });
    render(<ModelDownloadCard download={download} variant="settings" />);
    await userEvent.click(screen.getByRole("button", { name: /Pause download/i }));
    expect(download.pause).toHaveBeenCalled();
  });

  it("renders 'Model installed' row when installed and showInstalledRow=true", () => {
    const download = makeDownload({ installed: true });
    render(<ModelDownloadCard download={download} variant="settings" showInstalledRow />);
    expect(screen.getByText("Model installed")).toBeTruthy();
  });

  // e2e/download-delete.spec.ts asserts {role:"button", name:"Delete model"}
  // when the model is on disk. Pin here so a label edit can't silently
  // break that test.
  it("delete X has aria-label 'Delete model' when installed", () => {
    const download = makeDownload({ installed: true });
    render(<ModelDownloadCard download={download} variant="settings" showInstalledRow />);
    expect(screen.getByRole("button", { name: "Delete model" })).toBeTruthy();
  });

  it("delete X has aria-label 'Delete partial download' when paused", () => {
    const download = makeDownload({
      state: { downloading: false, percent: 30, error: "", done: false, confirmDeleteOpen: false },
      isPaused: true,
      primaryLabel: "Resume download (30%)",
    });
    render(<ModelDownloadCard download={download} variant="settings" />);
    expect(screen.getByRole("button", { name: "Delete partial download" })).toBeTruthy();
  });

  it("clicking delete X calls requestDelete", async () => {
    const download = makeDownload({ installed: true });
    render(<ModelDownloadCard download={download} variant="settings" showInstalledRow />);
    await userEvent.click(screen.getByRole("button", { name: "Delete model" }));
    expect(download.requestDelete).toHaveBeenCalled();
  });

  it("renders progress bar when downloading", () => {
    const download = makeDownload({
      state: { downloading: true, percent: 50, error: "", done: false, confirmDeleteOpen: false },
      primaryLabel: "Pause download (50%)",
    });
    const { container } = render(<ModelDownloadCard download={download} variant="settings" />);
    expect(container.querySelector(".progress-bar")).toBeTruthy();
  });

  it("renders error row when state.error is set", () => {
    const download = makeDownload({
      state: { downloading: false, percent: 0, error: "Network failed", done: false, confirmDeleteOpen: false },
    });
    render(<ModelDownloadCard download={download} variant="settings" />);
    expect(screen.getByText("Network failed")).toBeTruthy();
  });
});

describe("ModelDownloadCard — wizard variant", () => {
  it("renders wizard primary button with Llama-specific label", () => {
    const download = makeDownload({ primaryLabel: "Download Model" });
    render(<ModelDownloadCard download={download} variant="wizard" statusAnnouncerId="setup-download-status" />);
    // Wizard substitutes the generic label with the Llama-specific copy.
    expect(screen.getByRole("button", { name: "Download Llama 3.1 8B" })).toBeTruthy();
  });

  it("hides the primary button when done=true (Next button takes over)", () => {
    const download = makeDownload({
      state: { downloading: false, percent: 100, error: "", done: true, confirmDeleteOpen: false },
      installed: true,
    });
    render(<ModelDownloadCard download={download} variant="wizard" statusAnnouncerId="setup-download-status" />);
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
  });

  it("renders 'Model ready' row when done=true", () => {
    const download = makeDownload({
      state: { downloading: false, percent: 100, error: "", done: true, confirmDeleteOpen: false },
      installed: true,
    });
    render(<ModelDownloadCard download={download} variant="wizard" statusAnnouncerId="setup-download-status" />);
    expect(screen.getByText("Model ready")).toBeTruthy();
    // And the X button for deleting the now-installed model.
    expect(screen.getByRole("button", { name: "Delete model" })).toBeTruthy();
  });

  // The wizard's screen-reader announcer is load-bearing: the primary
  // button has aria-describedby pointing at this id, and screen readers
  // re-announce its content as the percent ticks.
  it("renders the aria-live status announcer when statusAnnouncerId is supplied", () => {
    const download = makeDownload();
    const { container } = render(
      <ModelDownloadCard download={download} variant="wizard" statusAnnouncerId="setup-download-status" />
    );
    const announcer = container.querySelector("#setup-download-status");
    expect(announcer).toBeTruthy();
    expect(announcer?.getAttribute("aria-live")).toBe("polite");
  });

  it("announcer text reflects download progress", () => {
    const download = makeDownload({
      state: { downloading: true, percent: 33, error: "", done: false, confirmDeleteOpen: false },
      primaryLabel: "Pause download (33%)",
    });
    render(<ModelDownloadCard download={download} variant="wizard" statusAnnouncerId="setup-download-status" />);
    expect(screen.getByText(/Download in progress: 33 percent/)).toBeTruthy();
  });
});
