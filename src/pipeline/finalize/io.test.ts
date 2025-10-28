import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ConfigEnvironment } from "../../types.js";
import { DEFAULT_OUTPUT_DIR_ENV, deliverOutput, generateDefaultOutputPath } from "./io.js";

interface MockStdin extends EventEmitter {
  end: (chunk: string, encoding?: BufferEncoding) => void;
}

interface MockChildProcess extends EventEmitter {
  stdin: MockStdin;
}

const copyInvocations: string[] = [];

function createConfigEnv(values: Record<string, string | undefined> = {}): ConfigEnvironment {
  return {
    get: (key: string) => values[key],
    has: (key: string) => values[key] !== undefined,
    entries(): IterableIterator<readonly [key: string, value: string]> {
      const entries = Object.entries(values).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      return entries[Symbol.iterator]();
    },
  };
}

type CleanupTask = () => Promise<void> | void;

let originalHomeEnv: string | undefined;
let cleanupTasks: CleanupTask[] = [];

function registerCleanup(task: CleanupTask): void {
  cleanupTasks.push(task);
}

beforeEach(() => {
  originalHomeEnv = process.env.HOME;
  cleanupTasks = [];
});

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    if (task) {
      await task();
    }
  }
  if (originalHomeEnv === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHomeEnv;
  }
});

mock.module("node:child_process", () => ({
  spawn: () => {
    const child = new EventEmitter() as MockChildProcess;
    const stdin = new EventEmitter() as MockStdin;
    stdin.end = (chunk: string, _encoding?: BufferEncoding) => {
      copyInvocations.push(chunk);
      child.emit("close", 0);
    };
    child.stdin = stdin;
    return child;
  },
}));

describe("deliverOutput", () => {
  let tmpDir: string;

  beforeEach(async () => {
    copyInvocations.length = 0;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "deliver-output-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    mock.restore();
  });

  test("copy=true の場合は本文を既定でコピーする", async () => {
    await deliverOutput({
      content: "summary text",
      copy: true,
      cwd: tmpDir,
      configEnv: createConfigEnv(),
    });
    expect(copyInvocations).toEqual(["summary text"]);
  });

  test("copySource が file の場合はファイルの内容をコピーする", async () => {
    const artifactPath = path.join(tmpDir, "diagram.d2");
    await fs.writeFile(artifactPath, "diagram body", { encoding: "utf8" });

    await deliverOutput({
      content: "summary text",
      copy: true,
      cwd: tmpDir,
      copySource: {
        type: "file",
        filePath: "diagram.d2",
      },
      configEnv: createConfigEnv(),
    });

    expect(copyInvocations).toEqual(["diagram body"]);
  });

  test("copySource が file でファイルが存在しない場合はエラーになる", async () => {
    await expect(
      deliverOutput({
        content: "summary text",
        copy: true,
        cwd: tmpDir,
        copySource: {
          type: "file",
          filePath: "missing.d2",
        },
        configEnv: createConfigEnv(),
      }),
    ).rejects.toThrow("Error: --copy の対象ファイルが存在しません: missing.d2");

    expect(copyInvocations).toEqual([]);
  });

  test("filePath に HOME 展開を含むパスを指定できる", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "deliver-home-"));
    registerCleanup(async () => {
      await fs.rm(fakeHome, { recursive: true, force: true });
    });
    const workspace = path.join(fakeHome, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    process.env.HOME = fakeHome;

    const targetPath = "~/workspace/result.txt";
    await deliverOutput({
      content: "home expansion",
      cwd: workspace,
      filePath: targetPath,
      configEnv: createConfigEnv({ HOME: fakeHome }),
    });
    const expectedPath = path.join(fakeHome, "workspace", "result.txt");
    const written = await fs.readFile(expectedPath, "utf8");
    expect(written).toBe("home expansion");
  });

  test("HOME が未設定でもユーザーディレクトリにフォールバックする", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "deliver-fallback-home-"));
    registerCleanup(async () => {
      await fs.rm(fakeHome, { recursive: true, force: true });
    });
    const workspace = path.join(fakeHome, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const originalHomedir = os.homedir;
    registerCleanup(() => {
      (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    });
    (os as unknown as { homedir: () => string }).homedir = () => fakeHome;
    delete process.env.HOME;

    await deliverOutput({
      content: "fallback expansion",
      cwd: workspace,
      filePath: "~/workspace/output.txt",
      configEnv: createConfigEnv(),
    });

    const expectedPath = path.join(fakeHome, "workspace", "output.txt");
    const written = await fs.readFile(expectedPath, "utf8");
    expect(written).toBe("fallback expansion");
  });

  test("ワークスペース外へ出る HOME 展開はエラーになる", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "deliver-home-"));
    registerCleanup(async () => {
      await fs.rm(fakeHome, { recursive: true, force: true });
    });
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "deliver-workspace-"));
    registerCleanup(async () => {
      await fs.rm(workspace, { recursive: true, force: true });
    });
    process.env.HOME = fakeHome;

    await expect(
      deliverOutput({
        content: "should fail",
        cwd: workspace,
        filePath: "~/outside.txt",
        configEnv: createConfigEnv({ HOME: fakeHome }),
      }),
    ).rejects.toThrow(/ワークスペース配下/);
  });

  test("ConfigEnv のみで HOME を解決する", async () => {
    const globalHome = await fs.mkdtemp(path.join(os.tmpdir(), "deliver-global-home-"));
    registerCleanup(async () => {
      await fs.rm(globalHome, { recursive: true, force: true });
    });
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "deliver-config-home-"));
    registerCleanup(async () => {
      await fs.rm(configHome, { recursive: true, force: true });
    });
    const workspace = path.join(configHome, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    process.env.HOME = globalHome;

    await deliverOutput({
      content: "config home content",
      cwd: workspace,
      filePath: "~/workspace/result.txt",
      configEnv: createConfigEnv({ HOME: configHome }),
    });
    const expected = path.join(configHome, "workspace", "result.txt");
    const written = await fs.readFile(expected, "utf8");
    expect(written).toBe("config home content");
  });
});

