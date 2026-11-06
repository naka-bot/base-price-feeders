// Search by elapsed time, not a fixed block count: canonical block cadence can change.
export type OracleLog = { args?: { timestamp?: bigint }; eventName?: string };
type Block = { number: bigint | null; timestamp: bigint };
type HistoryReader<T extends OracleLog> = {
  getBlock: (number?: bigint) => Promise<Block>;
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>;
};

export async function findDarkOracleHistory<T extends OracleLog>(
  reader: HistoryReader<T>, thresholdMs: number, nowMs = Date.now(),
): Promise<{ logs: T[]; currentBlock: bigint; fromBlock: bigint; searchWindowMs: number; headTimestampMs: number }> {
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) throw new Error('Invalid DarkOracle age threshold');
  const searchWindowMs = thresholdMs + 30_000;
  const cutoffMs = nowMs - searchWindowMs;
  const head = await reader.getBlock();
  if (head.number === null) throw new Error('Missing canonical head number');
  // A lagging RPC must not manufacture a stale-price incident.
  const headTimestampMs = Number(head.timestamp) * 1000;
  if (headTimestampMs < nowMs - 30_000) throw new Error('Base RPC head is more than 30 seconds behind');
  const currentBlock = head.number;
  let toBlock = currentBlock;
  const logs: T[] = [];
  for (let chunk = 0; chunk < 32; chunk += 1) {
    // At most 500 inclusive blocks per request, including on public Base RPCs.
    const fromBlock = toBlock >= 499n ? toBlock - 499n : 0n;
    const batch = await reader.getLogs(fromBlock, toBlock);
    logs.unshift(...batch);
    if (batch.some(log => Number(log.args?.timestamp || 0) > 0)) {
      return { logs, currentBlock, fromBlock, searchWindowMs, headTimestampMs };
    }
    const oldest = fromBlock === currentBlock ? head : await reader.getBlock(fromBlock);
    if (fromBlock === 0n || Number(oldest.timestamp) * 1000 <= cutoffMs) {
      return { logs, currentBlock, fromBlock, searchWindowMs, headTimestampMs };
    }
    toBlock = fromBlock - 1n;
  }
  // Incomplete history is a monitor error, not evidence of an oracle outage.
  throw new Error('DarkOracle history scan limit reached before covering the freshness window');
}
