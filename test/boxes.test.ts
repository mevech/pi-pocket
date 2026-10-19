// Sessions whose tools run in a sandbox: the box is recorded, tool calls reach the box's environment, subagents share or
// choose their own, and the tiles that read this machine's disk stay out of the way.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Boxes, BoxRef } from "../src/server/boxes.ts";
import { BoxDoc, SubagentsDoc } from "../src/server/docs.ts";
import {
    type App,
    cleanUp,
    context,
    home,
    lastText,
    modelTexts,
    owner,
    root,
    scriptedModel,
    say,
    until,
    work,
} from "./helpers.ts";

const { PocketApp } = await import("../src/server/app.ts");

/** The folder that stands in for a sandbox: commands run here instead of in the session's folder. */
const boxDir = join(root, "box");

mkdirSync(boxDir, { recursive: true });

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.includes("where are you")) {
        return call("bash", { command: "pwd" });
    }

    if (text.includes("start a helper")) {
        return call("subagent", { action: "spawn", name: "helper", message: "hello" });
    }

    if (text.includes("start an ops helper")) {
        return call("subagent", {
            action: "spawn",
            name: "ops-helper",
            message: "hello",
            box: "ops",
        });
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

describe("sessions in a sandbox", () => {
    const requested: BoxRef[] = [];
    const boxes: Boxes = {
        names: ["coding", "ops"],
        env: (ref) => {
            requested.push(ref);

            return new NodeExecutionEnv({ cwd: boxDir });
        },
        cleanup: async () => {},
    };
    const model = scriptedModel(route);
    let app: App;

    before(async () => {
        app = await PocketApp.open({
            dataDir: join(root, "data-boxes"),
            defaultCwd: work,
            supervised: false,
            log: () => {},
            configureModels: (models) => models.registerNativeProvider(model.provider),
            home,
            boxes,
        });
        app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    });

    after(async () => {
        await app.close();
        cleanUp();
    });

    async function boxedSession(box: string) {
        const { id } = await app.commands.createSession(owner(app), { cwd: work, box });

        await app.commands.configure(id, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });

        return id;
    }

    it("given a box, when a session is created, then it is recorded on the session and its claim is named", async () => {
        const id = await boxedSession("coding");

        assert.equal(app.sessionMeta(id)?.box, "coding");
        assert.equal(app.cwdOf(id), "/workspace");
        assert.deepEqual(await app.harness.snapshot(BoxDoc, id, context), {
            box: "coding",
            claim: `conv-${String(id)}`,
        });
        assert.deepEqual([...app.boxNames], ["coding", "ops"]);
    });

    it("given an unknown box, when a session is created, then the request is refused", async () => {
        await assert.rejects(
            app.commands.createSession(owner(app), { cwd: work, box: "cloud" }),
            /No sandbox "cloud" here/,
        );
    });

    it("given a boxed session, when Pi runs a command, then it runs in the box's environment", async () => {
        const id = await boxedSession("coding");

        await say(app, id, "where are you");

        assert.deepEqual(requested.at(-1), { name: `conv-${String(id)}`, template: "coding" });
        assert.ok((await modelTexts(app, id)).some((text) => text.includes(boxDir)));
    });

    it("given a boxed session, when it starts a subagent, then the subagent shares its box", async () => {
        const id = await boxedSession("coding");

        await say(app, id, "start a helper");

        const child = await spawned(app, id, "helper");

        assert.deepEqual(await app.harness.snapshot(BoxDoc, child, context), {
            box: "coding",
            claim: `conv-${String(id)}`,
        });
    });

    it("given a boxed session, when it starts a subagent with a box of its own, then the subagent gets its own claim", async () => {
        const id = await boxedSession("coding");

        await say(app, id, "start an ops helper");

        const child = await spawned(app, id, "ops-helper");

        assert.deepEqual(await app.harness.snapshot(BoxDoc, child, context), {
            box: "ops",
            claim: `sub-${String(child)}`,
        });
    });

    it("given a boxed session, when the disk tiles ask for its folder, then they get nothing", async () => {
        const id = await boxedSession("coding");

        assert.equal(app.workspace.head(id), undefined);
        await assert.rejects(app.workspace.fileList(id, owner(app)), /sandbox pod/);
    });

    it("given a session on this machine, when Pi runs a command, then no box is involved", async () => {
        const before = requested.length;
        const { id } = await app.commands.createSession(owner(app), { cwd: work });

        await app.commands.configure(id, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });
        await say(app, id, "where are you");

        assert.equal(requested.length, before);
        assert.equal(await app.harness.snapshot(BoxDoc, id, context), undefined);
        assert.ok((await modelTexts(app, id)).some((text) => text.includes(work)));
    });
});

async function spawned(app: App, id: Parameters<App["cwdOf"]>[0], name: string) {
    let child: ReturnType<typeof Number> | undefined;

    await until(async () => {
        const doc = await app.harness.snapshot(SubagentsDoc, id, context);
        const record = doc?.agents[name];

        child = record?.conversationId as unknown as number | undefined;

        return child !== undefined;
    }, `subagent ${name}`);

    return child as unknown as Parameters<App["cwdOf"]>[0];
}
