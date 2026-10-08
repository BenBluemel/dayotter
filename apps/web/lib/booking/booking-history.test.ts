import { describe, expect, it } from "vitest";
import { historySearchPatterns, normalizeHistoryStatus } from "./booking-history";

describe("booking history search input", () => {
  it("escapes percent, underscore and the escape character literally", () => {
    expect(historySearchPatterns("50%_!")).toEqual({
      prefix: "50!%!_!!%",
      substring: "%50!%!_!!%",
    });
    expect(historySearchPatterns("a\\b").substring).toBe("%a\\b%");
  });
  it("allows only existing history status filters", () => {
    expect(normalizeHistoryStatus("cancelled")).toBe("cancelled");
    expect(normalizeHistoryStatus("confirmed")).toBe("confirmed");
    expect(normalizeHistoryStatus("rejected")).toBe("all");
    expect(normalizeHistoryStatus("' or true")).toBe("all");
    expect(normalizeHistoryStatus()).toBe("all");
  });
});
