import { RULES } from './config';

export interface OpenBlockingError {
  error_id: number;
  transaction_id: number;
  flow_code: string;
  entity_identifier: string;
  error_code: string;
  error_message: string;
  occurred_at: Date;
}

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function classify(
  openBlocking: OpenBlockingError[],
  heartbeatAgeMin: number,
  txLast60: number,
  baselineLast60: number,
): number {
  const s = RULES.severity;
  if (heartbeatAgeMin > s.sev4.heartbeatMaxMinutes || (txLast60 === 0 && baselineLast60 > 0)) return 4;
  const n = openBlocking.length;
  if (n === 0) return 0;
  const today = startOfToday();
  const crossed = openBlocking.some(e => new Date(e.occurred_at) < today);
  if (n >= s.sev3.minBlocked && crossed) return 3;
  if (n >= s.sev2.minBlocked) return 2;
  return 1;
}

export function classifyFlow(
  flowBlocking: OpenBlockingError[],
  heartbeatAgeMin: number,
  flowCode: string,
): number {
  // NS flow doesn't participate in severity ladder
  if (flowCode === 'NS') return 0;
  const txLast60 = 1; // assume traffic for per-flow; only overall checks zero-traffic
  return classify(flowBlocking, heartbeatAgeMin, txLast60, 1);
}
