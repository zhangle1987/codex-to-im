import type { DesktopSessionEvent } from './desktop-sessions.js';

export interface DesktopMirrorCursor {
  initialized: boolean;
  lastEventSignature?: string;
  lastEventTimestamp?: string;
  lastEventRole?: DesktopSessionEvent['role'];
  lastEventContent?: string;
  lastEventCount: number;
}

export interface DesktopMirrorDelta {
  nextCursor: DesktopMirrorCursor;
  deliverableEvents: DesktopSessionEvent[];
  reset: boolean;
}

function makeCursor(events: DesktopSessionEvent[]): DesktopMirrorCursor {
  const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
  return {
    initialized: true,
    lastEventSignature: lastEvent?.signature,
    lastEventTimestamp: lastEvent?.timestamp,
    lastEventRole: lastEvent?.role,
    lastEventContent: lastEvent?.content,
    lastEventCount: events.length,
  };
}

export function advanceDesktopMirrorCursor(
  cursor: DesktopMirrorCursor | null | undefined,
  appendedEvents: DesktopSessionEvent[],
): DesktopMirrorCursor {
  if (appendedEvents.length === 0) {
    return cursor
      ? { ...cursor }
      : {
          initialized: false,
          lastEventCount: 0,
        };
  }

  if (!cursor?.initialized) {
    return makeCursor(appendedEvents);
  }

  const lastEvent = appendedEvents[appendedEvents.length - 1];
  return {
    initialized: true,
    lastEventSignature: lastEvent?.signature,
    lastEventTimestamp: lastEvent?.timestamp,
    lastEventRole: lastEvent?.role,
    lastEventContent: lastEvent?.content,
    lastEventCount: cursor.lastEventCount + appendedEvents.length,
  };
}

export function filterDuplicateAssistantEvents(
  cursor: DesktopMirrorCursor | null | undefined,
  events: DesktopSessionEvent[],
): DesktopSessionEvent[] {
  if (events.length === 0) return events;
  let startIndex = 0;

  while (
    startIndex < events.length
    && cursor?.lastEventRole === 'assistant'
    && events[startIndex]?.role === 'assistant'
    && cursor.lastEventContent === events[startIndex]?.content
  ) {
    startIndex += 1;
  }

  return startIndex === 0 ? events : events.slice(startIndex);
}

function findLastEventIndex(events: DesktopSessionEvent[], signature: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.signature === signature) {
      return index;
    }
  }
  return -1;
}

function collectEventsAfterTimestamp(events: DesktopSessionEvent[], timestamp: string | undefined): DesktopSessionEvent[] {
  if (!timestamp) return [];
  return events.filter((event) => Boolean(event.timestamp) && event.timestamp > timestamp);
}

export function reconcileDesktopMirrorCursor(
  cursor: DesktopMirrorCursor | null | undefined,
  events: DesktopSessionEvent[],
): DesktopMirrorDelta {
  const nextCursor = makeCursor(events);

  if (!cursor?.initialized) {
    return {
      nextCursor,
      deliverableEvents: [],
      reset: false,
    };
  }

  if (events.length === 0) {
    return {
      nextCursor,
      deliverableEvents: [],
      reset: cursor.lastEventCount > 0,
    };
  }

  if (cursor.lastEventSignature) {
    const lastSeenIndex = findLastEventIndex(events, cursor.lastEventSignature);
    if (lastSeenIndex === -1) {
      const recoveredEvents = collectEventsAfterTimestamp(events, cursor.lastEventTimestamp);
      return {
        nextCursor,
        deliverableEvents: recoveredEvents,
        reset: true,
      };
    }
    return {
      nextCursor,
      deliverableEvents: events.slice(lastSeenIndex + 1),
      reset: false,
    };
  }

  if (cursor.lastEventCount === 0) {
    return {
      nextCursor,
      deliverableEvents: events,
      reset: false,
    };
  }

  if (events.length < cursor.lastEventCount) {
    const recoveredEvents = collectEventsAfterTimestamp(events, cursor.lastEventTimestamp);
    return {
      nextCursor,
      deliverableEvents: recoveredEvents,
      reset: true,
    };
  }

  return {
    nextCursor,
    deliverableEvents: events.slice(cursor.lastEventCount),
    reset: false,
  };
}
