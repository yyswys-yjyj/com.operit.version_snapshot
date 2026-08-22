/*
METADATA
{
    "name": "snapshotver",
    "display_name": {
        "zh": "文件快照管理",
        "en": "VersionSnapshotManager",
        "default": "VersionSnapshotManager"
    },
    "description": {
        "zh": "不依赖 git 的项目快照管理：文件级变更流水、多挂载点、.gitignore 完整语法、跨版本回滚/fork。",
        "en": "Git-free project snapshot management: file-level change streams, multi-mount, full .gitignore syntax, cross-version rollback/fork."
    },
    "category": "dev_code",
    "tools": [
        {
            "name": "init",
            "description": "Initialize a directory as a snapshot project: creates {snapshotRoot}/{ProjectID}/ with manifest.json + data.db. ProjectID names the project, rootPath is the project root; extendProjectID copies another project's snapshot DB; IsMultiple=true uses MultiplePathArray to declare extra mounts ({id,path} entries; add {\"UseIgnore\":\"/abs/path/.gitignore\"} to attach an ignore file).",
            "parameters": [
                { "name": "ProjectID", "description": "Project name used as the snapshot directory name", "type": "string", "required": true },
                { "name": "rootPath", "description": "Absolute path of the project root (the _main mount)", "type": "string", "required": true },
                { "name": "extendProjectID", "description": "Inherit another project (copies its snapshot database)", "type": "string", "required": false },
                { "name": "IsMultiple", "description": "Multi-mount project flag, default false", "type": "boolean", "required": false },
                { "name": "MultiplePathArray", "description": "Mount declarations as a JSON array string, e.g. [{\"id\":\"path2\",\"path\":\"/sdcard/project/example\"}]; UseIgnore entries add an ignore file", "type": "string", "required": false },
                { "name": "maxFileSizeMB", "description": "Per-file size limit in MB, default 10; oversized files are skipped with warnings; 0 disables the limit", "type": "number", "required": false }
            ]
        },
        {
            "name": "manage",
            "description": "Operate the staging area: action=add reads current file contents into staging; action=remove writes a pending_delete marker (commits become delete changes). RelPath supports: \".\" for everything (all mounts); \"_main/xxx\" or mountKey/xxx; absolute paths inside registered mounts; multi-mount bare paths must carry a mount prefix.",
            "parameters": [
                { "name": "ProjectID", "description": "Project name", "type": "string", "required": true },
                { "name": "action", "description": "add / remove", "type": "string", "required": true },
                { "name": "RelPath", "description": "Path or mount locator (. / mount/relative / absolute)", "type": "string", "required": true }
            ]
        },
        {
            "name": "commit",
            "description": "Commit a version: turns the whole staging area into a new snapshot node by diffing against the latest snapshot. VersionID must be a monotonically increasing digit string; DisplayVersion is the public version label used by rollback/query; description and author are metadata. Staging is preserved.",
            "parameters": [
                { "name": "ProjectID", "description": "Project name", "type": "string", "required": true },
                { "name": "VersionID", "description": "Pure digit version ordinal (must exceed current max)", "type": "string", "required": true },
                { "name": "DisplayVersion", "description": "Public version label, unique, e.g. 1.0.0", "type": "string", "required": true },
                { "name": "description", "description": "Version note", "type": "string", "required": false },
                { "name": "author", "description": "Author name", "type": "string", "required": false }
            ]
        },
        {
            "name": "show",
            "description": "Inspect the staging area: without FileRelPath shows a grouped overview per mount (staged count / changed count / file list); with FileRelPath shows that file's staged detail including content comparison.",
            "parameters": [
                { "name": "ProjectID", "description": "Project name", "type": "string", "required": true },
                { "name": "FileRelPath", "description": "Optional; inspect a single staged file", "type": "string", "required": false }
            ]
        },
        {
            "name": "list",
            "description": "Paginated snapshot list (desc by version ordinal): version id / display version / note / author / time / changed-file count.",
            "parameters": [
                { "name": "ProjectID", "description": "Project name", "type": "string", "required": true },
                { "name": "page", "description": "Page number, default 1", "type": "number", "required": false },
                { "name": "limit", "description": "Page size, default 5", "type": "number", "required": false }
            ]
        },
        {
            "name": "diff",
            "description": "Compare a target snapshot (TargetVersion = DisplayVersion) against the current staging area: added/modified/deleted files with line-level diff summaries.",
            "parameters": [
                { "name": "ProjectID", "description": "Project name", "type": "string", "required": true },
                { "name": "TargetVersion", "description": "Target DisplayVersion, e.g. 1.0.0", "type": "string", "required": true }
            ]
        },
        {
            "name": "ChangeCommitNode",
            "description": "Modify a file inside an already-committed snapshot node (any historical version): action=rewrite replaces the file content (via content or SelectFilePath), action=remove marks the file deleted (REWRITE region becomes all '-'). Rewriting the same node file again only replaces the REWRITE region. Resulting change_type is rewrite/remove.",
            "parameters": [
                { "name": "ProjectID", "description": "Project name", "type": "string", "required": true },
                { "name": "TargetVersion", "description": "Target node DisplayVersion", "type": "string", "required": true },
                { "name": "FileRelPath", "description": "File path (mount/relative, e.g. _main/src/index.js)", "type": "string", "required": true },
                { "name": "action", "description": "rewrite (replace content) / remove (mark deleted)", "type": "string", "required": true },
                { "name": "content", "description": "Full new content for rewrite (alternative to SelectFilePath)", "type": "string", "required": false },
                { "name": "SelectFilePath", "description": "Absolute path of a file to use as the new content (alternative to content)", "type": "string", "required": false }
            ]
        },
        {
            "name": "PullFromHistory",
            "description": "Fork old code from a historical snapshot to OutputPath: without FileRelPathArray copies the whole tree; with it only extracts selected files. For multi-mount projects each mount gets its own subfolder under OutputPath, including _main (mirroring the mount layout). Never touches the original project or the version chain.",
            "parameters": [
                { "name": "ProjectID", "description": "Project name", "type": "string", "required": true },
                { "name": "TargetVersion", "description": "Target DisplayVersion", "type": "string", "required": true },
                { "name": "OutputPath", "description": "Output root directory (absolute)", "type": "string", "required": true },
                { "name": "FileRelPathArray", "description": "Optional; only extract these files, JSON array string e.g. [\"_main/src/a.js\",\"path2/lib/b.txt\"]", "type": "string", "required": false }
            ]
        },
        {
            "name": "Rollback",
            "description": "Roll back to a node (TargetVersion=DisplayVersion): physically rewrites the project directories to the target content, deletes all snapshots after the target (irreversible), and resyncs the staging area against the rolled-back head.",
            "parameters": [
                { "name": "ProjectID", "description": "Project name", "type": "string", "required": true },
                { "name": "TargetVersion", "description": "Target DisplayVersion", "type": "string", "required": true }
            ]
        },
        {
            "name": "DestroyDatabase",
            "description": "Permanently delete a project's snapshot database folder (manifest.json + data.db + all history). IRREVERSIBLE - there is no undo.",
            "parameters": [
                { "name": "ProjectID", "description": "Project name whose database folder will be removed", "type": "string", "required": true }
            ]
        }
    ]
}*/

