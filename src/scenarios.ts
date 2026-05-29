import { DateTime } from "luxon";
import type {
  ReflowInput,
  SettlementTask,
  SettlementChannel,
  TradeOrder,
  TaskType,
  DayOfWeek,
  OperatingHours,
  BlackoutWindow,
} from "./reflow/types.js";

// ─── Small builders to keep the sample data readable ─────────────────────────

const endFrom = (start: string, durationMinutes: number): string =>
  DateTime.fromISO(start, { zone: "utc" }).plus({ minutes: durationMinutes }).toISO({
    suppressMilliseconds: true,
  })!;

function task(
  docId: string,
  taskType: TaskType,
  settlementChannelId: string,
  start: string,
  durationMinutes: number,
  opts: { deps?: string[]; tradeOrderId?: string; isRegulatoryHold?: boolean } = {},
): SettlementTask {
  const { deps = [], tradeOrderId = "TRD-1", isRegulatoryHold = false } = opts;
  return {
    docId,
    docType: "settlementTask",
    data: {
      taskReference: docId,
      tradeOrderId,
      settlementChannelId,
      startDate: start,
      endDate: endFrom(start, durationMinutes),
      durationMinutes,
      isRegulatoryHold,
      dependsOnTaskIds: deps,
      taskType,
    },
  };
}

function channel(
  docId: string,
  name: string,
  operatingHours: OperatingHours[],
  blackoutWindows: BlackoutWindow[] = [],
): SettlementChannel {
  return { docId, docType: "settlementChannel", data: { name, operatingHours, blackoutWindows } };
}

function order(docId: string, tradeOrderNumber: string, settlementDate: string): TradeOrder {
  return {
    docId,
    docType: "tradeOrder",
    data: { tradeOrderNumber, instrumentId: "US0000000000", quantity: 1_000_000, settlementDate },
  };
}

// Mon–Fri 08:00–16:00 UTC. (2024-01-15 is a Monday.)
const MARKET_HOURS: OperatingHours[] = ([1, 2, 3, 4, 5] as DayOfWeek[]).map((d) => ({
  dayOfWeek: d,
  startHour: 8,
  endHour: 16,
}));

export interface Scenario {
  name: string;
  description: string;
  input: ReflowInput;
  /** Set when the scenario is expected to be rejected (no valid schedule). */
  expectError?: boolean;
}

// ─── The five scenarios ──────────────────────────────────────────────────────

