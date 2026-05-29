import { describe, it, expect } from "@jest/globals";
import { DateTime } from "luxon";
import { ReflowService } from "../reflow/reflow.services.js";
import type { SettlementTask, TaskType } from "../reflow/types.js";

interface TaskOpts {
  channel?: string;
  start?: string;
  durationMinutes?: number;
  taskType?: TaskType;
  deps?: string[];
}

/** Task factory; endDate is kept consistent with start + duration so an
 *  unshifted task produces no change (isolates channel-conflict behavior). */
function task(docId: string, opts: TaskOpts = {}): SettlementTask {
  const {
    channel = "CH-1",
    start = "2024-01-15T08:00:00Z",
    durationMinutes = 60,
    taskType = "fundTransfer",
    deps = [],
  } = opts;
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
      taskType,
    },
  };
}

const find = (tasks: SettlementTask[], id: string): SettlementTask =>
  tasks.find((t) => t.docId === id)!;

describe("ReflowService.reflow — channel conflicts", () => {
  const svc = new ReflowService();

  it("bumps an overlapping task on the same channel+type to start when the first ends", () => {
    const tasks = [
      task("A", { channel: "CH-1", start: "2024-01-15T08:00:00Z", durationMinutes: 60 }), // 08:00–09:00
      task("B", { channel: "CH-1", start: "2024-01-15T08:30:00Z", durationMinutes: 60 }), // overlaps A
    ];
    const result = svc.reflow({ settlementTasks: tasks });

    const b = find(result.updatedTasks, "B");
    expect(b.data.startDate).toBe("2024-01-15T09:00:00Z");
    expect(b.data.endDate).toBe("2024-01-15T10:00:00Z");

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      taskId: "B",
      newStartDate: "2024-01-15T09:00:00Z",
      newEndDate: "2024-01-15T10:00:00Z",
      delayMinutes: 30, // original end 09:30 -> new end 10:00
      triggeredBy: ["channelConflict"],
    });
  });

  it("leaves adjacent (non-overlapping) tasks on the same lane unchanged", () => {
    const tasks = [
      task("A", { channel: "CH-1", start: "2024-01-15T08:00:00Z", durationMinutes: 60 }), // 08:00–09:00
      task("B", { channel: "CH-1", start: "2024-01-15T09:00:00Z", durationMinutes: 60 }), // 09:00–10:00 (touches, no overlap)
    ];
    const result = svc.reflow({ settlementTasks: tasks });
    expect(result.changes).toEqual([]);
    expect(find(result.updatedTasks, "B").data.startDate).toBe("2024-01-15T09:00:00Z");
  });

  it("cascades three overlapping tasks on the same lane", () => {
    const tasks = [
      task("A", { channel: "CH-1", start: "2024-01-15T08:00:00Z", durationMinutes: 60 }),
      task("B", { channel: "CH-1", start: "2024-01-15T08:00:00Z", durationMinutes: 60 }),
      task("C", { channel: "CH-1", start: "2024-01-15T08:00:00Z", durationMinutes: 60 }),
    ];
    const result = svc.reflow({ settlementTasks: tasks });

    expect(find(result.updatedTasks, "A").data.startDate).toBe("2024-01-15T08:00:00Z");
    expect(find(result.updatedTasks, "B").data.startDate).toBe("2024-01-15T09:00:00Z");
    expect(find(result.updatedTasks, "C").data.startDate).toBe("2024-01-15T10:00:00Z");
    expect(result.changes).toHaveLength(2); // B and C bumped, A stayed
    expect(result.changes.every((c) => c.triggeredBy.includes("channelConflict"))).toBe(true);
  });

  it("places the earliest-starting task first regardless of input order, preserving output order", () => {
    const tasks = [
      task("B", { channel: "CH-1", start: "2024-01-15T08:30:00Z", durationMinutes: 60 }), // listed first
      task("A", { channel: "CH-1", start: "2024-01-15T08:00:00Z", durationMinutes: 60 }), // earlier start
    ];
    const result = svc.reflow({ settlementTasks: tasks });

    // A (earlier) keeps its slot; B is bumped after A.
    expect(find(result.updatedTasks, "A").data.startDate).toBe("2024-01-15T08:00:00Z");
    expect(find(result.updatedTasks, "B").data.startDate).toBe("2024-01-15T09:00:00Z");
    // Output preserves input order.
    expect(result.updatedTasks.map((t) => t.docId)).toEqual(["B", "A"]);
  });

  it("treats different channels independently (no conflict)", () => {
    const tasks = [
      task("A", { channel: "CH-1", start: "2024-01-15T08:00:00Z", durationMinutes: 60 }),
      task("B", { channel: "CH-2", start: "2024-01-15T08:00:00Z", durationMinutes: 60 }),
    ];
    const result = svc.reflow({ settlementTasks: tasks });
    expect(result.changes).toEqual([]);
    expect(find(result.updatedTasks, "B").data.startDate).toBe("2024-01-15T08:00:00Z");
  });

  // Documents the current channel+type lane design: two DIFFERENT task types may
  // overlap on the same channel without being bumped. (The spec defines channel
  // conflict per-channel; switching the key to channelId-only would bump here.)
  it("does NOT bump overlapping tasks of different types on the same channel (channel+type key)", () => {
    const tasks = [
      task("A", { channel: "CH-1", taskType: "fundTransfer", start: "2024-01-15T08:00:00Z", durationMinutes: 60 }),
      task("B", { channel: "CH-1", taskType: "marginCheck", start: "2024-01-15T08:30:00Z", durationMinutes: 60 }),
    ];
    const result = svc.reflow({ settlementTasks: tasks });
    expect(result.changes).toEqual([]);
    expect(find(result.updatedTasks, "B").data.startDate).toBe("2024-01-15T08:30:00Z");
  });
});
