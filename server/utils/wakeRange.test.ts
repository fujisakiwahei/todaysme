// Node 標準の test runner で実行できる軽量テスト。
// `pnpm test:unit` で起動する。
//
// 検証対象:
//   - targetDateOf (タイムゾーン跨ぎ / DST 境界)
//   - computeWakeRange (当日 / 過去日 / 該当 wake なし / 次睡眠なし)
//   - overlaps (完全外 / 端点接触 / 部分重なり / 内包 / 進行中エントリ)

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type SleepRecordLike,
  computeWakeRange,
  overlaps,
  targetDateOf,
} from "./wakeRange";

describe("targetDateOf", () => {
  it("UTC 表現の wake_at を Asia/Tokyo の起床日に変換する", () => {
    // 2026-05-15 22:00 UTC == 2026-05-16 07:00 JST
    assert.equal(
      targetDateOf("2026-05-15T22:00:00Z", "Asia/Tokyo"),
      "2026-05-16",
    );
  });

  it("Asia/Tokyo と UTC で起床日が異なる境界ケース", () => {
    // 2026-05-16 14:59 UTC == 2026-05-16 23:59 JST (まだ同日)
    assert.equal(
      targetDateOf("2026-05-16T14:59:00Z", "Asia/Tokyo"),
      "2026-05-16",
    );
    // 2026-05-16 15:00 UTC == 2026-05-17 00:00 JST (翌日になる)
    assert.equal(
      targetDateOf("2026-05-16T15:00:00Z", "Asia/Tokyo"),
      "2026-05-17",
    );
  });

  it("America/Los_Angeles の DST 切替前後", () => {
    // 2026-03-08 はアメリカ夏時間開始 (02:00 PST -> 03:00 PDT)
    // 2026-03-08 09:00 UTC == 02:00 PST (DST 前)
    assert.equal(
      targetDateOf("2026-03-08T09:00:00Z", "America/Los_Angeles"),
      "2026-03-08",
    );
    // 2026-03-08 10:30 UTC == 03:30 PDT (DST 後)
    assert.equal(
      targetDateOf("2026-03-08T10:30:00Z", "America/Los_Angeles"),
      "2026-03-08",
    );
  });

  it("Date オブジェクトを入力として受け付ける", () => {
    const d = new Date("2026-05-16T22:00:00Z");
    assert.equal(targetDateOf(d, "Asia/Tokyo"), "2026-05-17");
  });

  it("不正な日付では TypeError を投げる", () => {
    assert.throws(() => targetDateOf("not-a-date", "Asia/Tokyo"), TypeError);
  });
});

describe("computeWakeRange", () => {
  const TZ = "Asia/Tokyo";

  const sleeps: SleepRecordLike[] = [
    // 2026-05-15 起床
    {
      sleep_start_at: "2026-05-14T14:00:00Z", // 14日 23:00 JST 入眠
      wake_at: "2026-05-14T22:00:00Z", //       15日 07:00 JST 起床
    },
    // 2026-05-16 起床
    {
      sleep_start_at: "2026-05-15T14:30:00Z", // 15日 23:30 JST 入眠
      wake_at: "2026-05-15T22:00:00Z", //       16日 07:00 JST 起床
    },
    // 2026-05-17 起床
    {
      sleep_start_at: "2026-05-16T15:00:00Z", // 17日 00:00 JST 入眠
      wake_at: "2026-05-16T23:00:00Z", //       17日 08:00 JST 起床
    },
  ];

  it("過去日: その日の wake_at 〜 次の睡眠開始", () => {
    const range = computeWakeRange("2026-05-16", sleeps, {
      timezone: TZ,
      now: new Date("2026-05-17T10:00:00Z"),
    });
    assert.ok(range);
    assert.equal(range.start.toISOString(), "2026-05-15T22:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-05-16T15:00:00.000Z");
  });

  it("当日: その日の wake_at 〜 現在時刻", () => {
    // now = 2026-05-17 17:00 JST (target_date == 今日)
    const now = new Date("2026-05-17T08:00:00Z");
    const range = computeWakeRange("2026-05-17", sleeps, { timezone: TZ, now });
    assert.ok(range);
    assert.equal(range.start.toISOString(), "2026-05-16T23:00:00.000Z");
    assert.equal(range.end.toISOString(), now.toISOString());
  });

  it("該当する wake_at がない場合は null", () => {
    const range = computeWakeRange("2026-05-20", sleeps, {
      timezone: TZ,
      now: new Date("2026-05-20T10:00:00Z"),
    });
    assert.equal(range, null);
  });

  it("過去日で次の睡眠記録が無い場合は 24h 後をフォールバックにする", () => {
    const onlyOne: SleepRecordLike[] = [sleeps[2]!];
    const range = computeWakeRange("2026-05-17", onlyOne, {
      timezone: TZ,
      // now を 2026-05-19 にして「当日」ではないようにする
      now: new Date("2026-05-19T10:00:00Z"),
    });
    assert.ok(range);
    assert.equal(range.start.toISOString(), "2026-05-16T23:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-05-17T23:00:00.000Z");
  });

  it("ソートされていない入力でも正しく処理する", () => {
    const shuffled = [sleeps[2]!, sleeps[0]!, sleeps[1]!];
    const range = computeWakeRange("2026-05-16", shuffled, {
      timezone: TZ,
      now: new Date("2026-05-17T10:00:00Z"),
    });
    assert.ok(range);
    assert.equal(range.start.toISOString(), "2026-05-15T22:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-05-16T15:00:00.000Z");
  });
});

describe("overlaps", () => {
  const range = {
    start: new Date("2026-05-16T22:00:00Z"),
    end: new Date("2026-05-17T13:00:00Z"),
  };

  it("完全に範囲外 (前) は false", () => {
    assert.equal(
      overlaps(range, "2026-05-16T10:00:00Z", "2026-05-16T20:00:00Z"),
      false,
    );
  });

  it("完全に範囲外 (後) は false", () => {
    assert.equal(
      overlaps(range, "2026-05-17T14:00:00Z", "2026-05-17T20:00:00Z"),
      false,
    );
  });

  it("端点接触 (隣接) は false (半開区間扱い)", () => {
    assert.equal(
      overlaps(range, "2026-05-17T13:00:00Z", "2026-05-17T15:00:00Z"),
      false,
    );
    assert.equal(
      overlaps(range, "2026-05-16T20:00:00Z", "2026-05-16T22:00:00Z"),
      false,
    );
  });

  it("部分的に重なる場合は true", () => {
    assert.equal(
      overlaps(range, "2026-05-16T21:00:00Z", "2026-05-16T23:00:00Z"),
      true,
    );
    assert.equal(
      overlaps(range, "2026-05-17T12:00:00Z", "2026-05-17T15:00:00Z"),
      true,
    );
  });

  it("range を内包するイベントは true", () => {
    assert.equal(
      overlaps(range, "2026-05-15T00:00:00Z", "2026-05-18T00:00:00Z"),
      true,
    );
  });

  it("range に内包されるイベントは true", () => {
    assert.equal(
      overlaps(range, "2026-05-17T00:00:00Z", "2026-05-17T05:00:00Z"),
      true,
    );
  });

  it("end が null (進行中エントリ) は range.end までを範囲とみなす", () => {
    assert.equal(overlaps(range, "2026-05-17T12:00:00Z", null), true);
    assert.equal(overlaps(range, "2026-05-17T14:00:00Z", null), false);
  });
});
