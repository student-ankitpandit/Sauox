import fs from "fs"
import { Sandbox } from "e2b"
import path from "node:path"

const RELAY_SCRIPT = fs.readFileSync(path.join(import.meta.dirname, 'browser-relay.js'), "utf-8")
const relayStarted = new Set<string>() //in-memory set
export const RELAY_PORT = 9223

export const ensureRelay = async (sandbox: Sandbox, sessionId: string, targetUrl:string) => {
    if (relayStarted.has(sessionId)) return;
    await sandbox.files.write('/home/user/browser-relay.js', RELAY_SCRIPT);
    await sandbox.commands.run('cd /home/user && node browser-relay.js', {
        background: true,
        envs: { TARGET_URL: targetUrl }
    })
    relayStarted.add(sessionId)
}

// the relay takes a few seconds to boot, so retry until it answers
export const connectUpStream = async(url: string, signal: AbortSignal) => {
    for (let i = 0; i < 20; i++) {
    try {
        const response = await fetch(url, { signal });
        if (response.ok && response.body) return response;
    } catch (e) {
        if (signal.aborted) throw e;
    }
    await new Promise(response => setTimeout(response, 1000));
    }
    throw new Error('Browser relay not reachable');
}