export const scenarios: Scenario[] = [
  // 1. A counterparty's fund transfer arrives late, cascading to everything
  //    downstream (margin check → fund transfer → disbursement → reconciliation).
  {
    name: "Delay Cascade",
    description:
      "Fund transfer is delayed to 10:00; the disbursement and reconciliation that depend on it cascade later.",
    input: {
      settlementChannels: [channel("CH-WIRE", "Domestic Wire Desk", MARKET_HOURS)],
      tradeOrders: [order("TRD-1", "TRD-20240115-001", "2024-01-16T16:00:00Z")],
      settlementTasks: [
        task("STL-1", "marginCheck", "CH-WIRE", "2024-01-15T08:00:00Z", 30),
        task("STL-2", "fundTransfer", "CH-WIRE", "2024-01-15T10:00:00Z", 60, { deps: ["STL-1"] }),
        task("STL-3", "disbursement", "CH-WIRE", "2024-01-15T08:00:00Z", 45, { deps: ["STL-2"] }),
        task("STL-4", "reconciliation", "CH-WIRE", "2024-01-15T08:00:00Z", 30, { deps: ["STL-3"] }),
      ],
    },
  },

  // 2. A task starts late in the session and runs past the market close; it
  //    pauses and resumes the next morning.
  {
    name: "Market Hours Spillover",
    description:
      "A 120-min task starting Mon 15:00 runs past the 16:00 close, pausing overnight and finishing Tue 09:00.",
    input: {
      settlementChannels: [channel("CH-WIRE", "Domestic Wire Desk", MARKET_HOURS)],
      tradeOrders: [order("TRD-2", "TRD-20240115-002", "2024-01-16T16:00:00Z")],
      settlementTasks: [
        task("STL-5", "fundTransfer", "CH-WIRE", "2024-01-15T15:00:00Z", 120),
      ],
    },
  },

  // 3. A Fedwire maintenance blackout blocks part of the processing window.
  {
    name: "Blackout Window (Fedwire maintenance)",
    description:
      "A 120-min task overlaps a 09:00–11:00 maintenance blackout; the blocked time is paused and the end shifts to 12:00.",
    input: {
      settlementChannels: [
        channel("CH-FED", "Fedwire Settlement", MARKET_HOURS, [
          {
            startDate: "2024-01-15T09:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            reason: "Fed settlement system maintenance",
          },
        ]),
      ],
      tradeOrders: [order("TRD-3", "TRD-20240115-003", "2024-01-16T16:00:00Z")],
      settlementTasks: [
        task("STL-6", "fundTransfer", "CH-FED", "2024-01-15T08:00:00Z", 120),
      ],
    },
  },

  // 4. Three same-type tasks compete for one channel and must be serialized.
  {
    name: "Channel Conflict",
    description:
      "Three fund transfers all scheduled at 08:00 on the same channel are serialized to 08:00, 09:00 and 10:00.",
    input: {
      settlementChannels: [channel("CH-WIRE", "Domestic Wire Desk", MARKET_HOURS)],
      tradeOrders: [
        order("TRD-4", "TRD-20240115-004", "2024-01-16T16:00:00Z"),
        order("TRD-5", "TRD-20240115-005", "2024-01-16T16:00:00Z"),
        order("TRD-6", "TRD-20240115-006", "2024-01-16T16:00:00Z"),
      ],
      settlementTasks: [
        task("STL-7", "fundTransfer", "CH-WIRE", "2024-01-15T08:00:00Z", 60, { tradeOrderId: "TRD-4" }),
        task("STL-8", "fundTransfer", "CH-WIRE", "2024-01-15T08:00:00Z", 60, { tradeOrderId: "TRD-5" }),
        task("STL-9", "fundTransfer", "CH-WIRE", "2024-01-15T08:00:00Z", 60, { tradeOrderId: "TRD-6" }),
      ],
    },
  },

  // ── Combined scenarios (pairs / triples of events) ──────────────────────────

  // Delay cascade AND channel conflict: two transfers depend on one margin
  // check, then collide on the same channel once it clears.
  {
    name: "Delay Cascade + Channel Conflict",
    description:
      "Two fund transfers depend on one margin check; once it clears they collide on the channel and are serialized.",
    input: {
      settlementChannels: [channel("CH-WIRE", "Domestic Wire Desk", MARKET_HOURS)],
      tradeOrders: [order("TRD-8", "TRD-20240115-008", "2024-01-16T16:00:00Z")],
      settlementTasks: [
        task("STL-20", "marginCheck", "CH-WIRE", "2024-01-15T08:00:00Z", 30, { tradeOrderId: "TRD-8" }),
        task("STL-21", "fundTransfer", "CH-WIRE", "2024-01-15T08:00:00Z", 60, { deps: ["STL-20"], tradeOrderId: "TRD-8" }),
        task("STL-22", "fundTransfer", "CH-WIRE", "2024-01-15T08:00:00Z", 60, { deps: ["STL-20"], tradeOrderId: "TRD-8" }),
      ],
    },
  },

  // Blackout AND market hours on the same task: a maintenance window near the
  // close pushes the end past 16:00, so it also spills into the next session.
  {
    name: "Blackout + Market Hours",
    description:
      "A task crosses a 15:00–15:30 blackout near the close; the blocked time plus the close push it into the next morning.",
    input: {
      settlementChannels: [
        channel("CH-FED", "Fedwire Settlement", MARKET_HOURS, [
          { startDate: "2024-01-15T15:00:00Z", endDate: "2024-01-15T15:30:00Z", reason: "Fed micro-maintenance" },
        ]),
      ],
      tradeOrders: [order("TRD-9", "TRD-20240115-009", "2024-01-16T16:00:00Z")],
      settlementTasks: [task("STL-23", "fundTransfer", "CH-FED", "2024-01-15T14:30:00Z", 90)],
    },
  },

  // Dependencies AND market hours (different tasks): one chain cascades while an
  // unrelated late task spills past the close.
  {
    name: "Dependencies + Market Hours",
    description:
      "A disbursement waits on its margin check, while an unrelated late transfer pauses overnight past the close.",
    input: {
      settlementChannels: [channel("CH-WIRE", "Domestic Wire Desk", MARKET_HOURS)],
      tradeOrders: [order("TRD-10", "TRD-20240115-010", "2024-01-16T16:00:00Z")],
      settlementTasks: [
        task("STL-30", "marginCheck", "CH-WIRE", "2024-01-15T08:00:00Z", 30),
        task("STL-31", "disbursement", "CH-WIRE", "2024-01-15T08:00:00Z", 45, { deps: ["STL-30"] }),
        task("STL-32", "fundTransfer", "CH-WIRE", "2024-01-15T15:00:00Z", 120),
      ],
    },
  },

  // Channel conflict AND market hours (different tasks): two transfers collide on
  // a channel while a separate late disbursement spills past the close.
  {
    name: "Channel Conflict + Market Hours",
    description:
      "Two fund transfers are serialized on the channel; a separate late disbursement pauses overnight.",
    input: {
      settlementChannels: [channel("CH-WIRE", "Domestic Wire Desk", MARKET_HOURS)],
      tradeOrders: [order("TRD-11", "TRD-20240115-011", "2024-01-16T16:00:00Z")],
      settlementTasks: [
        task("STL-40", "fundTransfer", "CH-WIRE", "2024-01-15T08:00:00Z", 60),
        task("STL-41", "fundTransfer", "CH-WIRE", "2024-01-15T08:00:00Z", 60),
        task("STL-42", "disbursement", "CH-WIRE", "2024-01-15T15:00:00Z", 120),
      ],
    },
  },

  // Blackout AND channel conflict: one transfer is stretched across a blackout,
  // forcing a second same-channel transfer to wait behind it.
  {
    name: "Blackout + Channel Conflict",
    description:
      "One transfer is stretched across a 09:00–10:00 blackout; a second transfer on the same channel waits behind it.",
    input: {
      settlementChannels: [
        channel("CH-FED", "Fedwire Settlement", MARKET_HOURS, [
          { startDate: "2024-01-15T09:00:00Z", endDate: "2024-01-15T10:00:00Z", reason: "Fed settlement maintenance" },
        ]),
      ],
      tradeOrders: [order("TRD-12", "TRD-20240115-012", "2024-01-16T16:00:00Z")],
      settlementTasks: [
        task("STL-50", "fundTransfer", "CH-FED", "2024-01-15T08:00:00Z", 120),
        task("STL-51", "fundTransfer", "CH-FED", "2024-01-15T08:00:00Z", 60),
      ],
    },
  },

  // A circular dependency makes the schedule impossible — reflow must reject it.
  {
    name: "Impossible Schedule (circular dependency)",
    description:
      "STL-10 depends on STL-11 and vice-versa; no valid ordering exists, so reflow throws.",
    expectError: true,
    input: {
      settlementChannels: [channel("CH-WIRE", "Domestic Wire Desk", MARKET_HOURS)],
      tradeOrders: [order("TRD-7", "TRD-20240115-007", "2024-01-16T16:00:00Z")],
      settlementTasks: [
        task("STL-10", "disbursement", "CH-WIRE", "2024-01-15T08:00:00Z", 60, { deps: ["STL-11"] }),
        task("STL-11", "fundTransfer", "CH-WIRE", "2024-01-15T08:00:00Z", 60, { deps: ["STL-10"] }),
      ],
    },
  },
];
