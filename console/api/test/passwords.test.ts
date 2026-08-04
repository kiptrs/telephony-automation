import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/passwords.js";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "Correct horse battery staple")).toBe(false);
  });

  it("produces a different hash each time, so equal passwords are not linkable", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("uses argon2id", async () => {
    expect(await hashPassword("x")).toMatch(/^\$argon2id\$/);
  });

  it("returns false rather than throwing on a corrupt hash", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});
