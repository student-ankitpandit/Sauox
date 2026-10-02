import { EventEmitter } from "events";
import type { LogEntry, Session } from "./session";

export type SessionEvent =
    | { type: "log"; id: number; data: LogEntry }
    | {
        type: "status";
        id?: undefined;
        data: { status: Session["status"]; prUrl?: string; branch?: string };
    };  

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // many browser tabs can listen to one session

export function publish(sessionId: string, event: SessionEvent) {
    emitter.emit(sessionId, event);
}

export function subscribe(sessionId: string, fn: (e: SessionEvent) => void) {
    emitter.on(sessionId, fn);
    return () => emitter.off(sessionId, fn); // call this to unsubscribe
}
