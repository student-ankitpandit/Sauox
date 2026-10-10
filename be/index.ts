import express from "express"
import { exchangeCodeForToken, getGithubUser, getInstallationOctokit, getInstallationToken } from "./lib"
import { getSession, listSessions, saveSession } from "./session"
import type { Session } from "./session"
import { storage, type InstallationData } from "./storage"
import { saveRepoConfig } from "./repo-configs"
import axios from "axios"
import Sandbox from "@e2b/code-interpreter"
import { randomUUID } from "node:crypto"
import { stopRequests } from "./agent"
import { subscribe } from "./events"
import { connectUpStream, ensureRelay, RELAY_PORT } from "./browser-stream"
import { Readable } from "node:stream"

const app = express()
app.use(express.json())

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

app.get("/health", (req, res) => {
    res.send({ message: "healthy" })
})

app.post("/api/auth/github/install", (req, res) => {
    res.redirect("https://github.com/settings/apps/sauox")
})

app.get("/api/auth/github/callback", async (req, res) => {
    const {installation_id, code} = req.query

    if(!installation_id) {
        return res.status(400).json({
            message: "Missing installtion_id parameter"
        })
    }

    try {
        let accessToken: string | null
        let refreshToken: string | null
        let githubUser: null | any = null
        let userId = `user${Date.now()}`

        //if authorization was requested, change the code for tokens

        if(code && typeof code == "string") {
            const clientId = process.env.CLIENT_ID
            const clientSecret = process.env.CLIENT_SECRET

            if(!clientId || !clientSecret) {
                return res.status(500).json({
                    message: "GitHub OAuth credentials are not configured"
                })
            }

            const tokenResponse = await exchangeCodeForToken(
                code,
                clientId,
                clientSecret
            )

            accessToken = tokenResponse.accessToken
            refreshToken = tokenResponse.refreshToken

            if(accessToken) {
                githubUser = await getGithubUser(accessToken)
                userId = `github${githubUser.id}` //using github userId as internal userId
            }

            //store the installation data
            const installationData: InstallationData = {
                userId,
                installation_id: installation_id as string,
                githubUserId: githubUser ? String(githubUser.id) : "",
                refreshToken,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }

            await storage.upsert(installationData)
        }
        
    } catch (e) {
        console.log(e)
        return res.status(500).json({ 
            error: "Failed to authenticate you, Try again" 
        })
    }
})

app.get("/api/github/repos", async (req, res) => {
    const installation_id  = req.query.installation_id as string

    const authToken = await getInstallationOctokit(installation_id)

    try {
        const resposRes = await axios.get("https://api.github.com/installation/repositories", {
            headers: {
                Authorization: `Bearer ${authToken}`,
                Accept: "application/vnd.github+json"
            }
        })
    
        const data = await resposRes.data
        return res.json(data.repositories)
    } catch (e) {
        console.log(e)
        return res.status(500).json({
            error: "Failed to fetch repos"
        })
    }
})

app.post("/api/github/repo/config", async (req, res) => {
    const { repoFullName, buildCommand, runCommand, installCommand, testCommand, repoOwnerName } = req.body 
    const installationId = req.installationId

    try {
        const repoConfigs = await saveRepoConfig(installationId, repoFullName, {
            buildCommand,
            testCommand,
            runCommand,
            installCommand,
        })
    
        return res.json(repoConfigs)
    } catch (e) {
        console.log(e)
        return res.status(500).json({
            error: "Failed to save repo configs"
        })
    }
})

app.post('/api/app/sessions', async (req, res) => {
    const installationId = req.installationId;
    if (!installationId) return res.status(401).json({ error: 'Not authenticated' });
    
    const { repoFullName } = req.body ?? {};
    const rawTask = typeof req.body?.task === 'string' ? req.body.task.trim() : '';
    const hasIssue = req.body?.issueNumber != null && req.body.issueNumber !== '';
    const issueNumber = hasIssue ? Number(req.body.issueNumber) : undefined;
    
    if (typeof repoFullName !== 'string' || !REPO_NAME.test(repoFullName)) {
        return res.status(400).json({ error: 'Invalid repo name' });
    }
    if (!rawTask && issueNumber === undefined) {
        return res.status(400).json({ error: 'Provide a task, an issueNumber, or both' });
    }
    if (issueNumber !== undefined && (!Number.isInteger(issueNumber) || issueNumber < 1)) {
        return res.status(400).json({ error: 'issueNumber must be a positive integer' });
    }
    if (rawTask.length > 10_000) {
        return res.status(400).json({ error: 'task is too long' });
    }
    
    try {
        let title = rawTask.split('\n')[0].slice(0, 80);
        let task = rawTask;
    
        if (issueNumber !== undefined) {
        const octokit = await getInstallationOctokit(installationId);
        const [owner, repo] = repoFullName.split('/');

        if (!owner || !repo) {
            return res.status(400).json({ error: 'Repo name is required' });
        }
    
        const issue = await octokit.rest.issues
            .get({ owner, repo, issue_number: issueNumber })
            .then(r => r.data)
            .catch(err => {
            if (err.status === 404) return null;
            throw err;
            });
    
        if (!issue) return res.status(404).json({ error: `Issue #${issueNumber} not found` });
        if (issue.pull_request) {
            return res.status(400).json({ error: `#${issueNumber} is a pull request, not an issue` });
        }
    
        title = issue.title;
        task =
            `GitHub issue #${issueNumber}: ${issue.title}\n\n${(issue.body ?? '').slice(0, 20_000)}` +
            (rawTask ? `\n\nAdditional instructions from the user:\n${rawTask}` : '');
        }
    
        const token = await getInstallationToken(installationId);
    
        const sandbox = await Sandbox.create({ timeoutMs: 30 * 60 * 1000 });
        try {
            await sandbox.commands.run(
            `git clone https://x-access-token:${token}@github.com/${repoFullName}.git repo`,
            { timeoutMs: 120_000 }
        );
        } catch (err: any) {
            await sandbox.kill().catch(() => {});
            throw new Error(`git clone failed: ${String(err.stderr ?? err.message).split(token).join('***')}`);
        }
    
        const session: Session = {
            id: randomUUID(),
            installationId,
            repoFullName,
            sandboxId: sandbox.sandboxId,
            task,
            title,
            issueNumber,// undefined for free-text tasks (dropped when saved as JSON)
            status: 'ready',
            createdAt: new Date().toISOString(),
            messages: [],
            logs: [],
        };
        await saveSession(session);
    
        res.status(201).json(session);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create session' });
    }
    
});

