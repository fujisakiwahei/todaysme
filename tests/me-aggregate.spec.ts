import { expect, test } from "@playwright/test";

import type { SummaryResponse } from "../shared/schemas";
import { calculateMeAggregate } from "../app/utils/meAggregate";

function createSummary(): SummaryResponse {
  return {
    target_date: "2026-05-16",
    timezone: "Asia/Tokyo",
    // JST 04:00〜15:00 = 11時間。06:00〜11:00の二度寝を引くと覚醒6時間。
    wake_range: {
      start: "2026-05-15T19:00:00.000Z",
      end: "2026-05-16T06:00:00.000Z",
    },
    todays_me: {
      oura: {
        sleep_minutes: 690,
        time_in_bed_minutes: 780,
        wake_at: "2026-05-15T19:00:00.000Z",
        sessions: [
          {
            sleep_start_at: "2026-05-15T11:00:00.000Z",
            wake_at: "2026-05-15T19:00:00.000Z",
            sleep_minutes: 420,
            time_in_bed_minutes: 480,
          },
          {
            sleep_start_at: "2026-05-15T21:00:00.000Z",
            wake_at: "2026-05-16T02:00:00.000Z",
            sleep_minutes: 270,
            time_in_bed_minutes: 300,
          },
        ],
      },
      google: {
        total_minutes: 150,
        events: [],
      },
      toggl: {
        total_minutes: 120,
        by_title: [],
      },
      todoist: null,
    },
    timeline: {
      sleep: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          sleep_start_at: "2026-05-15T11:00:00.000Z",
          wake_at: "2026-05-15T19:00:00.000Z",
          sleep_minutes: 420,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          sleep_start_at: "2026-05-15T21:00:00.000Z",
          wake_at: "2026-05-16T02:00:00.000Z",
          sleep_minutes: 270,
        },
      ],
      calendar: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          google_event_id: "before-nap",
          calendar_id: "calendar",
          calendar_name: "予定",
          title: "朝の予定",
          start_at: "2026-05-15T19:30:00.000Z",
          end_at: "2026-05-15T20:30:00.000Z",
          is_excluded: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          google_event_id: "during-nap",
          calendar_id: "calendar",
          calendar_name: "予定",
          title: "睡眠中の予定",
          start_at: "2026-05-15T22:00:00.000Z",
          end_at: "2026-05-15T23:00:00.000Z",
          is_excluded: false,
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          google_event_id: "crosses-wake",
          calendar_id: "calendar",
          calendar_name: "予定",
          title: "起床をまたぐ予定",
          start_at: "2026-05-16T01:30:00.000Z",
          end_at: "2026-05-16T02:30:00.000Z",
          is_excluded: false,
        },
      ],
      toggl: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          toggl_entry_id: "after-nap",
          title: "作業",
          project_id: null,
          project_name: null,
          start_at: "2026-05-16T03:00:00.000Z",
          end_at: "2026-05-16T04:00:00.000Z",
        },
        {
          id: "77777777-7777-4777-8777-777777777777",
          toggl_entry_id: "during-nap",
          title: "睡眠中の記録",
          project_id: null,
          project_name: null,
          start_at: "2026-05-16T00:00:00.000Z",
          end_at: "2026-05-16T01:00:00.000Z",
        },
      ],
    },
    sync_statuses: [],
  };
}

test("二度寝を覚醒時間とアクティブ時間から除外する", () => {
  expect(calculateMeAggregate(createSummary())).toEqual({
    awakeMin: 360,
    activeMin: 150,
    unrecordedMin: 210,
    activeRatio: 42,
  });
});

test("Today's MEカードに覚醒時間を表示する", async ({ page }) => {
  await page.route("**/api/demo/summary?**", async (route) => {
    await route.fulfill({ json: createSummary() });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:3000/demo/daily/2026-05-16");

  const metric = page.locator(".metric--me");
  await expect(metric).toBeVisible();
  await expect(metric.locator(".metric--me__caption")).toHaveText("覚醒時間");
  await expect(metric.locator(".metric--me__value .metric__value")).toContainText("6h00m");
  await expect(metric.locator(".metric--me__list > div").nth(0)).toContainText("42%");
  await expect(metric.locator(".metric--me__list > div").nth(0)).toContainText("2h 30m");
  await expect(metric.locator(".metric--me__list > div").nth(1)).toContainText("3h 30m");
  await metric.screenshot({ path: "tests/metric-me-awake-time.png" });
});
