import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as util from "util";

import {
  findItems,
  FileItem,
  createFile,
  rename,
  deleteFileOrDirectory,
  findItemsFromWorkspaceRoot,
  copy,
  separatorItem,
  menuItems,
  diff,
  loadingItem,
  createDirectory,
} from "./item";
import {
  getPathExcludeWorkspaceRoot,
  getRelativePath,
  getWorkspaceRoot,
  isWorkspaceRoot,
} from "./util";
import { defaultQueryOptions, QueryOptions } from "./query";
import { Ignore } from "ignore";
import { debounce } from "throttle-debounce";

const stat = util.promisify(fs.stat);
const LAST_OPEN_PATH_KEY = "LAST_OPEN_PATH_KEY";

type Action =
  | { action: "copy-relative-path" }
  | { action: "copy-file" }
  | { action: "delete" }
  | { action: "open-to-the-side" }
  | { action: "paste-file"; uri: vscode.Uri }
  | { action: "select-diff-left" }
  | { action: "rename" }
  | { action: "select-diff-right"; left: vscode.Uri };

const getLastOpenDirPath = async (context: vscode.ExtensionContext) => {
  const lastOpenPath = await context.workspaceState.get<string>(
    LAST_OPEN_PATH_KEY
  );

  return lastOpenPath && fs.existsSync(lastOpenPath)
    ? (await stat(lastOpenPath)).isDirectory()
      ? lastOpenPath
      : path.dirname(lastOpenPath)
    : undefined;
};

