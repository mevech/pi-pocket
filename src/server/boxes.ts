/**
 * Sandboxes a conversation's tools can run in instead of this machine. The server loads them when `PI_POCKET_BOXES`
 * names a config file, from the package `PI_POCKET_BOXES_MODULE` (default `pi-durable-env-sandboxd`), so an install
 * without that package has no boxes and behaves as before.
 */
import { readFileSync } from "node:fs";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** The sandbox behind a conversation: the kind (`box`) and the claim that names its pod. */
export type BoxRef = { name: string; template: string };

export interface Boxes {
    /** The kinds offered, as the New-session dialog and the subagent tool list them. */
    readonly names: readonly string[];
    /** The kind a new session gets when its request names none; undefined: this machine. */
    readonly defaultName?: string;
    env(ref: BoxRef): ExecutionEnv;
    cleanup(context: Context): Promise<void>;
}

const DEFAULT_MODULE = "pi-durable-env-sandboxd";

export async function loadBoxes(
    file = process.env.PI_POCKET_BOXES,
    moduleName = process.env.PI_POCKET_BOXES_MODULE ?? DEFAULT_MODULE,
): Promise<Boxes | undefined> {
    if (file === undefined || file === "") {
        return undefined;
    }

    const config: unknown = JSON.parse(readFileSync(file, "utf8"));

    if (
        config === null ||
        typeof config !== "object" ||
        typeof (config as { namespace?: unknown }).namespace !== "string"
    ) {
        throw new Error(`${file}: expected an object with a "namespace" and "templates"`);
    }

    const loaded = (await import(moduleName)) as { createSandboxEnvs: (config: unknown) => Boxes };

    return loaded.createSandboxEnvs(config);
}
