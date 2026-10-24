// Types for activation-code.js (vendored, see README.md): importing it sets globalThis.OrbitActivation.
import type { ActivationPlan, ActivationProduct, CodeCheck } from "../../src/lib/activation";

export interface OrbitActivationApi {
  PUBLIC_KEY: string;
  PRODUCTS: ActivationProduct[];
  PLANS: ActivationPlan[];
  TRIAL_DAYS: number;
  /** Signs a code (the Code Maker; tests with a throwaway key). `privateJwk` needs `d` and `x`. */
  makeCode(
    fields: { product: ActivationProduct; plan: ActivationPlan; expires: string; serial?: number },
    privateJwk: { d?: string; x?: string },
  ): Promise<string>;
  /** What a code says, without checking its signature; null when it is not a code. */
  readCode(code: string): { product: ActivationProduct; plan: ActivationPlan; expires: string; serial: string } | null;
  checkCode(
    code: string,
    options?: { product?: "kineticlane" | "syncora"; today?: string; publicKey?: string },
  ): Promise<CodeCheck>;
  planExpiry(plan: ActivationPlan, start: string, days?: number): string;
  localToday(now?: Date): string;
  formatDate(iso: string): string;
}

declare global {
  var OrbitActivation: OrbitActivationApi;
}
