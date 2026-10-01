import OpenAI from 'openai';
import { Sandbox } from 'e2b';
import type { Session } from './session';
import { saveSession, log } from './session';
import { getInstallationToken, getInstallationOctokit } from './lib';

const openai = new OpenAI();

const MODEL = 'gpt-5';
const MAX_ITERATIONS = 30;
export const REPO_DIR = ':D/wsp/projects/ca/be/repo';

// session ids the user asked to stop; checked at the top of every loop iteration
export const stopRequests = new Set<string>();

const SYSTEM_PROMPT =
  'You are a coding agent working in a cloned git repo. Use the tools to fix the issue. ' +
  'If you are blocked on information you cannot find yourself, use ask_user.';

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the repo root',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file, path relative to repo root',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Overwrite a file, path relative to repo root',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user a question when blocked on information you cannot find yourself. Your turn ends until they answer.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
];

async function executeTool(sandbox: Sandbox, name: string, input: any): Promise<string> {
  try {
    if (name === 'run_command') {
      const r = await sandbox.commands.run(input.command, { cwd: REPO_DIR, timeoutMs: 120_000 });
      return (r.stdout + r.stderr).slice(-8000);
    }
    if (name === 'read_file') {
      return (await sandbox.files.read(`${REPO_DIR}/${input.path}`)).slice(0, 20_000);
    }
    if (name === 'write_file') {
      await sandbox.files.write(`${REPO_DIR}/${input.path}`, input.content);
      return 'ok';
    }
    return `Unknown tool: ${name}`;
  } catch (err: any) {
      return `Error: ${err.message}\n${err.stdout ?? ''}${err.stderr ?? ''}`.slice(-8000);
  }
}

// First run: creates a branch, pushes, opens the PR.
// Later runs (follow-ups): commit and push to the same branch; the PR updates itself.
async function publishChanges(sandbox: Sandbox, session: Session, summary: string) {
  const run = (cmd: string) => sandbox.commands.run(cmd, { cwd: REPO_DIR });

  const status = await run('git status --porcelain');
  if (!status.stdout.trim()) {
    log(session, 'info', 'No changes to commit');
    return;
  }

  const token = await getInstallationToken(session.installationId); 
  await run('git config user.name "cloud-agent" && git config user.email "agent@users.noreply.github.com"');

  const isFirst = !session.branch;
  if (isFirst) {
    session.branch = `agent/issue-${session.issueNumber}-${Date.now()}`;
    await run(`git checkout -b ${session.branch}`);
  }

  const msg = isFirst ? `Fix #${session.issueNumber}` : `Follow-up changes for #${session.issueNumber}`;
  await run(`git add -A && git commit -m "${msg}"`);
  await run(`git remote set-url origin https://x-access-token:${token}@github.com/${session.repoFullName}.git`);
  await run(`git push origin ${session.branch}`);
  log(session, 'info', `Pushed to ${session.branch}`);

  if (isFirst) {
    const octokit = await getInstallationOctokit(session.installationId);
    const [owner, repo] = session.repoFullName.split('/');

    if (!owner || !repo) {
      throw new Error(`Invalid repository name: ${session.repoFullName}`);
    }

    const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });

    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      head: session.branch!,
      base: repoInfo.default_branch,
      title: `Fix #${session.issueNumber}: ${session.issueTitle}`,
      body: `${summary}\n\nCloses #${session.issueNumber}`,
    });
    session.prUrl = pr.html_url;
    log(session, 'info', `Opened PR: ${pr.html_url}`);
  }
}

// The agent loop. Callers set session.status = 'running' and save BEFORE calling this,
// and should call it without await (it takes minutes): void runAgent(session)
export async function runAgent(session: Session) {
  stopRequests.delete(session.id); // drop any stale stop request
  try {
    const sandbox = await Sandbox.connect(session.sandboxId);
    let summary = '';
    let finished = false;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (stopRequests.delete(session.id)) {
        log(session, 'info', 'Stopped by user');
        session.status = 'stopped';
        await saveSession(session);
        return;
      }

      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...session.messages],
        tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
      });

      const firstChoice = response.choices[0];
      if (!firstChoice) {
        throw new Error('OpenAI returned no completion choices');
      }
      const choice = firstChoice.message;
      session.messages.push(choice);

      const toolCall = choice.tool_calls?.[0];
      if (!toolCall || toolCall.type !== 'function') {
        // no tool call means the agent considers itself done
        summary = choice.content ?? '';
        finished = true;
        break;
      }

      let args: any;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        session.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: 'Error: tool arguments were not valid JSON',
        });
        continue;
      }

      if (toolCall.function.name === 'ask_user') {
        log(session, 'info', `Agent asks: ${args.question}`);
        session.status = 'waiting_for_input';
        session.pendingToolCallId = toolCall.id;
        await saveSession(session);
        return; // pauses here until /messages answers it
      }

      log(session, 'tool_call', `${toolCall.function.name} ${toolCall.function.arguments}`);
      const output = await executeTool(sandbox, toolCall.function.name, args);
      log(session, 'tool_result', output);

      session.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: output,
      });
      await saveSession(session); // persist every iteration so the UI can poll progress
    }

    if (!finished) log(session, 'info', `Reached the ${MAX_ITERATIONS}-iteration limit`);

    await publishChanges(sandbox, session, summary);
    session.status = 'done';
    await saveSession(session);
  } catch (err: any) {
    console.error(err);
    log(session, 'error', err.message);
    session.status = 'error';
    await saveSession(session);
  }
}