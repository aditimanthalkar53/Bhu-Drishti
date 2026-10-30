import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EngineClient, EngineError } from "./engine-client.js";
import { queryLimiter } from "./ratelimit.js";
import type { QuerySession, Store } from "./store/types.js";
import { audit, buildReportPdf, reportAttachments, snapshot } from "./delivery.js";
import type { Report } from "./domain.js";
import { sendReportEmail, smtpConfigured } from "./email.js";

type IdParams = { Params: { id: string } };

export function appRoutes(app: FastifyInstance, store: Store, engine: EngineClient, opts: { maxConcurrentRuns: number } = { maxConcurrentRuns: 2 }) {
  /** Runs of this user still in progress on the engine (stale "running" sessions are reconciled). */
  async function activeRuns(userId: string): Promise<number> {
    const recent = (await store.sessionsForUser(userId, 50))
      .filter((s) => (s.status === "running" || s.status === "queued") && Date.now() - Date.parse(s.createdAt) < 6 * 3600_000);
    let n = 0;
    for (const s of recent) {
      try {
        const j = await engine.get<{ status: QuerySession["status"] }>(`/queries/${s.id}`);
        if (j.status === "queued" || j.status === "running") n++;
        else await store.updateSession(s.id, { status: j.status });
      } catch (e) {
        if (e instanceof EngineError && e.status === 404) await store.updateSession(s.id, { status: "failed" });
        else n++;   // engine unreachable: be conservative
      }
    }
    return n;
  }

  const auth = { preHandler: app.authenticate };

  const sendEngineError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof EngineError) return reply.code(e.status).send(e.body ?? { error: e.message });
    throw e;
  };

  /** Load a query session and check that the caller owns it. */
  async function ownedSession(req: FastifyRequest<IdParams>, reply: FastifyReply): Promise<QuerySession | undefined> {
    const s = await store.session(req.params.id);
    if (!s || s.userId !== req.userId) {
      reply.code(404).send({ error: "query not found" });
      return undefined;
    }
    return s;
  }

  // ------------------------------------------------------------------ health / catalogue
  app.get("/api/health", async () => {
    let engineHealth: unknown = null;
    try {
      engineHealth = await engine.get("/health");
    } catch (e) {
      engineHealth = { ok: false, error: (e as Error).message };
    }
    return { ok: true, service: "bhu-drishti-backend", engine: engineHealth };
  });

  app.get<{ Querystring: { q?: string; kind?: string } }>("/api/regions", auth, async (req, reply) => {
    try {
      const qs = new URLSearchParams();
      if (req.query.q) qs.set("q", req.query.q);
      if (req.query.kind) qs.set("kind", req.query.kind);
      return await engine.get(`/regions${qs.size ? `?${qs}` : ""}`);
    } catch (e) {
      return sendEngineError(reply, e);
    }
  });

  app.post<{ Body: { question: string; region_id: string; overrides?: Record<string, unknown> } }>(
    "/api/compile", auth, async (req, reply) => {
      try {
        return await engine.post("/compile", { question: req.body.question, region_id: req.body.region_id, overrides: req.body.overrides ?? {} });
      } catch (e) {
        return sendEngineError(reply, e);
      }
    },
  );

  // ------------------------------------------------------------------ projects
  app.get("/api/projects", auth, async (req) => store.projectsFor(req.userId!));

  app.post<{ Body: { name: string; description?: string } }>("/api/projects", {
    ...auth,
    schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 120 }, description: { type: "string", maxLength: 1000 } } } },
  }, async (req, reply) => {
    const p = await store.createProject({
      id: randomUUID(), ownerId: req.userId!, name: req.body.name.trim(),
      description: req.body.description?.trim() ?? "", createdAt: new Date().toISOString(),
    });
    return reply.code(201).send(p);
  });

  app.get<IdParams>("/api/projects/:id/queries", auth, async (req, reply) => {
    const p = await store.project(req.params.id);
    if (!p || p.ownerId !== req.userId) return reply.code(404).send({ error: "project not found" });
    return store.sessionsFor(p.id);
  });

  // ------------------------------------------------------------------ query sessions
  app.post<IdParams & { Body: { question: string; region_id: string; overrides?: Record<string, unknown> } }>(
    "/api/projects/:id/queries", {
      ...auth,
      schema: { body: { type: "object", required: ["question", "region_id"], properties: { question: { type: "string", minLength: 3, maxLength: 1000 }, region_id: { type: "string" }, overrides: { type: "object" } } } },
    }, async (req, reply) => {
      const p = await store.project(req.params.id);
      if (!p || p.ownerId !== req.userId) return reply.code(404).send({ error: "project not found" });
      if (!queryLimiter.check(req.userId!)) return reply.code(429).send({ error: "too many queries — wait a moment" });
      // live runs download satellite imagery for minutes and spend provider quota: cap them per user
      const active = await activeRuns(req.userId!);
      if (active >= opts.maxConcurrentRuns) {
        return reply.code(429).send({ error: `You already have ${active} analysis run(s) in progress. Wait for one to finish (or stop it) before starting another.` });
      }
      let started: { id: string; compile: unknown; plan: unknown };
      try {
        started = await engine.post<{ id: string; compile: unknown; plan: unknown }>("/queries", { question: req.body.question, region_id: req.body.region_id, overrides: req.body.overrides ?? {} });
      } catch (e) {
        return sendEngineError(reply, e);
      }
      const now = new Date().toISOString();
      const s = await store.createSession({
        id: started.id, projectId: p.id, userId: req.userId!, question: req.body.question, regionId: req.body.region_id,
        status: "running", answer: null, estimate: null, createdAt: now, updatedAt: now,
      });
      return reply.code(201).send({ session: s, compile: started.compile, plan: started.plan });
    },
  );

  app.get<IdParams>("/api/queries/:id", auth, async (req, reply) => {
    const s = await ownedSession(req, reply);
    if (!s) return;
    try {
      
      const summary = await engine.get<{
        status: QuerySession["status"];
        result?: (Record<string, any> & { answer?: string | null; estimate?: Record<string, unknown> | null }) | null;
      }>(`/queries/${s.id}`);

      let current = s;
      if (summary.status !== s.status || (summary.result && (!s.answer || !s.result))) {
        const patch = {
          status: summary.status, answer: summary.result?.answer ?? null, estimate: summary.result?.estimate ?? null,
          result: snapshot(summary.result),
        };
        await store.updateSession(s.id, patch);
        current = { ...s, ...patch };
      }
      return { session: current, engine: summary };
    } catch (e) {
      if (e instanceof EngineError && e.status === 404) {
        // engine restarted: the job is gone but the session record remains. A run that was still going
        // can never finish now, so close it instead of leaving it "running" forever.
        if (s.status === "running" || s.status === "queued") {
          const patch = { status: "failed" as const, answer: "This analysis was interrupted because the analysis engine restarted. Please run the question again." };
          await store.updateSession(s.id, patch);
          return { session: { ...s, ...patch }, engine: null };
        }
        return { session: s, engine: null };
      }
      return sendEngineError(reply, e);
    }
  });

  /** Server-Sent Events relay: engine → browser. Persists the final result on the session. */
  app.get<IdParams & { Querystring: { since?: string } }>("/api/queries/:id/events", auth, async (req, reply) => {
    const s = await ownedSession(req, reply);
    if (!s) return;
    const ac = new AbortController();
    req.raw.on("close", () => ac.abort());
    let upstream: Response;
    try {
      upstream = await engine.raw(`/queries/${s.id}/events?since=${Number(req.query.since ?? 0)}`, ac.signal);
    } catch (e) {
      return reply.code(503).send({ error: `engine unreachable: ${(e as Error).message}` });
    }
    if (!upstream.ok || !upstream.body) return reply.code(upstream.status).send({ error: "engine stream failed" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": req.headers.origin ?? "*",
    });
    let buf = "";
    let saved: Record<string, any> | null = null;   // the persisted result, so late evidence can be added to it
    const stream = Readable.fromWeb(upstream.body as any);
    stream.on("data", (chunk: Buffer) => {
      reply.raw.write(chunk);
      buf += chunk.toString("utf8");
      // watch for the final result to persist it without a second request
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.includes("event: result")) {
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) {
            try {
              const r = JSON.parse(line.slice(6));
              saved = snapshot(r);
              void store.updateSession(s.id, { status: r.stop_reason === "user_stop" ? "stopped" : "done", answer: r.answer, estimate: r.estimate,
                result: saved });
            } catch { /* ignore malformed */ }
          }
        } else if (block.includes("event: evidence") && saved) {
          // supporting evidence that arrived after the answer: add it to the stored result
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) {
            try {
              saved = { ...saved, supporting_evidence: JSON.parse(line.slice(6)).items ?? [] };
              void store.updateSession(s.id, { result: saved });
            } catch { /* ignore malformed */ }
          }
        } else if (block.includes("event: error")) {
          void store.updateSession(s.id, { status: "failed" });
        }
      }
    });
    stream.on("end", () => reply.raw.end());
    stream.on("error", () => reply.raw.end());
  });

  for (const action of ["stop", "replay", "exhaustive"] as const) {
    app.post<IdParams & { Querystring: Record<string, string> }>(`/api/queries/:id/${action}`, auth, async (req, reply) => {
      const s = await ownedSession(req, reply);
      if (!s) return;
      const qs = new URLSearchParams(req.query).toString();
      try {
        return await engine.post(`/queries/${s.id}/${action}${qs ? `?${qs}` : ""}`);
      } catch (e) {
        return sendEngineError(reply, e);
      }
    });
  }

  for (const view of ["universe", "evidence"] as const) {
    app.get<IdParams>(`/api/queries/:id/${view}`, auth, async (req, reply) => {
      const s = await ownedSession(req, reply);
      if (!s) return;
      try {
        return await engine.get(`/queries/${s.id}/${view}`);
      } catch (e) {
        return sendEngineError(reply, e);
      }
    });
  }

  app.get<IdParams>("/api/queries/:id/trace", auth, async (req, reply) => {
    const s = await ownedSession(req, reply);
    if (!s) return;
    const r = await engine.raw(`/queries/${s.id}/trace`);
    if (!r.ok) return reply.code(r.status).send(await r.json().catch(() => ({ error: "trace unavailable" })));
    reply.header("content-type", "application/json");
    reply.header("content-disposition", `attachment; filename="bhu-drishti-trace-${s.id}.json"`);
    return reply.send(Buffer.from(await r.arrayBuffer()));
  });

  app.get("/api/cache/stats", auth, async (_req, reply) => {
    try {
      return await engine.get("/cache/stats");
    } catch (e) {
      return sendEngineError(reply, e);
    }
  });

  
  // Email a PDF report for a completed query.
  app.post<IdParams & { Body: { email?: string } | null }>(
    "/api/queries/:id/email-report",
    auth,
    async (req, reply) => {
      const s = await ownedSession(req, reply);
      if (!s) return;

      if (s.status !== "done" || !s.answer) {
        return reply.code(409).send({
          error: "The query must be completed before emailing its report.",
        });
      }

      // Guests have a placeholder @guest.local address, so the recipient comes from the
      // request body when given; otherwise fall back to the registered account email.
      const user = await store.userById(req.userId!);
      const requested = req.body?.email?.trim().toLowerCase();
      const recipient = requested || (user?.email.endsWith("@guest.local") ? undefined : user?.email);

      if (!recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
        return reply.code(400).send({
          error: "Enter a valid email address to send the report to.",
        });
      }

      try {
        const adhoc: Report = {
          id: `q-${s.id}`, ownerId: s.userId, createdAt: new Date().toISOString(), title: s.question.slice(0, 120),
          queryIds: [s.id], regionId: s.regionId, status: "approved", origin: "user", summary: s.answer ?? "",
          recipientIds: [], groupIds: [], approvedBy: s.userId,
        };
        if (!smtpConfigured()) {
          return reply.code(503).send({ error: "Email is not set up on the server (SMTP_USER / SMTP_PASS are missing in .env)." });
        }
        const files = await reportAttachments(store, engine, adhoc);
        await sendReportEmail(recipient, adhoc.title, adhoc.summary, files);
        await audit(store, s.userId, s.userId, "query.email_report", `query:${s.id}`, { to: recipient });
        return { ok: true, message: `Report emailed to ${recipient} (summary + technical PDF).` };
      } catch (error) {
        req.log.error({ err: error }, "Failed to email query report");
        const msg = (error as Error).message ?? "";
        const hint = /auth|535|credentials|Username and Password/i.test(msg) ? "the mail server rejected the login (check SMTP_USER / SMTP_PASS — Gmail needs an App Password)"
          : /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ESOCKET/i.test(msg) ? "the server could not reach the mail server (network or SMTP_HOST/SMTP_PORT)"
          : "the mail server returned an error";
        return reply.code(502).send({ error: `Could not send the report email: ${hint}.` });
      }
    },
  );

  // PDF of a single query (download without emailing)
  app.get<IdParams & { Querystring: { style?: string } }>("/api/queries/:id/report.pdf", auth, async (req, reply) => {
    const s = await ownedSession(req, reply);
    if (!s) return;
    if (s.status !== "done" && s.status !== "stopped") return reply.code(409).send({ error: "the query has not finished" });
    const adhoc: Report = {
      id: `q-${s.id}`, ownerId: s.userId, createdAt: new Date().toISOString(), title: s.question.slice(0, 120), queryIds: [s.id],
      regionId: s.regionId, status: "approved", origin: "user", summary: s.answer ?? "", recipientIds: [], groupIds: [],
    };
    const style = req.query.style === "simple" ? "simple" : "technical";
    const pdf = await buildReportPdf(store, engine, adhoc, style);
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", `attachment; filename="bhu-drishti-${style === "simple" ? "summary" : "technical"}-${s.id}.pdf"`);
    return reply.send(pdf);
  });
}
