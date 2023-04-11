import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import { Ignore } from "ignore";
import LRUCache from "lru-cache";

import {
  getWorkspaceRoot,
  isWorkspaceRoot,
  getPathExcludeWorkspaceRoot,
} from "./util";
import { expandQuery, QueryOptions } from "./query";

const stat = util.promisify(fs.stat);
const readdir = util.promisify(fs.readdir);
const cache = new LRUCache<string, FileItem[]>({
  maxSize: 1000,
  ttl: 1000 * 60 * 10,
  allowStale: false,
  updateAgeOnGet: false,
  updateAgeOnHas: false,
  sizeCalculation: () => {
    return 1;
  },
});
let cancelToken: vscode.CancellationTokenSource | undefined = undefined;

export interface FileItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
  type?:
    | "open-to-the-side"
    | "copy-file"
    | "empty"
    | "file"
    | "delete"
    | "directory"
    | "new-file"
    | "new-folder"
    | "paste"
    | "root"
    | "diff"
    | "copy-relative-path"
    | "rename";
}

export const separatorItem = ({
  label,
  alwaysShow,
}: {
  label?: string;
  alwaysShow?: boolean;
}): FileItem => ({
  label: label ?? "",
  uri: vscode.Uri.from({ scheme: "" }),
  kind: vscode.QuickPickItemKind.Separator,
  alwaysShow,
});

export const loadingItem = (): FileItem => ({
  label: "$(loading~spin)  Loading...",
  uri: vscode.Uri.from({ scheme: "" }),
  type: "empty",
});

export const findItemsFromWorkspaceRoot = async ({
  query,
  gitignore,
  exclude,
  copyUri,
  options,
}: {
  query?: string;
  gitignore: Ignore | undefined;
  options: QueryOptions;
  exclude?: string;
  copyUri?: vscode.Uri;
}) => {
  const rootPathList = vscode.workspace.workspaceFolders?.map(
    (d) => d.uri.path
  );

  return rootPathList
    ? (
        await Promise.all(
          rootPathList.flatMap((p) =>
            findItems({
              root: p,
              query,
              gitignore,
              exclude,
              copyUri,
              options,
            })
          )
        )
      ).flatMap((f) => f)
    : await findItems({
        root: null,
        query,
        gitignore,
        exclude,
        copyUri,
        options,
      });
};

