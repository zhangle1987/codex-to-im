import type { ActiveBridgeTurn, BridgeTurnTerminalRecord } from './turn-types.js';

export interface DesktopTerminalClaimResult {
  claimed: boolean;
  turn?: ActiveBridgeTurn;
}

export interface TurnCoordinatorDeps {
  finalizeTerminalTurn?(
    turn: ActiveBridgeTurn,
    terminal: BridgeTurnTerminalRecord,
  ): Promise<boolean> | boolean;
}

export interface TurnCoordinator {
  registerInteractiveTurn(turn: ActiveBridgeTurn): void;
  getActiveTurn(sessionId: string): ActiveBridgeTurn | undefined;
  associateDesktopTurn(sessionId: string, turnId: string): boolean;
  claimDesktopTerminal(record: BridgeTurnTerminalRecord): Promise<DesktopTerminalClaimResult>;
  releaseTurn(turnId: string): void;
  releaseSessionTurn(sessionId: string, turnId?: string): void;
  clear(): void;
}

export function createTurnCoordinator(deps: TurnCoordinatorDeps = {}): TurnCoordinator {
  const activeTurnsBySession = new Map<string, ActiveBridgeTurn>();

  function registerInteractiveTurn(turn: ActiveBridgeTurn): void {
    activeTurnsBySession.set(turn.sessionId, turn);
  }

  function getActiveTurn(sessionId: string): ActiveBridgeTurn | undefined {
    return activeTurnsBySession.get(sessionId);
  }

  function associateDesktopTurn(sessionId: string, turnId: string): boolean {
    const turn = activeTurnsBySession.get(sessionId);
    const normalizedTurnId = turnId.trim();
    if (!turn || turn.kind !== 'im_desktop_reuse' || !normalizedTurnId) return false;
    if (turn.codexTurnId && turn.codexTurnId !== normalizedTurnId) return false;
    const changed = turn.codexTurnId !== normalizedTurnId;
    turn.codexTurnId = normalizedTurnId;
    if (changed) {
      turn.onDesktopTurnAssociated?.(normalizedTurnId);
    }
    return true;
  }

  async function claimDesktopTerminal(
    terminal: BridgeTurnTerminalRecord,
  ): Promise<DesktopTerminalClaimResult> {
    const turn = activeTurnsBySession.get(terminal.sessionId);
    if (!turn || turn.kind !== 'im_desktop_reuse') {
      return { claimed: false };
    }
    if (turn.desktopThreadId && turn.desktopThreadId !== terminal.desktopThreadId) {
      return { claimed: false };
    }
    if (!turn.codexTurnId || terminal.turnId !== turn.codexTurnId) {
      return { claimed: false, turn };
    }

    const finalized = await deps.finalizeTerminalTurn?.(turn, terminal);
    return finalized ? { claimed: true, turn } : { claimed: false, turn };
  }

  function releaseTurn(turnId: string): void {
    for (const [sessionId, turn] of activeTurnsBySession) {
      if (turn.id !== turnId) continue;
      activeTurnsBySession.delete(sessionId);
      return;
    }
  }

  function releaseSessionTurn(sessionId: string, turnId?: string): void {
    const turn = activeTurnsBySession.get(sessionId);
    if (!turn) return;
    if (turnId && turn.id !== turnId) return;
    activeTurnsBySession.delete(sessionId);
  }

  function clear(): void {
    activeTurnsBySession.clear();
  }

  return {
    registerInteractiveTurn,
    getActiveTurn,
    associateDesktopTurn,
    claimDesktopTerminal,
    releaseTurn,
    releaseSessionTurn,
    clear,
  };
}