import { doCommit, doShow, doList, doDiff } from '../engine/core';
import { doInit, doManage, doChangeCommitNode, doPull, doRollback, doDestroyDatabase } from '../engine/history';

type Handler = (params: any) => Promise<any>;

const handlers: { [key: string]: Handler } = {
  init: (params: any) => doInit(params.ProjectID, params),
  manage: (params: any) => doManage(params.ProjectID, params),
  commit: (params: any) => doCommit(params.ProjectID, params),
  show: (params: any) => doShow(params.ProjectID, params),
  list: (params: any) => doList(params.ProjectID, params),
  diff: (params: any) => doDiff(params.ProjectID, params),
  ChangeCommitNode: (params: any) => doChangeCommitNode(params.ProjectID, params),
  PullFromHistory: (params: any) => doPull(params.ProjectID, params),
  Rollback: (params: any) => doRollback(params.ProjectID, params),
  DestroyDatabase: (params: any) => doDestroyDatabase(params.ProjectID, params),
};

async function wrapTool(name: string, params: any): Promise<any> {
  try {
    const r = await handlers[name](params || {});
    return r || { success: true, message: 'done' };
  } catch (e) {
    return { success: false, message: (e as Error).message ? (e as Error).message : String(e) };
  }
}

const api = {
  init: (params: any) => wrapTool('init', params),
  manage: (params: any) => wrapTool('manage', params),
  commit: (params: any) => wrapTool('commit', params),
  show: (params: any) => wrapTool('show', params),
  list: (params: any) => wrapTool('list', params),
  diff: (params: any) => wrapTool('diff', params),
  ChangeCommitNode: (params: any) => wrapTool('ChangeCommitNode', params),
  PullFromHistory: (params: any) => wrapTool('PullFromHistory', params),
  Rollback: (params: any) => wrapTool('Rollback', params),
  DestroyDatabase: (params: any) => wrapTool('DestroyDatabase', params),
  main: () => Promise.resolve({ success: true, message: 'snapshotver loaded', data: { tools: Object.keys(handlers) } }),
};

// Subpackage tools must be exported directly so the loader can bind
// them by name (e.g. snapshotver:init), not wrapped behind a namespace.
export const init = api.init;
export const manage = api.manage;
export const commit = api.commit;
export const show = api.show;
export const list = api.list;
export const diff = api.diff;
export const ChangeCommitNode = api.ChangeCommitNode;
export const PullFromHistory = api.PullFromHistory;
export const Rollback = api.Rollback;
export const DestroyDatabase = api.DestroyDatabase;
export const main = api.main;