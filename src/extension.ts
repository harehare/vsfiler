import * as vscode from "vscode";
import * as fs from "fs";
import ignore from "ignore";
import * as util from "util";

import * as filer from "./filer";

const readFile = util.promisify(fs.readFile);

const registerCommands = async (context: vscode.ExtensionContext) => {
  const config = vscode.workspace.getConfiguration("vsfiler");
  const excludeGitIgnore = config.get<boolean>("excludeGitIgnore");
  const exclude = config.get<string>("exclude");
  const gitignore = excludeGitIgnore
    ? ignore().add(
        vscode.workspace.workspaceFolders
          ? (
              await Promise.all(
                vscode.workspace.workspaceFolders.map(async (d) =>
                  fs.existsSync(`${d.uri.path}/.gitignore`)
                    ? await readFile(`${d.uri.path}/.gitignore`, "utf8")
                    : ""
                )
              )
            ).flatMap((f) => f.split("\n"))
          : []
      )
    : undefined;
  const workspaceName = vscode.workspace.name
    ? `${vscode.workspace.name.toUpperCase()}`
    : undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand("vsfiler.open", () => {
      filer.open({
        workspaceName,
        context,
        options: {
          exclude,
          gitignore,
        },
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vsfiler.openActiveFile", () =>
      filer.open({
        workspaceName,
        context,
        options: {
          gitignore,
          exclude,
          showCurrentDir: true,
        },
      })
    )
  );
};

export function activate(context: vscode.ExtensionContext) {
  const handleDidChangeConfiguration =
    vscode.workspace.onDidChangeConfiguration(() => {
      if (context.subscriptions.length > 0) {
        context.subscriptions.forEach((s) => {
          if (s !== handleDidChangeConfiguration) {
            s.dispose();
          }
        });
      }

      registerCommands(context);
    });

  context.subscriptions.push(handleDidChangeConfiguration);
  registerCommands(context);
}

export function deactivate() {}
