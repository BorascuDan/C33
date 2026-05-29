import { describe, it, expect } from "@jest/globals";
import { DateTime } from "luxon";
import { ReflowService } from "../reflow/reflow.services.js";
import type {
  SettlementTask,
  SettlementChannel,
  OperatingHours,
  BlackoutWindow,
  DayOfWeek,
} from "../reflow/types.js";

// Open 24/7 so the market-hours pass is a no-op and these tests isolate blackouts.
const ALWAYS_OPEN: OperatingHours[] = ([0, 1, 2, 3, 4, 5, 6] as DayOfWeek[]).map((d) => ({
  dayOfWeek: d,
  startHour: 0,
  endHour: 24,
}));
// Mon–Fri 08:00–16:00 UTC, for the composition test. (2024-01-15 is a Monday.)
const WEEKDAYS_8_16: OperatingHours[] = ([1, 2, 3, 4, 5] as DayOfWeek[]).map((d) => ({
  dayOfWeek: d,
  startHour: 8,
  endHour: 16,
}));

function channel(
  blackoutWindows: BlackoutWindow[],
  operatingHours: OperatingHours[] = ALWAYS_OPEN,
): SettlementChannel {
  return {
    docId: "CH-1",
    docType: "settlementChannel",
    data: { name: "Domestic Wire Desk", operatingHours, blackoutWindows },
  };
}

function task(docId: string, start: string, durationMinutes: number): SettlementTask {
  const endDate = DateTime.fromISO(start, { zone: "utc" })
    .plus({ minutes: durationMinutes })
    .toISO({ suppressMilliseconds: true })!;
  return {
    docId,
    docType: "settlementTask",
    data: {
      taskReference: docId,
      tradeOrderId: "TRD-1",
      settlementChannelId: "CH-1",
      startDate: start,
      endDate,
      durationMinutes,
      isRegulatoryHold: false,
      dependsOnTaskIds: [],
      taskType: "fundTransfer",
    },
  };
}

const first = (tasks: SettlementTask[]) => tasks[0]!;

describe("ReflowService.reflow — blackout windows", () => {
  const svc = new ReflowService();

  it("leaves a task that does not overlap any blackout unchanged", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", "2024-01-15T08:00:00Z", 60)], // 08:00–09:00
      settlementChannels: [channel([{ startDate: "2024-01-15T12:00:00Z", endDate: "2024-01-15T13:00:00Z" }])],
    });
    expect(result.changes).toEqual([]);
    expect(first(result.updatedTasks).data.endDate).toBe("2024-01-15T09:00:00Z");
  });

  it("extends the end past a blackout the task overlaps", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", "2024-01-15T08:00:00Z", 60)], // ends 09:00
      settlementChannels: [channel([{ startDate: "2024-01-15T08:30:00Z", endDate: "2024-01-15T09:00:00Z" }])], // 30m blocked
    });

    const a = first(result.updatedTasks);
    expect(a.data.startDate).toBe("2024-01-15T08:00:00Z"); // start unchanged
    expect(a.data.endDate).toBe("2024-01-15T09:30:00Z"); // +30m of blocked time

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      taskId: "A",
      newEndDate: "2024-01-15T09:30:00Z",
      delayMinutes: 30,
      triggeredBy: ["blackoutWindow"],
    });
  });

  it("leaves a task ending exactly at a blackout's start unchanged (adjacent, no overlap)", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", "2024-01-15T08:00:00Z", 60)], // ends 09:00
      settlementChannels: [channel([{ startDate: "2024-01-15T09:00:00Z", endDate: "2024-01-15T10:00:00Z" }])],
    });
    expect(result.changes).toEqual([]);
    expect(first(result.updatedTasks).data.endDate).toBe("2024-01-15T09:00:00Z");
  });

  it("extends across multiple blackouts the task spans", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", "2024-01-15T08:00:00Z", 120)], // ends 10:00
      settlementChannels: [
        channel([
          { startDate: "2024-01-15T08:30:00Z", endDate: "2024-01-15T08:45:00Z" }, // 15m
          { startDate: "2024-01-15T09:15:00Z", endDate: "2024-01-15T09:30:00Z" }, // 15m
        ]),
      ],
    });
    expect(first(result.updatedTasks).data.endDate).toBe("2024-01-15T10:30:00Z"); // +30m total
  });

  it("applies no constraint when the channel has no blackout windows", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", "2024-01-15T08:00:00Z", 60)],
      settlementChannels: [channel([])],
    });
    expect(result.changes).toEqual([]);
    expect(first(result.updatedTasks).data.endDate).toBe("2024-01-15T09:00:00Z");
  });

  it("composes with market hours: blackout near the close pushes the end into the next session", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", "2024-01-15T15:30:00Z", 30)], // ends 16:00
      settlementChannels: [
        channel([{ startDate: "2024-01-15T15:40:00Z", endDate: "2024-01-15T15:50:00Z" }], WEEKDAYS_8_16),
      ],
    });

    // blackout pushes end to 16:10 (past the 16:00 close), then market hours
    // relocates the 10m spillover to the next open → Tue 08:10.
    expect(first(result.updatedTasks).data.endDate).toBe("2024-01-16T08:10:00Z");
    const triggers = result.changes.flatMap((c) => c.triggeredBy);
    expect(triggers).toContain("blackoutWindow");
    expect(triggers).toContain("operatingHours");
  });
});
