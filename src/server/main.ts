import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { relativeTo } from '../shared/paths.js';
import type {
  AppConfig,
  ClientMessage,
  ClaudeSession,
  FolderNode,
  RepoSummary,
  ServerMessage,
  TerminalAction,
} from '../shared/types.js';
import { cacheDir, loadConfig, saveConfig } from './config.js';
import { onPath, openTerminal, openWithDefault } from './external.js';
import * as gitOps from './git.js';
import { addPrepared, commitSteps, listPrepared, removePrepared, shellQuote } from './prepared.js';
import { listSubdirs, scanRoot } from './scanner.js';
import { SessionIndex, claudeProjectsDir } from './sessions.js';
import { Terminal } from './terminal.js';
import { RepoWatcher } from './watch.js';
import { watch as fsWatch } from 'node:fs';

/** Options accepted by {@link startServer}. */
export interface ServerOptions {
  /** Port to listen on; `0` picks a free one. */
  port: number;
  /** Keep running when the last browser window disconnects. */
  keepAlive: boolean;
  /** Directory of the built front-end (`index.html`, `main.js`, `main.css`). */
  webDir: string;
  /**
   * A repo to make reachable on start: when no configured root contains it,
   * its parent directory is added as a root so the UI can select it.
   */
  openRepo?: string;
}

/** What a started server exposes to the launcher. */
export interface RunningServer {
  url: string;
  close(): void;
}

/** Milliseconds between background refreshes of repo summaries and sessions. */
const REFRESH_INTERVAL = 60_000;
/** Grace period before exiting once the last client is gone. */
const IDLE_EXIT_MS = 10_000;

/**
 * Starts the local HTTP + WebSocket server.
 *
 * The server binds to `127.0.0.1` only and requires a per-launch random token
 * on every request, so other local web pages cannot drive it. State lives in
 * memory and is replayed to each new client on connect.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = randomBytes(24).toString('base64url');
  const config = await loadConfig();
  if (opts.openRepo && !config.roots.some((r) => relativeTo(r, opts.openRepo!) !== null)) {
    config.roots.push(path.dirname(opts.openRepo));
    await saveConfig(config);
  }
  const app = new App(config);
  const server = http.createServer((req, res) => {
    handleHttp(app, token, opts.webDir, req, res).catch((e: unknown) => {
      sendJson(res, 500, { error: errorText(e) });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws' || url.searchParams.get('t') !== token) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => app.attach(ws));
  });

  let idleTimer: NodeJS.Timeout | null = null;
  app.onClientCountChange = (n) => {
    if (opts.keepAlive) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (n === 0) idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
  };

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  app.start();
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    close: () => {
      app.stop();
      wss.close();
      server.close();
    },
  };
}

/** Per-connection state. */
interface Client {
  ws: WebSocket;
  terminal: Terminal | null;
  watcher: RepoWatcher | null;
}

/**
 * In-memory model shared by all clients: configured roots, discovered folders,
 * repo summaries, Claude sessions, and the background jobs that refresh them.
 */
class App {
  private clients = new Set<Client>();
  private folders = new Map<string, FolderNode>();
  private repos = new Set<string>();
  private summaries = new Map<string, RepoSummary>();
  private sessions: ClaudeSession[] = [];
  private scans = new Map<string, AbortController>();
  private sessionIndex = new SessionIndex();
  private refreshTimer: NodeJS.Timeout | null = null;
  private sessionWatcher: ReturnType<typeof fsWatch> | null = null;
  private sessionDebounce: NodeJS.Timeout | null = null;

  onClientCountChange: (n: number) => void = () => undefined;

  constructor(public config: AppConfig) {}

