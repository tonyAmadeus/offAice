import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdir, cp, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { installedVersions } from "../src/backend/member-versions";
import {
  planRelocation,
  applyRelocation,
  preserveBoundExecutor,
} from "./executor-relocation";
import { fullProfileCopy } from "./full-profile-copy";

const user = process.env.USERPROFILE!,
  legacy = path.join(user, ".airoom"),
  data = path.join(legacy, "data");
const from = path.join(
  legacy,
  "resources",
  "app",
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "lib",
  "bin.js",
);
const db = new DatabaseSync(path.join(data, "airoom.sqlite"), {
  readOnly: !process.argv.includes("--execute"),
});
try {
  const settings = JSON.parse(
    (
      db
        .prepare(
          "SELECT value FROM entities WHERE entity='settings' AND id='main'",
        )
        .get() as { value: string }
    ).value,
  );
  const managed = settings.paths?.dsh;
  if (
    !managed ||
    !installedVersions(data, "dsh").some(
      (version) => path.resolve(version.entry) === path.resolve(managed),
    )
  )
    throw Error("Current managed DSH installation is incomplete");
  const preserve = process.argv.includes("--preserve-bound-cli"),
    staged = path.resolve(".test-cache/handoff47/preserved-dsh");
  const prepared = preserve
    ? await preserveBoundExecutor(
        from,
        path.join(legacy, "resources", "app"),
        staged,
      )
    : undefined;
  let plan = planRelocation(db, from, prepared?.entry ?? managed);
  if (!process.argv.includes("--execute")) {
    console.log(
      JSON.stringify(
        {
          ...plan,
          sessions: plan.sessions.length,
          preservedPackages: prepared?.packages,
          previewOnly: true,
        },
        null,
        2,
      ),
    );
  } else {
    const assertClosed = () => {
      const count = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "@(Get-CimInstance Win32_Process -Filter \"Name='AIROOM.exe'\").Count",
        ],
        { encoding: "utf8", windowsHide: true },
      ).trim();
      if (count !== "0") throw Error("Quit AIROOM normally before migration");
    };
    assertClosed();
    const retired = path.join(
      user,
      ".airoom-retired-" + new Date().toISOString().replaceAll(":", "-"),
    );
    await mkdir(retired);
    // Full exceptional pre-migration copy includes personal work and whole login
    // directories. Ordinary rotating backup policy is unchanged.
    await fullProfileCopy(data, retired);
    await writeFile(
      path.join(retired, "README.txt"),
      "Full pre-retirement copy. Personal files and whole native login directories included. Active data stays at its original path; no credentials were inspected. Retain until owner confirms removal.\n",
    );
    assertClosed();
    if (prepared) {
      const destination = path.join(
        data,
        "executors-legacy",
        "dsh-" + plan.version,
      );
      await cp(staged, destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      plan = planRelocation(
        db,
        from,
        path.join(destination, path.relative(staged, prepared.entry)),
      );
    }
    const migrated = applyRelocation(db, plan);
    await writeFile(
      path.join(retired, "executor-relocation.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          from: plan.from,
          to: plan.to,
          version: plan.version,
          digest: plan.digest,
          sessionIds: plan.sessions.map((session) => session.id),
          migrated,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify(
        { migrated, retainedFullCopy: retired, activeData: data },
        null,
        2,
      ),
    );
  }
} finally {
  db.close();
}
