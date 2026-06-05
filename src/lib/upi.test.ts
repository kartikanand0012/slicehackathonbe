import { describe, test, expect } from "vitest";
import { buildUpiIntent, isValidVpa } from "./upi";

describe("isValidVpa", () => {
  test("accepts standard handles", () => {
    expect(isValidVpa("alice@okhdfc")).toBe(true);
    expect(isValidVpa("user.name@paytm")).toBe(true);
    expect(isValidVpa("a-b_c.d@ybl")).toBe(true);
  });

  test("rejects malformed handles", () => {
    expect(isValidVpa("no-at-sign")).toBe(false);
    expect(isValidVpa("@bank")).toBe(false);
    expect(isValidVpa("user@")).toBe(false);
    expect(isValidVpa("user@bank.com")).toBe(false);
  });
});

describe("buildUpiIntent", () => {
  test("builds a valid upi://pay URI", () => {
    const uri = buildUpiIntent({
      payeeVpa: "alice@okhdfc",
      payeeName: "Alice",
      amountPaise: 12500,
      note: "Goa trip",
      transactionRef: "set_123",
    });
    expect(uri).toMatch(/^upi:\/\/pay\?/);
    const url = new URL(uri);
    expect(url.searchParams.get("pa")).toBe("alice@okhdfc");
    expect(url.searchParams.get("pn")).toBe("Alice");
    expect(url.searchParams.get("am")).toBe("125.00");
    expect(url.searchParams.get("cu")).toBe("INR");
    expect(url.searchParams.get("tn")).toBe("Goa trip");
    expect(url.searchParams.get("tr")).toBe("set_123");
  });

  test("formats amount with exactly 2 decimals", () => {
    const uri = buildUpiIntent({
      payeeVpa: "x@bank",
      payeeName: "X",
      amountPaise: 1,
    });
    expect(new URL(uri).searchParams.get("am")).toBe("0.01");
  });

  test("encodes spaces and special chars in note", () => {
    const uri = buildUpiIntent({
      payeeVpa: "x@bank",
      payeeName: "Mr & Mrs",
      amountPaise: 10000,
      note: "café 50%",
    });
    expect(uri).toContain("pn=Mr+%26+Mrs");
    expect(uri).toContain("tn=caf%C3%A9+50%25");
  });

  test("throws on invalid VPA", () => {
    expect(() =>
      buildUpiIntent({ payeeVpa: "bad", payeeName: "x", amountPaise: 100 }),
    ).toThrow(RangeError);
  });

  test("throws on non-positive amount", () => {
    expect(() =>
      buildUpiIntent({ payeeVpa: "x@bank", payeeName: "x", amountPaise: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      buildUpiIntent({ payeeVpa: "x@bank", payeeName: "x", amountPaise: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      buildUpiIntent({ payeeVpa: "x@bank", payeeName: "x", amountPaise: 1.5 }),
    ).toThrow(RangeError);
  });
});
