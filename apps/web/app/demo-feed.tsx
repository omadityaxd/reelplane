"use client";

import { ReelFeed } from "@reelplane/sdk-react";

export function DemoFeed({ publishableKey }: { publishableKey: string }) {
  return (
    <ReelFeed publishableKey={publishableKey} feed="latest" aria-label="Reelplane demo feed" />
  );
}