describe("generateDefaultOutputPath", () => {
  let originalEnv: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    originalEnv = process.env[DEFAULT_OUTPUT_DIR_ENV];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt5-output-"));
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env[DEFAULT_OUTPUT_DIR_ENV];
    } else {
      process.env[DEFAULT_OUTPUT_DIR_ENV] = originalEnv;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("ワークスペース出力ディレクトリを既定で利用する", () => {
    const { relativePath, absolutePath } = generateDefaultOutputPath({
      mode: "d2",
      extension: "d2",
      cwd: tempDir,
      configEnv: createConfigEnv(),
    });
    expect(relativePath.startsWith(`output${path.sep}d2${path.sep}`)).toBe(true);
    expect(absolutePath.startsWith(path.join(tempDir, "output", "d2"))).toBe(true);
  });

  test("環境変数で指定したディレクトリを基準にする", () => {
    process.env[DEFAULT_OUTPUT_DIR_ENV] = "custom/dir";
    const { relativePath, absolutePath } = generateDefaultOutputPath({
      mode: "sql",
      extension: "sql",
      cwd: tempDir,
      configEnv: createConfigEnv({ [DEFAULT_OUTPUT_DIR_ENV]: "custom/dir" }),
    });
    expect(relativePath.startsWith(`custom${path.sep}dir${path.sep}`)).toBe(true);
    expect(absolutePath.startsWith(path.join(tempDir, "custom", "dir"))).toBe(true);
  });

  test("チルダ始まりのディレクトリを展開する", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "gpt5-home-"));
    registerCleanup(async () => {
      await fs.rm(fakeHome, { recursive: true, force: true });
    });
    process.env.HOME = fakeHome;
    const workspace = await fs.mkdtemp(path.join(fakeHome, "workspace-"));
    registerCleanup(async () => {
      await fs.rm(workspace, { recursive: true, force: true });
    });
    const relativeFromHome = path.relative(fakeHome, workspace);
    process.env[DEFAULT_OUTPUT_DIR_ENV] = `~/${relativeFromHome}/artifacts`;
    const { relativePath, absolutePath } = generateDefaultOutputPath({
      mode: "mermaid",
      extension: "mmd",
      cwd: workspace,
      configEnv: createConfigEnv({
        [DEFAULT_OUTPUT_DIR_ENV]: `~/${relativeFromHome}/artifacts`,
        HOME: fakeHome,
      }),
    });
    expect(relativePath.startsWith(`artifacts${path.sep}`)).toBe(true);
    expect(absolutePath.startsWith(path.join(workspace, "artifacts"))).toBe(true);
  });

  test("チルダ単体のディレクトリも展開する", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "gpt5-home-"));
    registerCleanup(async () => {
      await fs.rm(fakeHome, { recursive: true, force: true });
    });
    process.env.HOME = fakeHome;
    process.env[DEFAULT_OUTPUT_DIR_ENV] = "~";
    const { relativePath, absolutePath } = generateDefaultOutputPath({
      mode: "ask",
      extension: "txt",
      cwd: fakeHome,
      configEnv: createConfigEnv({
        [DEFAULT_OUTPUT_DIR_ENV]: "~",
        HOME: fakeHome,
      }),
    });
    expect(relativePath.startsWith(`output${path.sep}ask${path.sep}`)).toBe(false);
    expect(absolutePath.startsWith(fakeHome)).toBe(true);
  });

  test("ワークスペース外を指す環境変数はエラーにする", () => {
    process.env[DEFAULT_OUTPUT_DIR_ENV] = path.join("..", "outside");
    expect(() =>
      generateDefaultOutputPath({
        mode: "mermaid",
        extension: "mmd",
        cwd: tempDir,
        configEnv: createConfigEnv({ [DEFAULT_OUTPUT_DIR_ENV]: path.join("..", "outside") }),
      }),
    ).toThrow(/GPT_5_CLI_OUTPUT_DIR/u);
  });

  test("ConfigEnv の出力設定を優先して利用する", () => {
    const configEnv = createConfigEnv({ [DEFAULT_OUTPUT_DIR_ENV]: "env-config/output" });
    delete process.env[DEFAULT_OUTPUT_DIR_ENV];
    const { relativePath, absolutePath } = generateDefaultOutputPath({
      mode: "ask",
      extension: "txt",
      cwd: tempDir,
      configEnv,
    });

    expect(relativePath.startsWith(`env-config${path.sep}output${path.sep}`)).toBe(true);
    expect(absolutePath.startsWith(path.join(tempDir, "env-config", "output"))).toBe(true);
  });

  test("ConfigEnv の出力設定がワークスペース外なら検証で失敗する", () => {
    const configEnv = createConfigEnv({ [DEFAULT_OUTPUT_DIR_ENV]: path.join("..", "outside") });
    delete process.env[DEFAULT_OUTPUT_DIR_ENV];
    expect(() =>
      generateDefaultOutputPath({
        mode: "sql",
        extension: "sql",
        cwd: tempDir,
        configEnv,
      }),
    ).toThrow(/GPT_5_CLI_OUTPUT_DIR/u);
  });

  test("ConfigEnv が未設定でも process.env に依存しない", () => {
    process.env[DEFAULT_OUTPUT_DIR_ENV] = "env-only/output";
    const configEnv = createConfigEnv();

    const { absolutePath } = generateDefaultOutputPath({
      mode: "mermaid",
      extension: "mmd",
      cwd: tempDir,
      configEnv,
    });

    expect(absolutePath.startsWith(path.join(tempDir, "output", "mermaid"))).toBe(true);
  });
});