export const open = async ({
  workspaceName,
  context,
  options: { showCurrentDir, gitignore, exclude },
}: {
  workspaceName: string | undefined;
  context: vscode.ExtensionContext;
  showCurrentDir?: boolean;
  options: {
    showCurrentDir?: boolean;
    gitignore?: Ignore;
    exclude?: string;
  };
}) => {
  const quickPick = vscode.window.createQuickPick<FileItem>();
  const openDirPath =
    showCurrentDir && vscode.window.activeTextEditor
      ? path.dirname(vscode.window.activeTextEditor.document.uri.path)
      : await getLastOpenDirPath(context);
  const rootSeparator = separatorItem(workspaceName);

  quickPick.placeholder = openDirPath
    ? `Search from ${getPathExcludeWorkspaceRoot(openDirPath)}`
    : vscode.workspace.workspaceFolders
    ? `Search from ${vscode.workspace.workspaceFolders
        .map((w) => w.name)
        .join(", ")}`
    : "Search";
  quickPick.matchOnDescription = true;
  quickPick.enabled = false;
  quickPick.items = [loadingItem()];
  quickPick.show();

  const loadItems = async ({
    options,
    path,
    copyUri,
  }: {
    options: QueryOptions;
    path?: string;
    copyUri?: vscode.Uri;
  }) => [
    ...(!path || isWorkspaceRoot(path)
      ? [
          rootSeparator,
          ...(await findItemsFromWorkspaceRoot({
            gitignore,
            exclude,
            copyUri,
            options,
          })),
        ]
      : await findItems({
          root: path ?? null,
          gitignore,
          exclude,
          copyUri,
          options,
        })),
    ...menuItems(),
  ];

  quickPick.items = [
    ...(openDirPath
      ? await findItems({
          root: openDirPath,
          gitignore,
          exclude,
          options: defaultQueryOptions,
        })
      : [
          rootSeparator,
          ...(await findItemsFromWorkspaceRoot({
            gitignore,
            exclude,
            options: defaultQueryOptions,
          })),
        ]),
    ...menuItems(),
  ];
  quickPick.enabled = true;

  {
    let currentRoot = openDirPath;
    let queryOptions: QueryOptions = defaultQueryOptions;
    let action: Action | undefined = undefined;

    const search = debounce(300, async (query: string) => {
      quickPick.busy = true;

      if (currentRoot && !isWorkspaceRoot(currentRoot)) {
        quickPick.items = [
          ...(await findItems({
            root: currentRoot,
            query,
            gitignore,
            exclude,
            copyUri: action?.action === "paste-file" ? action.uri : undefined,
            options: queryOptions,
          })),
          ...menuItems(),
        ];
      } else {
        quickPick.items = [
          ...(await findItemsFromWorkspaceRoot({
            query,
            gitignore,
            exclude,
            copyUri: action?.action === "paste-file" ? action.uri : undefined,
            options: queryOptions,
          })),
          ...menuItems(),
        ];
      }

      quickPick.busy = false;
    });

    quickPick.onDidChangeValue(search);
    quickPick.onDidAccept(async () => {
      if (quickPick.selectedItems.length > 0) {
        search.cancel();

        const item = quickPick.selectedItems[0];

        if (item.type === "empty") {
          return;
        }

        const isRoot = item.type === "root" || isWorkspaceRoot(item.uri.path);
        const workspaceRoot = isRoot
          ? getWorkspaceRoot(item.uri.path)
          : undefined;

        currentRoot =
          !item.uri.scheme || item.uri.path === "/"
            ? currentRoot
            : isRoot
            ? undefined
            : (await stat(item.uri.path)).isDirectory()
            ? item.uri.path
            : path.dirname(item.uri.path);

        quickPick.placeholder = isRoot
          ? vscode.workspace.name && `Search from ${vscode.workspace.name}`
          : `Search from ${getPathExcludeWorkspaceRoot(item.uri.path)}`;
        quickPick.value = "";

        if (action?.action === "rename") {
          const renameResult = await rename(item.uri.path);

          if (renameResult) {
            if (renameResult.isDirectory) {
              quickPick.items = await loadItems({
                path: renameResult.path,
                options: queryOptions,
              });
              quickPick.value = "";
              quickPick.show();
            } else {
              await vscode.window.showTextDocument(
                await vscode.workspace.openTextDocument(renameResult.path)
              );
            }
          }
          action = undefined;
          return;
        }

        if (action?.action === "delete") {
          const deleteResult = await deleteFileOrDirectory(item.uri.path);

          if (deleteResult) {
            const dirName = path.dirname(deleteResult.path);
            quickPick.items = await loadItems({
              path: dirName,
              options: queryOptions,
            });
            quickPick.value = "";
            quickPick.show();
          }
          action = undefined;
          return;
        }

        if (item.type === "directory") {
          await context.workspaceState.update(LAST_OPEN_PATH_KEY, currentRoot);
          quickPick.items = await loadItems({
            path: item.uri.path,
            options: queryOptions,
            copyUri: action?.action === "paste-file" ? action.uri : undefined,
          });
          return;
        }

        if (item.type === "new-file") {
          await createFile(item.uri.path);
          return;
        }

        if (item.type === "new-folder") {
          const createDirPath = await createDirectory(item.uri.path);

          if (createDirPath) {
            await context.workspaceState.update(
              LAST_OPEN_PATH_KEY,
              createDirPath
            );
            currentRoot = createDirPath;
            quickPick.items = await findItems({
              root: createDirPath,
              gitignore,
              exclude,
              copyUri: action?.action === "paste-file" ? action.uri : undefined,
              options: queryOptions,
            });
            quickPick.placeholder = `Search from ${
              workspaceRoot
                ? createDirPath.replace(workspaceRoot.uri.path, "")
                : createDirPath
            }`;
            quickPick.show();
          }

          return;
        }

        if (item.type === "root") {
          quickPick.items = await loadItems({
            options: queryOptions,
            copyUri: action?.action === "paste-file" ? action.uri : undefined,
          });
          return;
        }

        if (item.type === "copy-relative-path") {
          action = { action: "copy-relative-path" };
          quickPick.title = "Select file to copy relative path";
          quickPick.items = await loadItems({
            path: currentRoot,
            options: queryOptions,
          });
          return;
        }

        if (item.type === "diff") {
          quickPick.title = "Select files to compare";
          action = { action: "select-diff-left" };
          quickPick.items = await loadItems({
            path: currentRoot,
            options: queryOptions,
          });
          return;
        }

        if (item.type === "copy-file") {
          action = { action: "copy-file" };
          quickPick.title = "Select file to copy file";
          quickPick.items = await loadItems({
            path: currentRoot,
            options: queryOptions,
          });
          return;
        }

        if (item.type === "paste" && action?.action === "paste-file") {
          await copy(action.uri.path, item.uri.path);
          quickPick.items = await loadItems({
            path: item.uri.path,
            options: queryOptions,
          });
          action = undefined;
          return;
        }

        if (item.type === "open-to-the-side") {
          action = { action: "open-to-the-side" };
          quickPick.title = "Select files to open on the side";
          quickPick.items = await loadItems({
            path: currentRoot,
            options: queryOptions,
          });
          return;
        }

        if (item.type === "rename") {
          action = { action: "rename" };
          quickPick.title = "Select file to rename file";
          quickPick.items = await loadItems({
            path: currentRoot,
            options: queryOptions,
          });
          return;
        }

        if (item.type === "delete") {
          action = { action: "delete" };
          quickPick.title = "Select files to delete";
          quickPick.items = await loadItems({
            path: currentRoot,
            options: queryOptions,
          });
          return;
        }

        if (action && action.action !== "paste-file") {
          switch (action.action) {
            case "select-diff-left":
              action = { action: "select-diff-right", left: item.uri };
              quickPick.title = `Select files to compare with ${
                item.uri.scheme === "file"
                  ? path.basename(item.uri.path)
                  : item.uri.path
              }`;
              quickPick.items = await loadItems({
                path: currentRoot,
                options: queryOptions,
              });
              return;
            case "select-diff-right":
              quickPick.title = undefined;
              await diff(action.left, item.uri);
              action = undefined;
              return;
            case "open-to-the-side":
              quickPick.hide();
              const currentColumn = vscode.window.activeTextEditor
                ? vscode.window.activeTextEditor.viewColumn
                : vscode.ViewColumn.Two;
              await vscode.window.showTextDocument(
                await vscode.workspace.openTextDocument(item.uri),
                currentColumn ? currentColumn + 1 : vscode.ViewColumn.Two
              );
              action = undefined;
              return;
            case "copy-file":
              action = { action: "paste-file", uri: item.uri };
              quickPick.title = undefined;
              quickPick.items = await loadItems({
                path: currentRoot,
                options: queryOptions,
                copyUri: item.uri,
              });
              return;
            case "copy-relative-path":
              quickPick.hide();
              await vscode.env.clipboard.writeText(
                getRelativePath(item.uri.path)
              );
              action = undefined;
              return;
          }

          return;
        }

        // Open file
        {
          quickPick.hide();
          await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument(item.uri),
            { preview: false }
          );
        }
      }
    });
  }
};
