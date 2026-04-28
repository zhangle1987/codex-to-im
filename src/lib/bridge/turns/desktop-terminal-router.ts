import type { DesktopMirrorRecord } from '../../../desktop-sessions.js';
import type { TurnCoordinator } from './turn-coordinator.js';
import type { BridgeTurnTerminalRecord } from './turn-types.js';

export interface DesktopRecordRouteResult {
  claimed: DesktopMirrorRecord[];
  unclaimed: DesktopMirrorRecord[];
  terminalClaimed: boolean;
}

function isTerminalRecord(record: DesktopMirrorRecord): boolean {
  return record.type === 'task_complete' || record.type === 'task_aborted';
}

function toTerminalRecord(
  sessionId: string,
  desktopThreadId: string,
  record: DesktopMirrorRecord,
): BridgeTurnTerminalRecord {
  return {
    sessionId,
    desktopThreadId,
    turnId: record.turnId,
    text: record.content,
    outcome: record.type === 'task_aborted' ? 'aborted' : 'completed',
    timestamp: record.timestamp,
  };
}

export async function routeDesktopRecords(
  sessionId: string,
  desktopThreadId: string,
  records: DesktopMirrorRecord[],
  coordinator: Pick<TurnCoordinator, 'claimDesktopTerminal'>,
): Promise<DesktopRecordRouteResult> {
  let terminalRecord: DesktopMirrorRecord | null = null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!isTerminalRecord(records[index])) continue;
    terminalRecord = records[index];
    break;
  }

  if (!terminalRecord) {
    return {
      claimed: [],
      unclaimed: records,
      terminalClaimed: false,
    };
  }

  const claim = await coordinator.claimDesktopTerminal(
    toTerminalRecord(sessionId, desktopThreadId, terminalRecord),
  );
  if (!claim.claimed) {
    return {
      claimed: [],
      unclaimed: records,
      terminalClaimed: false,
    };
  }

  const claimedTurnId = terminalRecord.turnId;
  const claimed = claimedTurnId
    ? records.filter((record) => record.turnId === claimedTurnId)
    : [terminalRecord];
  const claimedSet = new Set(claimed.map((record) => record.signature));

  return {
    claimed,
    unclaimed: records.filter((record) => !claimedSet.has(record.signature)),
    terminalClaimed: true,
  };
}
