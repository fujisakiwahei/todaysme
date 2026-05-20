// =============================================================================
// server/utils/validation のユニットテスト
// =============================================================================
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import { parseExternal, parseOrThrow } from "./validation.ts";

describe("parseOrThrow", () => {
  const schema = z.object({ name: z.string() });

  it("成功時はパース結果を返す", () => {
    const result = parseOrThrow(schema, { name: "ok" });
    assert.deepEqual(result, { name: "ok" });
  });

  it("失敗時は statusCode 400 の HTTP エラーを投げる", () => {
    try {
      parseOrThrow(schema, { name: 123 });
      assert.fail("should throw");
    } catch (err) {
      const e = err as {
        statusCode: number;
        statusMessage: string;
        data: { issues: Array<{ path: PropertyKey[]; message: string }> };
      };
      assert.equal(e.statusCode, 400);
      assert.equal(e.statusMessage, "ValidationError");
      assert.equal(Array.isArray(e.data.issues), true);
      assert.equal(e.data.issues[0]?.path[0], "name");
    }
  });

  it("options.statusCode / statusMessage を上書きできる", () => {
    try {
      parseOrThrow(schema, {}, { statusCode: 422, statusMessage: "Custom" });
      assert.fail("should throw");
    } catch (err) {
      const e = err as { statusCode: number; statusMessage: string };
      assert.equal(e.statusCode, 422);
      assert.equal(e.statusMessage, "Custom");
    }
  });
});

describe("parseExternal", () => {
  const schema = z.object({ id: z.string() });

  it("成功時はパース結果を返す", () => {
    assert.deepEqual(parseExternal(schema, { id: "a" }, "oura"), { id: "a" });
  });

  it("失敗時は 502 + サービス名入り statusMessage を投げる", () => {
    try {
      parseExternal(schema, {}, "google");
      assert.fail("should throw");
    } catch (err) {
      const e = err as { statusCode: number; statusMessage: string };
      assert.equal(e.statusCode, 502);
      assert.equal(e.statusMessage, "InvalidExternalResponse:google");
    }
  });
});
