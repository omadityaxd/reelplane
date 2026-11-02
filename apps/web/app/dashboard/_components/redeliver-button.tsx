"use client";

import { useTransition } from "react";
import { redeliverDashboardWebhook } from "../_actions/webhooks.ts";

export function RedeliverButton({
  projectId,
  deliveryId,
}: {
  projectId: string;
  deliveryId: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="dash-button"
      disabled={pending}
      onClick={() => startTransition(() => redeliverDashboardWebhook(projectId, deliveryId))}
    >
      Redeliver
    </button>
  );
}
