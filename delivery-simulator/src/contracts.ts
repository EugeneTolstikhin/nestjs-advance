export type DeliveryStatus =
  | "label_created"
  | "picked_up"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "delivery_failed"
  | "returning_to_sender"
  | "returned_to_sender"
  | "cancelled";
export interface ShipmentRequest {
  reference: string;
  method: string;
  country: string;
  direction?: "outbound" | "return";
  relatedReference?: string;
}
export interface TrackingEvent {
  sequence: number;
  status: DeliveryStatus;
  occurredAt: number;
}
export interface Shipment extends ShipmentRequest {
  trackingNumber: string;
  status: DeliveryStatus;
  version: number;
  events: TrackingEvent[];
}
export const transitions: Record<DeliveryStatus, DeliveryStatus[]> = {
  label_created: ["picked_up", "cancelled"],
  picked_up: ["in_transit", "delivery_failed"],
  in_transit: ["out_for_delivery", "delivery_failed"],
  out_for_delivery: ["delivered", "delivery_failed"],
  delivery_failed: ["in_transit", "returning_to_sender"],
  returning_to_sender: ["returned_to_sender"],
  returned_to_sender: [],
  delivered: [],
  cancelled: [],
};

export const statusLabels: Record<DeliveryStatus, string> = {
  label_created: "Label created",
  picked_up: "Picked up",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  delivery_failed: "Delivery failed",
  returning_to_sender: "Returning to sender",
  returned_to_sender: "Returned to sender (received)",
  cancelled: "Cancelled",
};

export interface CarrierClaim {
  reference: string;
  shipmentReference: string;
  notes: string;
  status: "open" | "investigating" | "approved" | "rejected";
  resolution: string;
  version: number;
}
