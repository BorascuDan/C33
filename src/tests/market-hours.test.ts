import { describe, it, expect } from "@jest/globals";
import { DateTime } from "luxon";
import { ReflowService } from "../reflow/reflow.services.js";
import type {
  SettlementTask,
  SettlementChannel,
  OperatingHours,
  DayOfWeek,
} from "../reflow/types.js";

// Mon–Fri 08:00–16:00 UTC. (2024-01-15 is a Monday.)
const WEEKDAYS_8_16: OperatingHours[] = ([1, 2, 3, 4, 5] as DayOfWeek[]).map((d) => ({
  dayOfWeek: d,
  startHour: 8,
  endHour: 16,
}));

function channel(docId: string, operatingHours: OperatingHours[]): SettlementChannel {
  return {
    docId,
    docType: "settlementChannel",
    data: { name: docId, operatingHours, blackoutWindows: [] },
  };
}

interface TaskOpts {
  channel?: string;
  start?: string;
  durationMinutes?: number;
  deps?: string[];
}

/** endDate is kept consistent with start + duration (the "supposed" end). */
function task(docId: string, opts: TaskOpts = {}): SettlementTask {
  const { channel = "CH-1", start = "2024-01-15T08:00:00Z", durationMinutes = 60, deps = [] } = opts;
  const endDate = DateTime.fromISO(start, { zone: "utc" })
    .plus({ minutes: durationMinutes })
    .toISO({ suppressMilliseconds: true })!;
  return {
    docId,
    docType: "settlementTask",
    data: {
      taskReference: docId,
      tradeOrderId: "TRD-1",
      settlementChannelId: channel,
      startDate: start,
      endDate,
      durationMinutes,
      isRegulatoryHold: false,
      dependsOnTaskIds: deps,
      taskType: "fundTransfer",
    },
  };
}

const find = (tasks: SettlementTask[], id: string): SettlementTask =>
  tasks.find((t) => t.docId === id)!;

describe("ReflowService.reflow — market hours", () => {
  const svc = new ReflowService();
  const ch = channel("CH-1", WEEKDAYS_8_16);

  it("leaves a task that ends within operating hours unchanged", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", { start: "2024-01-15T09:00:00Z", durationMinutes: 60 })], // 09:00–10:00
      settlementChannels: [ch],
    });
    expect(result.changes).toEqual([]);
    expect(find(result.updatedTasks, "A").data.endDate).toBe("2024-01-15T10:00:00Z");
  });

  it("pushes the end past a market close (120 min from Mon 15:00 → Tue 09:00)", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", { start: "2024-01-15T15:00:00Z", durationMinutes: 120 })],
      settlementChannels: [ch],
    });

    const a = find(result.updatedTasks, "A");
    expect(a.data.startDate).toBe("2024-01-15T15:00:00Z"); // start unchanged
    expect(a.data.endDate).toBe("2024-01-16T09:00:00Z");

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      taskId: "A",
      newEndDate: "2024-01-16T09:00:00Z",
      delayMinutes: 960, // original end Mon 17:00 → Tue 09:00 = 16h
      triggeredBy: ["operatingHours"],
    });
  });

  it("handles multi-day spillover (600 min from Mon 15:00 → Wed 09:00)", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", { start: "2024-01-15T15:00:00Z", durationMinutes: 600 })],
      settlementChannels: [ch],
    });
    expect(find(result.updatedTasks, "A").data.endDate).toBe("2024-01-17T09:00:00Z");
  });

  it("leaves a task ending exactly at market close unchanged (exclusive end)", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", { start: "2024-01-15T14:00:00Z", durationMinutes: 120 })], // ends 16:00
      settlementChannels: [ch],
    });
    expect(result.changes).toEqual([]);
    expect(find(result.updatedTasks, "A").data.endDate).toBe("2024-01-15T16:00:00Z");
  });

  it("applies no constraint when the channel has no operating hours", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", { start: "2024-01-15T15:00:00Z", durationMinutes: 120 })],
      settlementChannels: [channel("CH-1", [])],
    });
    expect(result.changes).toEqual([]);
    expect(find(result.updatedTasks, "A").data.endDate).toBe("2024-01-15T17:00:00Z");
  });

  it("applies no constraint when no channels are provided", () => {
    const result = svc.reflow({
      settlementTasks: [task("A", { start: "2024-01-15T15:00:00Z", durationMinutes: 120 })],
    });
    expect(result.changes).toEqual([]);
    expect(find(result.updatedTasks, "A").data.endDate).toBe("2024-01-15T17:00:00Z");
  });

  it("moves the end out of an intra-day closed gap (lunch break)", () => {
    // Monday split shift: 08:00–12:00 and 13:00–17:00.
    const split: OperatingHours[] = [
      { dayOfWeek: 1, startHour: 8, endHour: 12 },
      { dayOfWeek: 1, startHour: 13, endHour: 17 },
    ];
    const result = svc.reflow({
      settlementTasks: [task("A", { start: "2024-01-15T11:00:00Z", durationMinutes: 90 })], // ends 12:30 (in gap)
      settlementChannels: [channel("CH-1", split)],
    });
    // spill = 12:30 − 12:00 = 30 min relocated after 13:00 reopen → 13:30
    expect(find(result.updatedTasks, "A").data.endDate).toBe("2024-01-15T13:30:00Z");
  });

  it("composes with dependencies: dependent starts after the market-hours-adjusted end", () => {
    const result = svc.reflow({
      settlementTasks: [
        task("A", { start: "2024-01-15T15:00:00Z", durationMinutes: 120 }), // → ends Tue 09:00
        task("B", { start: "2024-01-15T15:00:00Z", durationMinutes: 60, deps: ["A"] }),
      ],
      settlementChannels: [ch],
    });

    expect(find(result.updatedTasks, "A").data.endDate).toBe("2024-01-16T09:00:00Z");
    const b = find(result.updatedTasks, "B");
    expect(b.data.startDate).toBe("2024-01-16T09:00:00Z");
    expect(b.data.endDate).toBe("2024-01-16T10:00:00Z");

    const triggers = result.changes.flatMap((c) => c.triggeredBy);
    expect(triggers).toContain("operatingHours");
    expect(triggers).toContain("dependency");
  });
});
