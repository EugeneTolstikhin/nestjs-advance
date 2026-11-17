import {
  statusLabels,
  transitions,
  type DeliveryStatus,
  type Shipment,
} from "./contracts";

/** Keep presentation separate from the carrier's persisted status codes. */
export function shipmentView(shipment: Shipment, csrf?: string) {
  const allowed = transitions[shipment.status];
  return {
    ...shipment,
    csrf,
    statusLabel: statusLabels[shipment.status],
    canUpdate: csrf !== undefined && allowed.length > 0,
    terminal: allowed.length === 0,
    choices: (Object.keys(statusLabels) as DeliveryStatus[]).map((status) => ({
      value: status,
      label: statusLabels[status],
      disabled: !allowed.includes(status),
      selected: status === allowed[0],
      current: status === shipment.status,
    })),
    events: shipment.events.map((event) => ({
      ...event,
      label: statusLabels[event.status],
      time: new Date(event.occurredAt).toISOString(),
    })),
  };
}
