import { describe, expect, it } from "vitest";

import {
  LAB_APP_RUNNER_PLAN_SCHEMA,
  buildLabAppRunnerPlan
} from "../src/lab-app-runner.js";

describe("lab app runner plan", () => {
  it("plans a conservative Next.js dev server with dependency install and browser surfaces", () => {
    const plan = buildLabAppRunnerPlan({
      hasNodeModules: false,
      lockfiles: ["pnpm-lock.yaml"],
      packageJson: {
        dependencies: { next: "^15.0.0", react: "^19.0.0" },
        packageManager: "pnpm@10.26.2",
        scripts: {
          build: "next build",
          dev: "next dev"
        }
      }
    });

    expect(plan.schema).toBe(LAB_APP_RUNNER_PLAN_SCHEMA);
    expect(plan.ok).toBe(true);
    expect(plan.framework).toBe("next");
    expect(plan.packageManager).toBe("pnpm");
    expect(plan.install).toMatchObject({
      command: "pnpm install --frozen-lockfile --ignore-scripts",
      mode: "run"
    });
    expect(plan.devServer).toMatchObject({
      command: 'HOST="$APP_HOST" PORT="$APP_PORT" pnpm run dev --hostname "$APP_HOST" --port "$APP_PORT"',
      port: 3000,
      scriptName: "dev",
      url: "http://127.0.0.1:3000"
    });
    expect(plan.readiness?.command).toBe('wait_for_http "$APP_URL" 120000 1000');
    expect(plan.surfaces.map((surface) => surface.id)).toEqual(["desktop", "mobile"]);
    expect(plan.shell.script).toContain("google-chrome");
    expect(plan.shell.script).toContain('open_lab_surface "$APP_URL" mobile 390 844');
  });

  it("selects Vite defaults and npm ci for package-lock projects", () => {
    const plan = buildLabAppRunnerPlan({
      lockfiles: ["package-lock.json"],
      packageJson: {
        devDependencies: { vite: "^6.0.0" },
        scripts: {
          dev: "vite"
        }
      }
    });

    expect(plan.ok).toBe(true);
    expect(plan.framework).toBe("vite");
    expect(plan.packageManager).toBe("npm");
    expect(plan.install).toMatchObject({
      command: "npm ci --ignore-scripts --no-audit --no-fund",
      mode: "when-missing"
    });
    expect(plan.devServer).toMatchObject({
      command: 'HOST="$APP_HOST" PORT="$APP_PORT" npm run dev -- --host "$APP_HOST" --port "$APP_PORT"',
      port: 5173,
      url: "http://127.0.0.1:5173"
    });
    expect(plan.readiness?.url).toBe("http://127.0.0.1:5173");
    expect(plan.shell.commands).toContain("npm ci --ignore-scripts --no-audit --no-fund");
  });

  it("uses a generic npm script without framework-specific CLI flags", () => {
    const plan = buildLabAppRunnerPlan({
      hasNodeModules: true,
      packageJson: {
        scripts: {
          build: "some-framework build",
          dev: "some-framework dev --port 4321"
        }
      }
    });

    expect(plan.ok).toBe(true);
    expect(plan.framework).toBe("generic");
    expect(plan.install.mode).toBe("skip");
    expect(plan.devServer).toMatchObject({
      command: 'HOST="$APP_HOST" PORT="$APP_PORT" npm run dev',
      port: 4321,
      scriptName: "dev",
      url: "http://127.0.0.1:4321"
    });
    expect(plan.shell.commands).not.toContain("npm install --ignore-scripts --no-audit --no-fund");
    expect(plan.shell.script).toContain("dependencies already present");
  });

  it("fails closed when package metadata has no runnable app script", () => {
    const plan = buildLabAppRunnerPlan({
      packageJson: {
        scripts: {
          build: "tsc -p tsconfig.json",
          lint: "eslint .",
          test: "vitest run"
        }
      }
    });

    expect(plan.ok).toBe(false);
    expect(plan.framework).toBe("none");
    expect(plan.devServer).toBeUndefined();
    expect(plan.readiness).toBeUndefined();
    expect(plan.surfaces).toEqual([]);
    expect(plan.warnings.join("\n")).toContain("No runnable app script");
    expect(plan.shell.script).toContain("skipping app surface launch");
  });

  it("does not leak raw package script secrets or private-looking local paths", () => {
    const secretLike = ["sk", "testsecretvalue1234567890"].join("-");
    const privateLikePath = ["/workspace", "private", "vite.config.ts"].join("/");
    const plan = buildLabAppRunnerPlan({
      packageJson: {
        devDependencies: { vite: "^6.0.0" },
        scripts: {
          dev: `vite --token ${secretLike} --config ${privateLikePath}`
        }
      }
    });

    const publicPlan = JSON.stringify(plan);
    expect(publicPlan).not.toContain(secretLike);
    expect(publicPlan).not.toContain(privateLikePath);
    expect(plan.devServer?.command).toBe('HOST="$APP_HOST" PORT="$APP_PORT" npm run dev -- --host "$APP_HOST" --port "$APP_PORT"');
  });
});
