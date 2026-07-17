import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { UpdateToast } from "./UpdateToast.js";

const KEY = "r3dvoice.lastSeenVersion";

describe("UpdateToast", () => {
  beforeEach(() => {
    localStorage.clear();
    (window as any).r3dvoice = {
      getAppVersion: vi.fn().mockResolvedValue("0.9.0"),
      openExternal: vi.fn(),
    };
  });
  afterEach(() => {
    cleanup();
  });

  it("does not render on first install (null localStorage)", async () => {
    const { container } = render(<UpdateToast />);
    await waitFor(() => {
      expect(localStorage.getItem(KEY)).toBe("0.9.0");
    });
    expect(container.querySelector("[data-rv='update-toast']")).toBeNull();
  });

  it("does not render when versions match", async () => {
    localStorage.setItem(KEY, "0.9.0");
    const { container } = render(<UpdateToast />);
    await waitFor(() => {
      expect((window as any).r3dvoice.getAppVersion).toHaveBeenCalled();
    });
    expect(container.querySelector("[data-rv='update-toast']")).toBeNull();
  });

  it("renders when versions differ", async () => {
    localStorage.setItem(KEY, "0.8.1");
    const { findByTestId } = render(<UpdateToast />);
    const toast = await findByTestId("update-toast");
    expect(toast.textContent).toContain("0.9.0");
  });

  it("dismiss writes new version + unmounts toast", async () => {
    localStorage.setItem(KEY, "0.8.1");
    const { findByTestId, queryByTestId } = render(<UpdateToast />);
    const toast = await findByTestId("update-toast");
    const dismissBtn = toast.querySelector("[data-rv='dismiss']") as HTMLButtonElement;
    fireEvent.click(dismissBtn);
    expect(localStorage.getItem(KEY)).toBe("0.9.0");
    expect(queryByTestId("update-toast")).toBeNull();
  });

  it("clicking the toast invokes openExternal + writes new version", async () => {
    localStorage.setItem(KEY, "0.8.1");
    const { findByTestId } = render(<UpdateToast />);
    const toast = await findByTestId("update-toast");
    const link = toast.querySelector("[data-rv='whatsnew']") as HTMLButtonElement;
    fireEvent.click(link);
    expect((window as any).r3dvoice.openExternal).toHaveBeenCalledWith(
      "https://github.com/R3dWolfie/R3DVoice/releases/tag/v0.9.0",
    );
    expect(localStorage.getItem(KEY)).toBe("0.9.0");
  });
});