export const findItems = async ({
  root,
  query,
  gitignore,
  exclude,
  copyUri,
  options,
}: {
  root: string | null;
  query?: string;
  gitignore: Ignore | undefined;
  exclude?: string;
  copyUri?: vscode.Uri;
  options: QueryOptions;
}): Promise<FileItem[]> => {
  if (!root) {
    return [];
  }

  if (cancelToken) {
    cancelToken.cancel();
    cancelToken = undefined;
  }

  const cacheKey = `${root ?? "root"}.${query}`;

  if (!cache.has(cacheKey)) {
    cancelToken = new vscode.CancellationTokenSource();
    const workspaceRoot = getWorkspaceRoot(root);
    const isRoot = isWorkspaceRoot(root);

    const [currentFiles, matchFiles, currentDirs] = await Promise.all([
      vscode.workspace.findFiles(
        new vscode.RelativePattern(root, "*"),
        exclude,
        10000,

        cancelToken.token
      ),
      vscode.workspace.findFiles(
        new vscode.RelativePattern(
          root,
          query ? `**/${expandQuery(query, options)}` : "*"
        ),
        exclude,
        10000,
        cancelToken.token
      ),
      readdir(root),
    ]);

    const dirs: FileItem[] = currentDirs
      .filter((f) => fs.statSync(path.join(root, f)).isDirectory())
      .map((f) => path.join(root, f))
      .map((f) => ({
        uri: vscode.Uri.file(f),
        label: `$(${vscode.ThemeIcon.Folder.id})  ${path.basename(f)}/`,
        description: workspaceRoot && isRoot ? workspaceRoot.name : "",
        type: "directory",
      }));

    const files: FileItem[] = [
      ...new Set([
        ...currentFiles.map((f) => f.path),
        ...matchFiles.map((f) => f.path),
      ]),
    ].map((filePath) => ({
      uri: vscode.Uri.file(filePath),
      label: `$(${vscode.ThemeIcon.File.id})  ${path.basename(filePath)}`,
      description: workspaceRoot
        ? workspaceRoot.uri.path === path.dirname(filePath)
          ? workspaceRoot.name
          : root === path.dirname(filePath)
          ? ""
          : `${workspaceRoot.name} - ${path.dirname(
              filePath.replace(workspaceRoot.uri.path, "")
            )}`
        : "",
      type: "file",
    }));

    const items = [...dirs, ...files];
    const filteredItem = gitignore
      ? items.filter(
          (f) =>
            !gitignore.ignores(
              path.join(root, f.uri.path).replace(`${root}/`, "")
            )
        )
      : items;

    if (isWorkspaceRoot(root)) {
      cache.set(cacheKey, [
        ...filteredItem,
        separatorItem({ label: "FILE", alwaysShow: true }),
        newFileItem(root, true),
        newDirectoryItem(root, true),
        ...(copyUri ? [pasteItem(vscode.Uri.file(root))] : []),
        separatorItem({}),
      ]);
    } else {
      cache.set(cacheKey, [
        separatorItem({ label: getPathExcludeWorkspaceRoot(root) }),
        {
          label: "$(reply)  ../",
          uri: vscode.Uri.file(path.dirname(root)),
          type: "directory",
        },
        ...filteredItem,
        separatorItem({ label: "FILE", alwaysShow: true }),
        newFileItem(root, false),
        newDirectoryItem(root, false),
        ...(copyUri ? [pasteItem(vscode.Uri.file(root))] : []),
        separatorItem({}),
      ]);
    }
  }

  return cache.get(cacheKey) ?? [];
};

export const openEditorItems = (): FileItem[] => {
  const items = vscode.workspace.textDocuments.filter(
    (t) => t.uri.scheme === "file" || t.uri.scheme === "untitled"
  );

  if (!items) {
    return [];
  }

  return [
    separatorItem({ label: "OPEN EDITORS", alwaysShow: true }),
    ...items.map(
      (item): FileItem => ({
        uri: item.uri,
        label: `$(${vscode.ThemeIcon.File.id})  ${path.basename(
          item.uri.path
        )}`,
        description:
          item.uri.scheme === "file"
            ? removeWorkspaceRootFromPath(item.uri.path)
            : "",
        type: "file",
        alwaysShow: true,
      })
    ),
  ];
};

const newFileItem = (dir: string, isRoot: boolean): FileItem => ({
  uri: vscode.Uri.file(dir),
  label: "$(new-file)  New File...",
  description: isRoot ? removeWorkspaceRootFromPath(dir) : "",
  type: "new-file",
  alwaysShow: true,
});

const newDirectoryItem = (dir: string, isRoot: boolean): FileItem => ({
  uri: vscode.Uri.file(dir),
  label: "$(file-directory-create)  New Folder...",
  description: isRoot ? removeWorkspaceRootFromPath(dir) : "",
  type: "new-folder",
  alwaysShow: true,
});

export const menuItems = (): FileItem[] => [
  separatorItem({ alwaysShow: true }),
  {
    label: "$(split-horizontal)  Open to the Side",
    uri: vscode.Uri.from({ scheme: "" }),
    type: "open-to-the-side",
    alwaysShow: true,
  },
  {
    uri: vscode.Uri.from({ scheme: "" }),
    label: "$(copy)  Copy File",
    type: "copy-file",
    alwaysShow: true,
  },
  {
    uri: vscode.Uri.from({ scheme: "" }),
    label: "$(link)  Copy Relative Path",
    type: "copy-relative-path",
    alwaysShow: true,
  },
  {
    uri: vscode.Uri.from({ scheme: "" }),
    label: "$(edit)  Rename...",
    type: "rename",
    alwaysShow: true,
  },
  {
    uri: vscode.Uri.from({ scheme: "" }),
    label: "$(trash)  Delete",
    type: "delete",
  },
  {
    uri: vscode.Uri.from({ scheme: "" }),
    label: "$(diff)  Compare Files",
    type: "diff",
  },
  ...openEditorItems(),
];

