import * as vscode from "vscode";
import path from "node:path";

export class PublishLogger {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly enabled: boolean
  ) {}

  async append(event: string, details: Record<string, unknown>): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const file = vscode.Uri.file(path.join(this.context.globalStorageUri.fsPath, "publish.log"));
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const payload = `[${new Date().toISOString()}] ${event}\n${safeStringify(details)}\n\n`;
    let existing = "";
    try {
      existing = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
    } catch {
      existing = "";
    }
    await vscode.workspace.fs.writeFile(file, Buffer.from(existing + payload, "utf8"));
  }
}

function safeStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, currentValue) => {
      if (currentValue instanceof Error) {
        return {
          name: currentValue.name,
          message: currentValue.message,
          stack: currentValue.stack
        };
      }
      return currentValue;
    },
    2
  );
}
