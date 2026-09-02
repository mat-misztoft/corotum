import {
  confirm,
  isCancel,
  multiselect,
  note,
  progress,
  select,
  spinner,
  text,
} from "@clack/prompts";

const streams = { input: process.stdin, output: process.stderr };

export type PromptOption<T extends string> = Readonly<{
  value: T;
  label: string;
  hint?: string;
}>;

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) throw new Error("Cancelled.");
  return value;
}

export async function selectOption<T extends string>(
  message: string,
  options: readonly PromptOption<T>[],
  initialValue?: T,
): Promise<T> {
  return unwrap(
    await select({
      message,
      options: options as never,
      initialValue,
      maxItems: 12,
      ...streams,
    }),
  ) as T;
}

export async function selectMany(
  message: string,
  options: readonly PromptOption<string>[],
  selected: readonly string[] = [],
): Promise<string[]> {
  return unwrap(
    await multiselect({
      message,
      options: options as never,
      initialValues: [...selected],
      required: false,
      maxItems: 12,
      ...streams,
    }),
  );
}

export function explain(title: string, message: string): void {
  note(message, title, streams);
}

export async function selectManyGate(
  message: string,
  names: readonly string[],
  copy: Readonly<{
    all: string;
    none: string;
    choose: string;
    detail?: string;
    allHint?: string;
    noneHint?: string;
    chooseHint?: string;
  }>,
  initial: "none" | "all" = "none",
): Promise<string[]> {
  if (names.length === 0) return [];
  if (copy.detail) explain(message, copy.detail);
  const options = names.map((name) => ({ value: name, label: name }));
  const gate = await selectOption(
    `${message} (${names.length})`,
    [
      { value: "none", label: copy.none, hint: copy.noneHint },
      { value: "all", label: `${copy.all} (${names.length})`, hint: copy.allHint },
      { value: "choose", label: copy.choose, hint: copy.chooseHint },
    ],
    initial,
  );
  if (gate === "all") return [...names];
  if (gate === "none") return [];
  return selectMany(message, options);
}

export async function selectModifiedGate(
  names: readonly string[],
): Promise<ReadonlyMap<string, "replace" | "keep" | "do-not-manage">> {
  const picked = new Map<string, "replace" | "keep" | "do-not-manage">();
  if (names.length === 0) return picked;
  const each = async () => {
    for (const name of names) {
      picked.set(
        name,
        await selectOption(`Local skill ${name} differs from upstream.`, [
          { value: "replace", label: "Replace with latest" },
          { value: "keep", label: "Keep local" },
          { value: "do-not-manage", label: "Do not manage" },
        ]),
      );
    }
  };
  explain(
    "Local files differ from upstream",
    "Git fetched a different tree than the files on disk. Replace installs the fetched revision. Keep stores your local files as artifacts and remembers the source. Skip leaves them unmanaged.",
  );
  const gate = await selectOption(
    `Local skills differ from upstream (${names.length})`,
    [
      {
        value: "none",
        label: "Skip all",
        hint: "leave unmanaged",
      },
      {
        value: "replace",
        label: `Replace all with latest (${names.length})`,
        hint: "overwrite local with Git",
      },
      {
        value: "keep",
        label: `Keep all as local artifacts (${names.length})`,
        hint: "sync your files, not upstream",
      },
      { value: "choose", label: "Choose each…", hint: "per skill" },
    ],
    "none",
  );
  if (gate === "choose") {
    await each();
    return picked;
  }
  const action = gate === "none" ? "do-not-manage" : gate;
  for (const name of names) picked.set(name, action);
  return picked;
}

export async function confirmOption(
  message: string,
  initialValue: boolean,
): Promise<boolean> {
  return unwrap(await confirm({ message, initialValue, ...streams }));
}

export async function textOption(message: string): Promise<string> {
  return unwrap(await text({ message, ...streams })).trim();
}

export async function withSpinner<T>(
  message: string,
  work: () => Promise<T>,
  done = message,
): Promise<T> {
  const spin = spinner({ ...streams });
  spin.start(message);
  try {
    const result = await work();
    spin.stop(done);
    return result;
  } catch (error) {
    spin.error("Failed");
    throw error;
  }
}

export async function withProgress<T>(
  total: number,
  work: (advance: () => void) => Promise<T>,
): Promise<T> {
  const bar = progress({
    max: Math.max(total, 1),
    size: 24,
    style: "block",
    ...streams,
  });
  let done = 0;
  bar.start(`Checking skills 0/${total}`);
  try {
    const result = await work(() => {
      done += 1;
      bar.advance(1, `Checking skills ${done}/${total}`);
    });
    bar.stop(`Checked ${total} skills`);
    return result;
  } catch (error) {
    bar.error(`Checked ${done}/${total} skills`);
    throw error;
  }
}