app.get("/api/sessions", async (req, res) => {
    const installationId = req.installationId

    return res.json(await listSessions(installationId))
})

app.get("/api/sessions/:sessionId", async (req, res) => {
    const sessionId = req.params.sessionId
    const installationId = req.installationId

    try {
        const session = await getSession(sessionId)

        if (!installationId || !session || session.installationId !== installationId) {
            return res.status(404).json({ error: "Session not found" })
        }

        let gitDiff = ""

        try {
            const sandbox = await Sandbox.connect(session.sandboxId)
            const diffResult = await sandbox.commands.run("git -C repo add -N . && git -C repo diff HEAD", {
                timeoutMs: 30000,
            })
            
            gitDiff = diffResult.stdout.slice(0, 200_000)
        } catch (error) {
            console.log(error)
        }

        return res.json({
            ...session,
            messages: session.messages,
            logs: session.logs,
            gitDiff,
        })
    } catch (error) {
        console.log(error)
        return res.status(500).json({ error: "Failed to fetch session" })
    }
})

app.post("/api/sessions/:sessionId/messages", async (req, res) => {
    const installationId = req.installationId
    const sessionId = req.params.sessionId
    const message = typeof req.body?.message === "string"
        ? req.body.message.trim()
        : typeof req.body?.content === "string"
            ? req.body.content.trim()
            : ""

    if (!message) {
        return res.status(400).json({ error: "Message is required" })
    }

    if (message.length > 20_000) {
        return res.status(400).json({ error: "Message is too long" })
    }

    try {
        const session = await getSession(sessionId)

        if (!installationId || !session || session.installationId !== installationId) {
            return res.status(404).json({ error: "Session not found" })
        }

        if(session.status === "running") {
            return res.status(409).json({
                error: "Session is still running"
            })
        }

        if(session.pendingToolCallId) {
            session.messages.push({
                role: "tool",
                tool_call_id: session.pendingToolCallId,
                content: message,
            });
            session.pendingToolCallId = undefined;
        } else {
            session.messages.push({ role: "user", content: message });
        }

        session.logs = [
            ...(session.logs ?? []),
            {
                time: new Date().toISOString(),
                type: "info",
                text: "User message received",
            },
        ]

        await saveSession(session)

        return res.status(202).json({
            message,
            sessionId: session.id,
            status: session.status
        })
    } catch (error) {
        console.log(error)
        return res.status(500).json({ error: "Failed to send message" })
    }
})

app.post('/api/sessions/:sessionId/stop', async (req, res) => {
    const session = await getSession(req.params.sessionId);
    if (!req.installationId || !session || session.installationId !== req.installationId) {
        return res.status(404).json({ error: 'Session not found' });
    }
    if (session.status !== 'running') {
        return res.status(409).json({ error: 'Session is not running' });
    }
    stopRequests.add(session.id);
    res.json({ stopping: true });
});

//still debateable that either we should use SSE or WS
app.get("/api/session/:sessionId/stream", async (req, res) => {
    const installationId = req.installationId;
    const session = await getSession(req.params.sessionId);

    if (!installationId || !session || session.installationId !== installationId) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    })

    res.flushHeaders()

    const send = (event: string, data: unknown, id?: number) => {
        if(id !== undefined) return res.write(`id: ${id}\n`)
        res.write(`event: ${event}\n`)
        res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    const lastId = Number(req.header("last-event-id"))
    const start = Number.isInteger(lastId) ? lastId + 1 : 0
    session.logs.slice(start).forEach((entry, i) => send('log', entry, start + i))
    send('status', { status: session.status, prUrl: session.prUrl, branch: session.branch })

    const unsubscribe = subscribe(session.id, e => send(e.type, e.data, e.id))

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)

    res.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
    })
})

app.get("/api/sessions/:sessionId/stream", async (req, res) => {
    const session = await getSession(req.params.sessionId);
    const installationId = req.installationId
    if (!session || session?.installationId !== installationId) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const abort = new AbortController
    req.on("close", () => abort.abort())

    try {
        const sandbox = await Sandbox.connect(session.sandboxId)
        await ensureRelay(sandbox, session.id, 'http://localhost:3000')

        //I receive the stream as upstream from the sandbox and pipe it to the user
        const upstream = await connectUpStream(`https://${sandbox.getHost(RELAY_PORT)}/`, abort.signal) 

        res.writeHead(200, {
            'Content-Type': upstream.headers.get('Content-Type') ?? 'multipart/x-mixed-replace; boundary=frame',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no', 
        })

        const body = Readable.fromWeb(upstream.body as any)
        body.on('error', () => res.send())
        body.pipe(res)
    } catch (error) {
        if(!res.headersSent) res.status(502).json({
            error: 'Browser stream unavailable'
        })
    }

})

app.listen(3001, () => {
    console.log("server is up and running on port 3000")
})
