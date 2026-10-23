import { parseJsonResponse } from "../../scraper/anaf.js";

describe("parseJsonResponse", () => {
  test("returns the parsed JSON body", async () => {
    const res = { status: 200, json: async () => ({ a: 1 }) };
    await expect(parseJsonResponse(res, "X")).resolves.toEqual({ a: 1 });
  });

  test("turns an HTML error page into a clear error", async () => {
    const res = { status: 200, json: async () => JSON.parse("<!DOCTYPE html><html></html>") };
    await expect(parseJsonResponse(res, "CUIScan"))
      .rejects.toThrow(/CUIScan returned a non-JSON response \(HTTP 200\)/);
  });
});
