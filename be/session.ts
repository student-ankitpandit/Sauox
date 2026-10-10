import fs from 'fs/promises';
import path from 'path';
import type OpenAI from 'openai';
import { publish } from './events';

export interface messageType {
    type: string
    toolCallId: number,
    content: string,
}

export interface Session {
    id: string;
    installationId: string;
    repoFullName: string;
    sandboxId: string;
    task: string;
    title: string;
    issueNumber?: number;
    status: 'ready' | 'running' | 'waiting_for_input' | 'done' | 'error' | 'stopped';
    createdAt: string;
    messages: OpenAI.Chat.ChatCompletionMessageParam[];
    logs: LogEntry[];
    pendingToolCallId?: string;
    branch?: string;
    prUrl?: string;
}

export interface LogEntry {
    time: string;
    type: 'info' | 'tool_call' | 'tool_result' | 'error';
    text: string;
}

export function log(session: Session, type: LogEntry['type'], text: string) {
    const entry = { time: new Date().toISOString(), type, text: text.slice(0, 2000) };
    session.logs.push(entry)
    publish(session.id, { type: "log", id: session.logs.length -1, data: entry })
}

export function setStatus(session: Session, status: Session['status']) {
    session.status = status
    publish(session.id, { 
        type: 'status', data: { status, prUrl: session.prUrl, branch: session.branch 
        } 
    })
}

const sessionFile = path.join(import.meta.dir, 'data', 'sessions.json');

async function readSessions(): Promise<Record<string, Session>> {
    try {
        return JSON.parse(await fs.readFile(sessionFile, 'utf-8'));
    } catch (err: any) {
    if (err.code === 'ENOENT') {
        await fs.mkdir(path.dirname(sessionFile), { recursive: true });
        await fs.writeFile(sessionFile, '{}');
        return {};
    }
    throw err;
  }
}

export async function saveSession(session: Session) {
    const all = await readSessions();
    all[session.id] = session;
    await fs.writeFile(sessionFile, JSON.stringify(all, null, 2));
}

export async function getSession(sessionId: string) {
    return (await readSessions())[sessionId] ?? null;
}

export async function listSessions(installationId: string) {
    const allSessions = (await readSessions()) 

    return Object.values(allSessions)
    .filter(s => s.installationId == installationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}