const pasteItem = (uri: vscode.Uri): FileItem => ({
  uri,
  label: "$(clippy)  Paste",
  description: getWorkspaceRoot(uri.path)?.name ?? uri.path,
  type: "paste",
});

const removeWorkspaceRootFromPath = (filePath: string) => {
  const workspaceRoot = vscode.workspace.workspaceFolders?.find((w) =>
    filePath.startsWith(w.uri.path)
  );

  return workspaceRoot
    ? `${workspaceRoot.name}${filePath.replace(workspaceRoot.uri.path, "")}`
    : filePath;
};

export const createFile = async (dir: string) => {
  const name = await vscode.window.showInputBox({
    placeHolder: "New file name",
    validateInput: (v) => {
      if (!v) {
        return "File name is empty";
      }

      const createFilePath = path.join(dir, v);
      return fs.existsSync(createFilePath) ? `${v} already exists` : null;
    },
  });

  if (!name) {
    return;
  }

  const newPath = path.join(dir, name);

  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(newPath),
    Buffer.from("", "utf8")
  );

  await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(newPath)
  );
};

export const createDirectory = async (dir: string) => {
  const name = await vscode.window.showInputBox({
    placeHolder: "New folder name",
    validateInput: (v) => {
      if (!v) {
        return "Folder name is empty";
      }

      const createFolderPath = path.join(dir, v);
      return fs.existsSync(createFolderPath) ? `${v} already exists` : null;
    },
  });

  if (!name) {
    return;
  }

  const newPath = path.join(dir, name);

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(newPath));

  cache.clear();
  return newPath;
};

export const rename = async (basePath: string) => {
  const isDirectory = (await stat(basePath)).isDirectory();
  const dirName = path.dirname(basePath);
  const inputFileName = await vscode.window.showInputBox({
    value: path.basename(basePath),
    placeHolder: `Enter ${isDirectory ? "directory" : "file"} name`,
    validateInput: (v) => {
      if (!v) {
        return "name is empty";
      }

      const createPath = path.join(dirName, v);
      return fs.existsSync(createPath) ? `${v} already exists` : null;
    },
  });

  if (!inputFileName) {
    return null;
  }

  const newFileName = path.join(dirName, inputFileName);

  await vscode.workspace.fs.rename(
    vscode.Uri.file(basePath),
    vscode.Uri.file(newFileName)
  );

  cache.clear();
  return { isDirectory, path: newFileName };
};

export const deleteFileOrDirectory = async (basePath: string) => {
  const isDirectory = (await stat(basePath)).isDirectory();
  const baseName = path.basename(basePath);
  const answer = await vscode.window.showInformationMessage(
    `Are you sure you want to delete '${baseName}'?`,
    { modal: true },
    "Move to trash",
    "Cancel"
  );

  if (answer === "Move to trash") {
    await vscode.workspace.fs.delete(vscode.Uri.file(basePath), {
      useTrash: true,
      recursive: isDirectory,
    });
    cache.clear();
    return { path: basePath };
  }

  return null;
};

export const copy = async (srcPath: string, destDirPath: string) => {
  if (!fs.existsSync(srcPath)) {
    await vscode.window.showErrorMessage(`${srcPath} could not be found.`);
    return;
  }

  const fileName = path.basename(srcPath);
  let destPath = path.join(destDirPath, fileName);

  while (fs.existsSync(destPath)) {
    destPath = path.join(
      destDirPath,
      `${path.basename(destPath, path.extname(destPath))} copy${path.extname(
        destPath
      )}`
    );
  }

  await vscode.workspace.fs.copy(
    vscode.Uri.file(srcPath),
    vscode.Uri.file(destPath),
    { overwrite: false }
  );

  cache.clear();
  return;
};

export const diff = async (left: vscode.Uri, right: vscode.Uri) => {
  await vscode.commands.executeCommand("vscode.diff", left, right);
};
