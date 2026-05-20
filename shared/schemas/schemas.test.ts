// =============================================================================
// shared/schemas のユニットテスト
// `pnpm test:unit` で実行する (node:test / experimental-strip-types)
//
// 各スキーマの「受け取れるべき例」「弾くべき例」を 1〜2 ケースずつ確認する。
// =============================================================================
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isoDateSchema,
  isoDateTimeSchema,
  serviceProviderSchema,
  syncStatusSchema,
} from "./common.ts";
import {
  googleEventsListResponseSchema,
  ouraSleepResponseSchema,
  summaryRequestSchema,
  summaryResponseSchema,
  togglTimeEntriesResponseSchema,
} from "./index.ts";

describe("common schemas", () => {
  it("isoDateSchema は YYYY-MM-DD を受け、'today' を弾く", () => {
    assert.equal(isoDateSchema.parse("2026-05-20"), "2026-05-20");
    assert.equal(isoDateSchema.safeParse("today").success, false);
    assert.equal(isoDateSchema.safeParse("2026-5-20").success, false);
  });

  it("isoDateTimeSchema はオフセット付き ISO 8601 を要求する", () => {
    assert.equal(
      isoDateTimeSchema.safeParse("2026-05-20T01:23:45+09:00").success,
      true,
    );
    assert.equal(
      isoDateTimeSchema.safeParse("2026-05-20T01:23:45Z").success,
      true,
    );
    // オフセット無しは弾く
    assert.equal(
      isoDateTimeSchema.safeParse("2026-05-20T01:23:45").success,
      false,
    );
  });

  it("serviceProviderSchema は oura/google/toggl のみ受ける", () => {
    assert.equal(serviceProviderSchema.safeParse("oura").success, true);
    assert.equal(serviceProviderSchema.safeParse("notion").success, false);
  });

  it("syncStatusSchema は 4 状態のみ受ける", () => {
    for (const s of ["idle", "in_progress", "success", "failed"] as const) {
      assert.equal(syncStatusSchema.safeParse(s).success, true);
    }
    assert.equal(syncStatusSchema.safeParse("pending").success, false);
  });
});

describe("/api/summary I/O", () => {
  it("summaryRequestSchema は date クエリだけ受ける", () => {
    assert.deepEqual(summaryRequestSchema.parse({ date: "2026-05-20" }), {
      date: "2026-05-20",
    });
    assert.equal(
      summaryRequestSchema.safeParse({ date: "today" }).success,
      false,
    );
  });

  it("summaryResponseSchema は最小構造を通す", () => {
    const ok = summaryResponseSchema.safeParse({
      target_date: "2026-05-20",
      timezone: "Asia/Tokyo",
      wake_range: null,
      todays_me: { oura: null, google: null, toggl: null },
      timeline: { sleep: [], calendar: [], toggl: [] },
      sync_statuses: [],
    });
    assert.equal(ok.success, true);
  });

  it("summaryResponseSchema は errors を optional として受ける", () => {
    const ok = summaryResponseSchema.safeParse({
      target_date: "2026-05-20",
      timezone: "Asia/Tokyo",
      wake_range: {
        start: "2026-05-20T07:00:00+09:00",
        end: "2026-05-20T12:00:00+09:00",
      },
      todays_me: { oura: null, google: null, toggl: null },
      timeline: { sleep: [], calendar: [], toggl: [] },
      sync_statuses: [],
      errors: [{ service: "google", message: "token expired" }],
    });
    assert.equal(ok.success, true);
  });
});

describe("external API schemas", () => {
  it("ouraSleepResponseSchema は data 配列を受ける", () => {
    const parsed = ouraSleepResponseSchema.parse({
      data: [
        {
          id: "sleep-1",
          day: "2026-05-20",
          bedtime_start: "2026-05-19T23:00:00+09:00",
          bedtime_end: "2026-05-20T07:00:00+09:00",
          total_sleep_duration: 28800,
        },
      ],
    });
    assert.equal(parsed.data.length, 1);
  });

  it("googleEventsListResponseSchema は dateTime のみの予定を受ける", () => {
    const parsed = googleEventsListResponseSchema.parse({
      items: [
        {
          id: "evt-1",
          status: "confirmed",
          summary: "MTG",
          start: { dateTime: "2026-05-20T10:00:00+09:00" },
          end: { dateTime: "2026-05-20T10:30:00+09:00" },
        },
      ],
    });
    assert.equal(parsed.items[0]?.id, "evt-1");
  });

  it("googleEventsListResponseSchema は終日予定 (date のみ) を受ける", () => {
    const parsed = googleEventsListResponseSchema.parse({
      items: [
        {
          id: "evt-2",
          start: { date: "2026-05-20" },
          end: { date: "2026-05-21" },
        },
      ],
    });
    assert.equal(parsed.items.length, 1);
  });

  it("googleEventsListResponseSchema は date も dateTime も無い start を弾く", () => {
    const result = googleEventsListResponseSchema.safeParse({
      items: [{ id: "evt-3", start: {}, end: {} }],
    });
    assert.equal(result.success, false);
  });

  it("togglTimeEntriesResponseSchema は配列レスポンスを受ける", () => {
    const parsed = togglTimeEntriesResponseSchema.parse([
      {
        id: 123,
        description: "Work",
        start: "2026-05-20T09:00:00+09:00",
        stop: "2026-05-20T11:00:00+09:00",
        duration: 7200,
      },
      // 進行中エントリ (stop null / duration 負値)
      {
        id: 124,
        description: null,
        start: "2026-05-20T11:30:00+09:00",
        stop: null,
        duration: -1,
      },
    ]);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[1]?.stop, null);
  });
});
