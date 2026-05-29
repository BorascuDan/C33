export type ISODateTime = string;
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type Hour = number;

export type TaskType =
  | "marginCheck"
  | "fundTransfer"
  | "disbursement"
  | "complianceScreen"
  | "reconciliation"
  | "regulatoryHold";

export interface BaseDocument<TType extends string, TData> {
  docId: string;
  docType: TType;
  data: TData;
}

export interface SettlementTaskData {
  taskReference: string;
  tradeOrderId: string;
  settlementChannelId: string;
  startDate: ISODateTime;
  endDate: ISODateTime;
  durationMinutes: number;
  isRegulatoryHold: boolean;
  dependsOnTaskIds: string[];
  taskType: TaskType;
  prepTimeMinutes?: number;
}

export type SettlementTask = BaseDocument<"settlementTask", SettlementTaskData>;

export interface OperatingHours {
  dayOfWeek: DayOfWeek;
  startHour: Hour;
  endHour: Hour;
}

export interface BlackoutWindow {
  startDate: ISODateTime;
  endDate: ISODateTime;
  reason?: string;
}

export interface SettlementChannelData {
  name: string;
  operatingHours: OperatingHours[];
  blackoutWindows: BlackoutWindow[];
}

export type SettlementChannel = BaseDocument<"settlementChannel", SettlementChannelData>;

export interface TradeOrderData {
  tradeOrderNumber: string;
  instrumentId: string;
  quantity: number;
  settlementDate: ISODateTime;
}

export type TradeOrder = BaseDocument<"tradeOrder", TradeOrderData>;

export type SettlementDocument = SettlementTask | SettlementChannel | TradeOrder;

export interface ReflowInput {
  settlementTasks: SettlementTask[];
  settlementChannels: SettlementChannel[];
  tradeOrders: TradeOrder[];
}

export type ConstraintType =
  | "dependency"
  | "channelConflict"
  | "operatingHours"
  | "blackoutWindow"
  | "regulatoryHold";

export interface ScheduleChange {
  taskId: string;
  taskReference: string;
  originalStartDate: ISODateTime;
  originalEndDate: ISODateTime;
  newStartDate: ISODateTime;
  newEndDate: ISODateTime;
  delayMinutes: number;
  triggeredBy: ConstraintType[];
  reason: string;
}

export interface ReflowResult {
  updatedTasks: SettlementTask[];
  changes: ScheduleChange[];
  explanation: string;
  metrics?: ReflowMetrics;
}

export interface TimeInterval {
  start: ISODateTime;
  end: ISODateTime;
}

export interface WorkSegment {
  start: ISODateTime;
  end: ISODateTime;
  minutes: number;
}


export interface ReflowMetrics {
  totalDelayMinutes: number;
  tasksAffected: number;
  channelUtilization: Record<string, number>;
  slaBreaches: SlaBreach[];
}

export interface SlaBreach {
  taskId: string;
  taskReference: string;
  tradeOrderId: string;
  targetSettlementDate: ISODateTime;
  projectedEndDate: ISODateTime;
  overrunMinutes: number;
}

export class UnsatisfiableScheduleError extends Error {
  constructor(
    message: string,
    public readonly taskId?: string,
        public readonly violatedConstraints: ConstraintType[] = [],
  ) {
    super(message);
    this.name = "UnsatisfiableScheduleError";
  }
}
