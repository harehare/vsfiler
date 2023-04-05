import * as vscode from "vscode";
import * as path from "path";

export const isWorkspaceRoot = (root: string) =>
  (vscode.workspace.workspaceFolders?.filter((w) => w.uri.path === root)
    ?.length ?? 0) > 0;

export const getWorkspaceRoot = (root: string) =>
  vscode.workspace.workspaceFolders?.find((w) => root.startsWith(w.uri.path));

export const getPathExcludeWorkspaceRoot = (filePath: string) => {
  const root = getWorkspaceRoot(filePath);
  const p = root ? filePath.replace(path.dirname(root.uri.path), "") : filePath;
  return p.startsWith("/") ? p.slice(1) : p;
};

export const getRelativePath = (filePath: string) => {
  const root = getWorkspaceRoot(filePath);
  return root ? filePath.replace(root.uri.path, "") : filePath;
};