  start(): void {
    for (const root of this.config.roots) this.scan(root);
    void this.refreshSessions();
    this.refreshTimer = setInterval(() => {
      void this.refreshSummaries();
      void this.refreshSessions();
    }, REFRESH_INTERVAL);
    try {
      this.sessionWatcher = fsWatch(
        claudeProjectsDir(),
        { recursive: true, persistent: false },
        () => {
          if (this.sessionDebounce) clearTimeout(this.sessionDebounce);
          this.sessionDebounce = setTimeout(() => void this.refreshSessions(), 2000);
        },
      );
      this.sessionWatcher.on('error', () => undefined);
    } catch {
      this.sessionWatcher = null;
    }
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.sessionWatcher?.close();
    for (const c of this.scans.values()) c.abort();
    for (const c of this.clients) {
      c.terminal?.kill();
      c.watcher?.stop();
      c.ws.close();
    }
  }

  // ---- clients -------------------------------------------------------------

  attach(ws: WebSocket): void {
    const client: Client = { ws, terminal: null, watcher: null };
    this.clients.add(client);
    this.onClientCountChange(this.clients.size);
    this.send(client, { type: 'config', config: this.config });
    const all = [...this.folders.values()];
    for (let i = 0; i < all.length; i += 500) {
      this.send(client, { type: 'folders', items: all.slice(i, i + 500) });
    }
    for (const [root, ctrl] of this.scans) {
      if (!ctrl.signal.aborted)
        this.send(client, { type: 'scan-state', root, scanning: true, dirs: 0 });
    }
    this.send(client, { type: 'repo-summary', items: [...this.summaries.values()] });
    this.send(client, { type: 'sessions', items: this.sessions });

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      this.handleClientMessage(client, msg).catch((e: unknown) => {
        this.send(client, { type: 'notice', level: 'error', text: errorText(e) });
      });
    });
    ws.on('close', () => {
      client.terminal?.kill();
      client.watcher?.stop();
      this.clients.delete(client);
      this.onClientCountChange(this.clients.size);
    });
  }

  private send(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients) this.send(c, msg);
  }

  private async handleClientMessage(client: Client, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'term-open': {
        client.terminal?.kill();
        const cwd = existsSync(msg.cwd) ? msg.cwd : (process.env.HOME ?? process.cwd());
        client.terminal = new Terminal(
          cwd,
          msg.cols,
          msg.rows,
          (data) => this.send(client, { type: 'term-data', data }),
          (code) => {
            client.terminal = null;
            this.send(client, { type: 'term-exit', code });
          },
        );
        break;
      }
      case 'term-input':
        client.terminal?.write(msg.data);
        break;
      case 'term-resize':
        client.terminal?.resize(msg.cols, msg.rows);
        break;
      case 'term-run':
        if (!client.terminal) throw new Error('terminal is not open');
        client.terminal.runChain(await this.buildSteps(msg.run, client.terminal));
        break;
      case 'watch':
        client.watcher?.stop();
        client.watcher = null;
        if (msg.repo && this.repos.has(msg.repo)) {
          const repo = msg.repo;
          client.watcher = new RepoWatcher(repo, () => void this.repoChanged(repo));
          client.watcher.start();
          this.send(client, { type: 'prepared', repo, items: await listPrepared(repo) });
        }
        break;
    }
  }

  /** Translates a terminal action into shell steps; all paths are quoted. */
  private async buildSteps(run: TerminalAction, terminal: Terminal): Promise<string[]> {
    const cd = (dir: string) => `cd ${shellQuote(dir)}`;
    switch (run.action) {
      case 'cd':
        return [cd(run.dir)];
      case 'push':
        this.assertRepo(run.repo);
        return [cd(run.repo), 'git push'];
      case 'pull':
        this.assertRepo(run.repo);
        return [cd(run.repo), 'git pull'];
      case 'clone':
        if (!/^[\w.+-]+(:|@|:\/\/)[^\s'"]+$/.test(run.url) && !existsSync(run.url)) {
          throw new Error('clone URL looks invalid');
        }
        return [cd(run.dir), `git clone ${shellQuote(run.url)}`];
      case 'resume':
        return [cd(run.session.cwd), `claude --resume ${shellQuote(run.session.id)}`];
      case 'claude':
        if (!existsSync(run.dir)) throw new Error('folder does not exist');
        return [cd(run.dir), 'claude'];
      case 'commit': {
        this.assertRepo(run.repo);
        const item = (await listPrepared(run.repo)).find((p) => p.id === run.id);
        if (!item) throw new Error('prepared commit not found');
        const dir = path.join(cacheDir(), 'messages');
        await mkdir(dir, { recursive: true });
        const msgFile = path.join(dir, `${item.id}.txt`);
        await writeFile(msgFile, item.message.endsWith('\n') ? item.message : item.message + '\n');
        const queued = path.join(run.repo, '.bgcm', 'prepared', item.id + '.json');
        return [
          cd(run.repo),
          ...commitSteps(item, msgFile),
          terminal.removeFileCommand(shellQuote(queued)),
        ];
      }
    }
  }

  // ---- scanning and refresh -----------------------------------------------

  private scan(root: string): void {
    this.scans.get(root)?.abort();
    const ctrl = new AbortController();
    this.scans.set(root, ctrl);
    this.broadcast({ type: 'scan-state', root, scanning: true, dirs: 0 });
    const newRepos: string[] = [];
    void scanRoot(root, ctrl.signal, {
      onBatch: (items) => {
        for (const n of items) {
          this.folders.set(n.path, n);
          if (n.isRepo && !this.repos.has(n.path)) {
            this.repos.add(n.path);
            newRepos.push(n.path);
          }
        }
        this.broadcast({ type: 'folders', items });
      },
      onDone: (dirs) => {
        this.scans.delete(root);
        this.broadcast({ type: 'scan-state', root, scanning: false, dirs });
        void this.refreshSummaries(newRepos);
      },
    });
  }

  /** Recomputes dirty counts for `repos` (default: all), bounded concurrency. */
  private async refreshSummaries(repos: string[] = [...this.repos]): Promise<void> {
    const queue = [...repos];
    const done: RepoSummary[] = [];
    const worker = async () => {
      for (let r = queue.shift(); r !== undefined; r = queue.shift()) {
        try {
          const s = await gitOps.summary(r);
          this.summaries.set(r, s);
          done.push(s);
        } catch {
          this.summaries.delete(r);
        }
        if (done.length >= 50) this.broadcast({ type: 'repo-summary', items: done.splice(0) });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (done.length > 0) this.broadcast({ type: 'repo-summary', items: done });
  }

  private async refreshSessions(): Promise<void> {
    this.sessions = await this.sessionIndex.scan();
    this.broadcast({ type: 'sessions', items: this.sessions });
  }

  private async repoChanged(repo: string): Promise<void> {
    await this.refreshSummaries([repo]);
    this.broadcast({ type: 'repo-changed', path: repo });
    this.broadcast({ type: 'prepared', repo, items: await listPrepared(repo) });
  }

  // ---- HTTP-facing operations ---------------------------------------------

  async addRoot(root: string): Promise<void> {
    if (!path.isAbsolute(root) || !isDirectory(root)) throw new Error('not a directory');
    if (this.config.roots.includes(root)) return;
    this.config.roots.push(root);
    await this.persist();
    this.scan(root);
  }

  async removeRoot(root: string): Promise<void> {
    this.config.roots = this.config.roots.filter((r) => r !== root);
    this.scans.get(root)?.abort();
    this.scans.delete(root);
    for (const p of [...this.folders.keys()]) {
      if (p === root || isUnder(root, p)) {
        this.folders.delete(p);
        this.repos.delete(p);
        this.summaries.delete(p);
      }
    }
    await this.persist();
    this.broadcast({ type: 'folders-removed', root });
  }

  async setHidden(folder: string, hidden: boolean): Promise<void> {
    const set = new Set(this.config.hidden);
    if (hidden) set.add(folder);
    else set.delete(folder);
    this.config.hidden = [...set];
    await this.persist();
  }

  /**
   * Creates a repository in `dir`, which must be a known folder or a new
   * direct child of one (the "New repo here" flow), then registers it.
   */
  async initRepo(dir: string): Promise<void> {
    let node = this.folders.get(dir);
    if (!node) {
      const parent = path.dirname(dir);
      const name = path.basename(dir);
      if (!this.folders.has(parent) || name === '' || name === '.' || name === '..') {
        throw new Error('new repo must be inside a listed folder');
      }
      node = { path: dir, parent, name, isRepo: false, hasChildren: false };
      const parentNode = this.folders.get(parent);
      if (parentNode) parentNode.hasChildren = true;
    }
    if (node.isRepo) throw new Error('already a repository');
    await gitOps.init(dir);
    node.isRepo = true;
    this.folders.set(dir, node);
    this.repos.add(dir);
    this.broadcast({ type: 'folders', items: [node] });
    await this.refreshSummaries([dir]);
  }

  refreshAll(): void {
    for (const root of this.config.roots) this.scan(root);
    void this.refreshSessions();
  }

  /**
   * Deletes a Claude Code session's transcript (and its sidecar directory, if
   * any). Only sessions this index has reported can be deleted, which keeps the
   * operation inside `~/.claude/projects` by construction.
   */
  /** Looks up an indexed session or throws. */
  findSession(id: string): ClaudeSession {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) throw new Error('unknown session');
    return session;
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.findSession(id);
    await rm(session.file, { force: true });
    await rm(session.file.replace(/\.jsonl$/, ''), { recursive: true, force: true });
    await this.refreshSessions();
  }

  assertRepo(repo: string): void {
    if (!this.repos.has(repo)) throw new Error('unknown repository');
  }

  private async persist(): Promise<void> {
    await saveConfig(this.config);
    this.broadcast({ type: 'config', config: this.config });
  }
}

// ---- HTTP ------------------------------------------------------------------

async function handleHttp(
  app: App,
  token: string,
  webDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/api/')) {
    serveStatic(webDir, url.pathname, res);
    return;
  }
  if (url.searchParams.get('t') !== token && req.headers['x-bgcm-token'] !== token) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  const q = (name: string) => url.searchParams.get(name);
  const body = req.method === 'POST' || req.method === 'DELETE' ? await readJson(req) : {};
  const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || v === '') throw new Error(`missing ${name}`);
    return v;
  };
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case 'GET /api/fs/list': {
      const dir = q('path') || homeDir();
      const dirs = await listSubdirs(dir);
      sendJson(res, 200, {
        path: dir,
        parent: path.dirname(dir) === dir ? null : path.dirname(dir),
        dirs,
      });
      return;
    }
    case 'POST /api/roots':
      await app.addRoot(str(body.path, 'path'));
      sendJson(res, 200, {});
      return;
    case 'DELETE /api/roots':
      await app.removeRoot(str(body.path, 'path'));
      sendJson(res, 200, {});
      return;
    case 'POST /api/hidden':
      await app.setHidden(str(body.path, 'path'), Boolean(body.hidden));
      sendJson(res, 200, {});
      return;
    case 'POST /api/refresh':
      app.refreshAll();
      sendJson(res, 200, {});
      return;
    case 'DELETE /api/sessions':
      await app.deleteSession(str(body.id, 'id'));
      sendJson(res, 200, {});
      return;
    case 'GET /api/repo/files': {
      const repo = str(q('repo'), 'repo');
      app.assertRepo(repo);
      // External tools may drop prepared commits before this app ever touched the
      // repo; exclude the queue directory before listing so it never shows as untracked.
      await gitOps.excludeToolDir(repo).catch(() => undefined);
      const [files, status, prepared] = await Promise.all([
        gitOps.listFiles(repo, q('ignored') === '1'),
        gitOps.summary(repo),
        listPrepared(repo),
      ]);
      sendJson(res, 200, { files, status, prepared });
      return;
    }
    case 'GET /api/repo/diff': {
      const repo = str(q('repo'), 'repo');
      app.assertRepo(repo);
      const file = str(q('file'), 'file');
      const context = q('full') === '1' ? 1_000_000 : 3;
      const sha = q('sha');
      const text = sha
        ? await gitOps.diffCommit(repo, sha, file, context)
        : await gitOps.diffWorktree(repo, file, context);
      sendJson(res, 200, { text });
      return;
    }
    case 'GET /api/repo/log': {
      const repo = str(q('repo'), 'repo');
      app.assertRepo(repo);
      sendJson(res, 200, { commits: await gitOps.log(repo, Number(q('n') ?? 30) || 30) });
      return;
    }
    case 'POST /api/repo/stash': {
      const repo = str(body.repo, 'repo');
      app.assertRepo(repo);
      const files = Array.isArray(body.files) ? body.files.filter(isString) : [];
      const out = await gitOps.stash(repo, files);
      sendJson(res, 200, { output: out.trim() });
      return;
    }
    case 'POST /api/repo/ignore': {
      const repo = str(body.repo, 'repo');
      app.assertRepo(repo);
      await gitOps.ignore(repo, str(body.pattern, 'pattern'));
      sendJson(res, 200, {});
      return;
    }
    case 'POST /api/repo/init':
      await app.initRepo(str(body.dir, 'dir'));
      sendJson(res, 200, {});
      return;
    case 'POST /api/prepared': {
      const repo = str(body.repo, 'repo');
      app.assertRepo(repo);
      await gitOps.excludeToolDir(repo);
      const files = Array.isArray(body.files) ? body.files.filter(isString) : [];
      const item = await addPrepared(repo, str(body.message, 'message'), files, 'bgcm');
      sendJson(res, 200, { item, items: await listPrepared(repo) });
      return;
    }
    case 'DELETE /api/prepared': {
      const repo = str(body.repo, 'repo');
      app.assertRepo(repo);
      await removePrepared(repo, str(body.id, 'id'));
      sendJson(res, 200, { items: await listPrepared(repo) });
      return;
    }
    case 'POST /api/open': {
      const target = str(body.target, 'target');
      if (!path.isAbsolute(target) || !existsSync(target)) throw new Error('target does not exist');
      if (body.kind === 'terminal') openTerminal(target);
      else openWithDefault(target);
      sendJson(res, 200, {});
      return;
    }
    case 'POST /api/sessions/resume-external': {
      // The command is built here from an indexed session, never from client-supplied text.
      const session = app.findSession(str(body.id, 'id'));
      if (!existsSync(session.cwd)) throw new Error(`folder does not exist: ${session.cwd}`);
      openTerminal(session.cwd, ['claude', '--resume', session.id]);
      sendJson(res, 200, {});
      return;
    }
    case 'GET /api/env':
      sendJson(res, 200, {
        platform: process.platform,
        home: homeDir(),
        hasClaude:
          onPath(process.platform === 'win32' ? 'claude.cmd' : 'claude') || onPath('claude'),
      });
      return;
    default:
      sendJson(res, 404, { error: 'not found' });
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function serveStatic(webDir: string, pathname: string, res: http.ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(webDir, rel);
  if (!file.startsWith(webDir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function errorText(e: unknown): string {
  if (e instanceof gitOps.GitError) return e.stderr.trim() || e.message;
  return e instanceof Error ? e.message : String(e);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isUnder(parent: string, child: string): boolean {
  return relativeTo(parent, child) !== null && child !== parent;
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
}

export { cacheDir } from './config.js';

/** Running as a script (not imported by the launcher): start on a fixed port and print the URL. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'web');
  startServer({ port: Number(process.env.PORT ?? 0), keepAlive: true, webDir }).then((s) => {
    console.log(s.url);
  });
}
