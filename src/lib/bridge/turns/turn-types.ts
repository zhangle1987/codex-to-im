import type { OutboundAttachment } from '../types.js';

export type BridgeTurnKind =
  | 'im_sdk'
  | 'im_desktop_reuse'
  | 'desktop_mirror';

export type BridgeTurnOrigin = 'im' | 'desktop';
export type BridgeTurnProgressSource = 'sdk_stream' | 'desktop_jsonl';
export type BridgeTurnFinalSource = 'sdk_result' | 'desktop_task_complete';

export interface ActiveBridgeTurn {
  id: string;
  sessionId: string;
  kind: BridgeTurnKind;
  origin: BridgeTurnOrigin;
  progressSource: BridgeTurnProgressSource;
  finalSource: BridgeTurnFinalSource;
  codexThreadId?: string;
  desktopThreadId?: string;
  codexTurnId?: string;
  requestMessageId?: string;
  streamKey?: string;
  startedAt: number;
}

export interface BridgeTurnClassification {
  kind: BridgeTurnKind;
  sessionId: string;
  codexThreadId?: string;
  desktopThreadId?: string;
  desktopAvailable: boolean;
  reason:
    | 'desktop_thread'
    | 'desktop_thread_missing'
    | 'bridge_thread'
    | 'new_bridge_thread';
}

export interface FinalizedBridgeResponse {
  text: string;
  attachments: OutboundAttachment[];
  hasError?: boolean;
  errorMessage?: string;
  source: BridgeTurnFinalSource;
}

export interface BridgeTurnTerminalRecord {
  turnId?: string;
  sessionId: string;
  desktopThreadId: string;
  text: string;
  outcome: 'completed' | 'failed' | 'aborted';
  timestamp: string;
}
