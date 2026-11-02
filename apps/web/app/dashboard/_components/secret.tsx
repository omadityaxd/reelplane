"use client";

import { useState } from "react";

/** A secret shown once (a new API key, a webhook signing secret), with a copy button. */
export function SecretValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="dash-secret-value">
      <strong>{label}</strong>
      <code>{value}</code>
      <button
        type="button"
        className="dash-button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false); // clipboard blocked: the value is still selectable
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
