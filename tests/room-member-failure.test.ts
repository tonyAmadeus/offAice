import "../scripts/test-bootstrap.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Engine } from "./helpers/seeded-engine";
import {
  RoomReplyWatchdog,
  boundedRoomCleanup,
} from "../src/backend/room-reply-watchdog";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  ProviderId,
  Run,
} from "../src/shared/types";
import type { DiscussionReply } from "../src/shared/discussion";

type Call = { ctx: AdapterContext; input: any; prompt: string };
type Result = Partial<DiscussionReply> & { native?: AdapterResult };
async function wait(check: () => boolean, attempts = 800) {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Room did not reach the expected state");
}
async function fixture(
  respond: (call: Call, index: number) => Promise<Result> | Result,
  options: {
    idleMs?: number;
    hungCancel?: boolean;
    reuse?: boolean;
    manualDelivery?: boolean;
  } = {},
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "AIROOM member-failure-"),
  );
  const calls: Call[] = [],
    hands: Call[] = [];
  const factory = (id: ProviderId): Adapter => ({
    probe: async () => ({
      id,
      name: id,
      available: true,
      auth: "subscription",
      detail: "isolated fixture",
      capabilities: {
        steer: false,
        cancel: "native",
        streaming: true,
        write: false,
        history: true,
      },
    }),
    supportsRuntimeReuse: options.reuse,
    canReuse: () => true,
    start: async (ctx, prompt) => {
      const hand = ctx.session.purpose === "room-hand";
      const raw = prompt.split(
        hand ? "\nAIROOM_HAND_CONTEXT\n" : "\nAIROOM_CONTEXT\n",
      )[1];
      const input = raw
        ? JSON.parse(raw)
        : { you: ctx.session.memberId ?? ctx.session.provider };
      const call = { ctx, input, prompt };
      (hand ? hands : calls).push(call);
      if (!options.manualDelivery) ctx.markDelivery("confirmed");
      const result = await respond(call, calls.length - 1);
      if (result.native) return result.native;
      ctx.emit(
        "delta",
        JSON.stringify(
          hand
            ? { want: 0, why: "没有补充", ...result }
            : {
                version: 1,
                turn: input.turn,
                revision: input.revision,
                action: "speak",
                body: `${input.you} 正常回答 ${calls.length}`,
                ...result,
              },
        ),
      );
      return {};
    },
    stop: async () => {
      if (
        options.hungCancel &&
        id === "claude" &&
        calls.filter((call) => call.ctx.run.provider === "claude").length === 1
      )
        await new Promise<void>(() => {});
    },
  });
  const engine = new Engine(
    path.join(directory, "data"),
    () => {},
    () => {},
    factory,
    { roomReplyIdleMs: options.idleMs ?? 2000 },
  );
  engine.settings.maxParallel = 1;
  engine.settings.stopTimeoutMs = 25;
  const state = () => engine.store.roomState().discussion!;
  const send = (text: string, extra: Record<string, unknown> = {}) =>
    engine.invoke("room.send", {
      mode: "discuss",
      text,
      memberIds: ["claude", "codex", "dsh"],
      ...extra,
    });
  const finish = (attempts?: number) =>
    wait(() => !engine.store.roomState().active, attempts);
  return {
    directory,
    engine,
    calls,
    hands,
    state,
    send,
    finish,
    dispose: async () => {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("failure or quota exhaustion isolates a member across human rounds until explicit rejoin", async () => {
  for (const limited of [false, true]) {
    const h = await fixture(
      (call, i) =>
        i === 0
          ? {
              native: {
                failure: {
                  kind: limited ? "rate_limited" : "failed",
                  message: limited
                    ? "UsageLimitExceeded"
                    : "Authentication required",
                },
              },
            }
          : {},
      { reuse: limited, hungCancel: limited },
    );
    try {
      await h.send("第一轮");
      await h.finish();
      assert.equal(h.state().phase, "waiting_user");
      assert.deepEqual(
        h.calls.map((c) => c.input.you),
        ["claude", "codex", "dsh"],
      );
      assert.equal(h.state().skippedMembers!.claude.limited, limited);
      await h.send("下一轮，其他人继续");
      await h.finish();
      assert.deepEqual(
        h.calls.slice(3).map((c) => c.input.you),
        ["codex", "dsh"],
      );
      assert.equal(
        h.state().skippedMembers!.claude.runId,
        h.calls[0].ctx.run.id,
      );
      // Restoring the account does not implicitly replay an old request.
      h.engine.store.delete("quotas", "claude");
      await h.engine.invoke("room.resume", {});
      await h.finish();
      assert.equal(h.calls.at(-1)!.input.you, "claude");
      assert.notEqual(h.calls.at(-1)!.input.turn, h.calls[0].input.turn);
    } finally {
      await h.dispose();
    }
  }
});

test("an older blocked discussion resumes healthy members on new input without replaying its unknown request", async () => {
  const h = await fixture((_call, i) =>
    i === 0 ? { native: { unknown: true } } : {},
  );
  try {
    await h.send("旧版中断");
    await h.finish();
    const room = h.engine.store.roomState();
    h.engine.store.put("room", "state", {
      ...room,
      discussion: {
        ...room.discussion!,
        phase: "blocked",
        skippedMembers: undefined,
      },
    });
    await h.send("新的问题只让可用成员回答");
    await h.finish();
    assert.deepEqual(
      h.calls.slice(3).map((c) => c.input.you),
      ["codex", "dsh"],
    );
    assert.equal(h.state().skippedMembers?.claude.runId, h.calls[0].ctx.run.id);
    assert.deepEqual(h.state().unknownRunIds, [h.calls[0].ctx.run.id]);
  } finally {
    await h.dispose();
  }
});

test("a stalled initialization without a delivery receipt stays unknown and is not automatically retried", async () => {
  const h = await fixture(
    (call) => {
      if (call.input.you === "claude") return new Promise<Result>(() => {});
      call.ctx.markDelivery("confirmed");
      return {};
    },
    { idleMs: 60, manualDelivery: true },
  );
  try {
    await h.send("初始化也不能卡住全员");
    await h.finish();
    const first = h.engine.store.get<Run>("runs", h.calls[0].ctx.run.id)!;
    assert.equal(first.status, "unknown");
    assert.equal(first.delivery, "unknown");
    assert.equal(h.calls.filter((c) => c.input.you === "claude").length, 1);
    assert.equal(h.state().phase, "waiting_user");
  } finally {
    await h.dispose();
  }
});

test("unknown receipt never retries the failed member but lets peers answer new messages", async () => {
  const h = await fixture((_call, i) =>
    i === 0 ? { native: { unknown: true } } : {},
  );
  try {
    await h.send("收到情况不明");
    await h.finish();
    const runId = h.calls[0].ctx.run.id;
    assert.deepEqual(h.state().unknownRunIds, [runId]);
    assert.equal(h.state().phase, "waiting_user");
    await h.send("其他成员回答新问题");
    await h.finish();
    assert.equal(h.calls.filter((c) => c.input.you === "claude").length, 1);
    await assert.rejects(h.engine.invoke("room.resume"), /结果未知/);
    assert.equal(h.engine.store.get<Run>("runs", runId)!.status, "unknown");
    await h.engine.invoke("room.resume", { acknowledgeUnknown: true });
    await h.finish();
    assert.equal(h.calls.filter((c) => c.input.you === "claude").length, 2);
    assert.deepEqual(h.state().acknowledgedRunIds, [runId]);
  } finally {
    await h.dispose();
  }
});

test("a hung reply and hung native cancellation release a single execution slot without accepting late output", async () => {
  let finishLate!: () => void;
  const h = await fixture(
    async (call, i) => {
      if (i !== 0) return {};
      await new Promise<void>((resolve) => (finishLate = resolve));
      call.ctx.persistNativeSession("late-native-session");
      call.ctx.markDelivery("sent", "late-native-turn");
      call.ctx.emit("delta", "late content must not enter any reply");
      return {};
    },
    { idleMs: 60, hungCancel: true, reuse: true },
  );
  try {
    await h.send("卡死时其他人继续");
    await h.finish();
    assert.deepEqual(
      h.calls.map((c) => c.input.you),
      ["claude", "codex", "dsh"],
    );
    const first = h.calls[0],
      run = h.engine.store.get<Run>("runs", first.ctx.run.id)!;
    assert.equal(run.status, "unknown");
    assert.match(run.error!, /没有新输出/);
    finishLate();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.engine.store.get<Run>("runs", run.id)!.status, "unknown");
    assert.equal(
      h.engine.store.get<Run>("runs", run.id)!.nativeTurnId,
      undefined,
    );
    assert.equal(
      h.engine.store.get<any>("sessions", first.ctx.session.id)!.nativeId,
      undefined,
    );
    assert.ok(
      h.engine.store
        .listEvents(first.ctx.session.id)
        .every((e) => !e.text.includes("late content")),
    );
    await h.send("下一轮不要再次等卡死成员");
    await h.finish();
    assert.deepEqual(
      h.calls.slice(3).map((c) => c.input.you),
      ["codex", "dsh"],
    );
  } finally {
    finishLate?.();
    await h.dispose();
  }
});

test("real reasoning output refreshes the idle timer while ordinary status heartbeats cannot hide a stuck reply", async () => {
  for (const kind of ["reasoning", "status"] as const) {
    const h = await fixture(
      async (call, i) => {
        if (i) return {};
        for (let n = 0; n < 8; n++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          call.ctx.emit(kind, `${kind} ${n}`);
        }
        return {};
      },
      { idleMs: 80 },
    );
    try {
      await h.send("仍在生成的成员不被误判");
      await h.finish();
      const run = h.engine.store.get<Run>("runs", h.calls[0].ctx.run.id)!;
      assert.equal(run.status, kind === "reasoning" ? "ended" : "unknown");
      if (kind === "reasoning")
        assert.equal(h.state().skippedMembers?.claude, undefined);
      else assert.ok(h.state().skippedMembers?.claude);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await h.dispose();
    }
  }
});

test("unanswered casual questions do not block other speakers or natural closure and stay unanswered", async () => {
  const h = await fixture((_call, i) =>
    i === 0
      ? {
          action: "ask_user",
          body: "你喜欢哪种电影？",
          questions: [{ to: "user", text: "你喜欢哪种电影？" }],
        }
      : i < 7
        ? { body: `我接着说电影 ${i}` }
        : { action: "pass", body: "" },
  );
  try {
    await h.send("聊聊电影", { style: "chat" });
    await h.finish();
    assert.equal(h.state().phase, "idle");
    assert.ok(h.calls.length > 7);
    assert.equal(h.state().questions[0].answeredBy, undefined);
    assert.equal(h.state().questions[0].expiredBy, undefined);
    assert.ok(h.calls.slice(1).some((c) => c.input.you !== "claude"));
    assert.match(h.calls[0].prompt, /其他成员继续聊天/);
  } finally {
    await h.dispose();
  }
});

test("native casual question tools return an honest no-answer result immediately and retain the question", async () => {
  let reply: unknown;
  const h = await fixture(async (call, i) => {
    if (i === 0)
      reply = await call.ctx.approve({
        type: "question",
        title: "想听听你的想法",
        detail: "你周末想去哪里？",
        options: [
          { id: "answer", label: "回答" },
          { id: "cancel", label: "暂不回答" },
        ],
      });
    return i > 3 ? { action: "pass", body: "" } : {};
  });
  try {
    await h.send("聊聊周末", { style: "chat" });
    await h.finish();
    assert.deepEqual(reply, { choice: "cancel" });
    assert.equal(h.state().phase, "idle");
    assert.equal(h.engine.store.list<any>("approvals")[0].state, "expired");
    assert.ok(
      h
        .state()
        .questions.some((q) => q.text === "你周末想去哪里？" && !q.answeredBy),
    );
    assert.ok(
      h.engine.store
        .allRoomMessages(h.engine.store.currentRoomThread().id)
        .some((m) => m.text === "你周末想去哪里？"),
    );
  } finally {
    await h.dispose();
  }
});

test("optional casual questions remain bounded and do not create a hidden 64-question call cap", async () => {
  const h = await fixture((_call, i) => ({
    action: "ask_user",
    body: `想听听你的看法 ${i}`,
    questions: [{ to: "user", text: `你怎么看 ${i}？` }],
  }));
  try {
    await h.send("持续闲聊", { style: "chat", maxCalls: 72 });
    await h.finish(3000);
    assert.equal(h.calls.length, 72);
    assert.equal(h.state().phase, "budget");
    assert.ok(h.state().questions.length <= 64);
    assert.ok(h.state().questions.every((q) => !q.answeredBy));
  } finally {
    await h.dispose();
  }
});

test("all members failing stops without a retry loop, and a human pause remains authoritative", async () => {
  const h = await fixture(() => ({
    native: { failure: { kind: "rate_limited", message: "quota exceeded" } },
  }));
  try {
    await h.send("全员无额度");
    await h.finish();
    assert.equal(h.calls.length, 3);
    assert.equal(h.state().phase, "blocked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.calls.length, 3);
  } finally {
    await h.dispose();
  }
  let release!: () => void;
  const paused = await fixture(async (_call, i) => {
    if (i === 0) await new Promise<void>((resolve) => (release = resolve));
    return {};
  });
  try {
    await paused.send("手动暂停", { style: "chat" });
    await wait(() => paused.calls.length === 1);
    const stopping = paused.engine.invoke("room.stop");
    release();
    await stopping;
    await paused.finish();
    assert.equal(paused.state().phase, "paused");
    assert.equal(paused.calls.length, 1);
  } finally {
    release?.();
    await paused.dispose();
  }
});

test("room watchdog clears timers after completion and bounded cleanup handles rejection", async () => {
  let expired = 0;
  const watchdog = new RoomReplyWatchdog(20, () => expired++);
  assert.equal(await watchdog.run(async () => 42), 42);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(expired, 0);
  assert.equal(
    await boundedRoomCleanup(async () => {
      throw new Error("cannot cancel");
    }, 20),
    false,
  );
});

test("ordinary project questions still wait for the user even while their room has a casual discussion", async () => {
  let answer: unknown;
  const h = await fixture(
    async (call) => {
      if (call.input.turn) return { action: "pass", body: "" };
      answer = await call.ctx.approve({
        type: "question",
        title: "确认项目范围",
        detail: "是否修改项目文件？",
        options: [
          { id: "answer", label: "回答" },
          { id: "cancel", label: "取消" },
        ],
      });
      return { native: {} };
    },
    { idleMs: 40 },
  );
  try {
    await h.send("项目房间里的闲聊", { style: "chat" });
    await h.finish();
    const room = h.engine.store.roomState();
    h.engine.store.put("room", "state", {
      ...room,
      discussion: { ...room.discussion!, phase: "talking" },
    });
    const source = path.join(h.directory, "project");
    await mkdir(source);
    const project = (await h.engine.invoke("project.create", {
      directory: source,
    })) as { id: string };
    const session = h.engine.createSession(
      project.id,
      "claude",
      "ordinary project",
      false,
    );
    h.engine.store.put("sessions", session.id, {
      ...session,
      roomId: "global",
    });
    const sent = (await h.engine.send(
      session.id,
      "需要用户决定的项目工作",
    )) as { runId: string };
    await wait(() =>
      h.engine.store.list<any>("approvals").some((a) => a.state === "pending"),
    );
    await new Promise((resolve) => setTimeout(resolve, 90));
    const approval = h.engine.store
      .list<any>("approvals")
      .find((a) => a.state === "pending")!;
    assert.equal(
      h.engine.store.get<Run>("runs", sent.runId)!.status,
      "waiting_user",
    );
    assert.equal(answer, undefined);
    await h.engine.invoke("approval.answer", {
      id: approval.id,
      choice: "answer",
      answers: { scope: "确认" },
    });
    await wait(
      () => h.engine.store.get<Run>("runs", sent.runId)!.status === "ended",
    );
    assert.deepEqual(answer, { choice: "answer", answers: { scope: "确认" } });
  } finally {
    await h.dispose();
  }
});

test("meeting native questions suspend the idle timer until the human actually answers", async () => {
  const h = await fixture(
    async (_call, i) => {
      if (i === 0)
        await _call.ctx.approve({
          type: "question",
          title: "会议决定",
          detail: "请选择一个方案",
          options: [
            { id: "answer", label: "回答" },
            { id: "cancel", label: "取消" },
          ],
        });
      return {};
    },
    { idleMs: 70 },
  );
  try {
    await h.send("开会需要决策", { style: "work" });
    await wait(() =>
      h.engine.store.list<any>("approvals").some((a) => a.state === "pending"),
    );
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(h.calls.length, 1);
    assert.equal(h.state().skippedMembers, undefined);
    const approval = h.engine.store
      .list<any>("approvals")
      .find((a) => a.state === "pending")!;
    await h.engine.invoke("approval.answer", {
      id: approval.id,
      choice: "answer",
      answers: { plan: "A" },
    });
    await h.finish();
    assert.equal(h.calls.length, 3);
    assert.equal(h.state().phase, "waiting_user");
  } finally {
    await h.dispose();
  }
});
