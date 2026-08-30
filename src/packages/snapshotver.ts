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
        "zh": "不依赖 git 的项目快照管理：每个快照实例维护文件级变更流水；支持多挂载点、完整 .gitignore 语法、暂存区管理、快照节点回滚/fork。",
        "en": "Git-free project snapshot management: each snapshot instance keeps a file-level change stream; multi-mount, full .gitignore syntax, staging management, snapshot-node rollback/fork."
    },
    "category": "dev_code",
    "tools": [
        {
            "name": "init",
            "description": "Initialize a new snapshot instance (实例): creates {snapshotRoot}/{ProjectID}/ with manifest.json + data.db. ProjectID names the instance, rootPath is the project root (the _main mount); extendProjectID inherits another instance's snapshot database; IsMultiple=true uses MultiplePathArray to declare extra mounts ({id,path} entries; a UseIgnore inside a mount entry attaches a mount-local isolated ignore file, a top-level UseIgnore-only entry {UseIgnore} sets the global ignore for all mounts). Each mount root's own .gitignore (or _main's in single-mount mode) is auto-discovered at runtime and applied to untracked files only.",
            "parameters": [
                { "name": "ProjectID", "description": "Instance name used as the snapshot directory name", "type": "string", "required": true },
                { "name": "rootPath", "description": "Absolute path of the project root (the _main mount)", "type": "string", "required": true },
                { "name": "extendProjectID", "description": "Inherit another project (copies its snapshot database)", "type": "string", "required": false },
                { "name": "IsMultiple", "description": "Multi-mount project flag, default false", "type": "boolean", "required": false },
                { "name": "MultiplePathArray", "description": "JSON array string. Mount entries [{id,path[,UseIgnore]}] register mounts; UseIgnore inside a mount entry = that mount's isolated ignore file (never affects other mounts). A UseIgnore-only entry at the top level (no id/path) = global ignore applied to all mounts; also accepted in single-mount mode. e.g. [{\"id\":\"path2\",\"path\":\"/sdcard/project/example\",\"UseIgnore\":\"/sdcard/path/.gitignore\"}] or [{\"UseIgnore\":\"/abs/path/.gitignore\"}]", "type": "string", "required": false },
                { "name": "maxFileSizeMB", "description": "Per-file size limit in MB, default 10; oversized files are skipped with warnings; 0 disables the limit", "type": "number", "required": false }
            ]
        },
        {
            "name": "manage",
            "description": "Operate the staging area (暂存区): action=add syncs changed files into staging (files identical to the latest snapshot node are skipped, rollback baseline anchors marked unchanged are kept; .gitignore applies only to untracked files, tracked files stay visible - to untrack one use remove); action=remove writes a pending_delete marker (commits become delete changes). RelPath supports: \".\" for everything (all mounts); \"_main/xxx\" or mountKey/xxx; absolute paths inside registered mounts; multi-mount bare paths must carry a mount prefix. Passing OtherParam (JSON object) performs auxiliary operations instead: {\"metadata\":{\"ignorePath\":\"/abs/.gitignore\"|null,\"maxFileSizeMB\":10}} updates whitelisted instance metadata.",
            "parameters": [
                { "name": "ProjectID", "description": "Instance name", "type": "string", "required": true },
                { "name": "action", "description": "add / remove (optional only when OtherParam is used)", "type": "string", "required": false },
                { "name": "RelPath", "description": "Path or mount locator (. / mount/relative / absolute; optional only when OtherParam is used)", "type": "string", "required": false },
                { "name": "OtherParam", "description": "Optional JSON object for auxiliary operations, e.g. {\"metadata\":{\"ignorePath\":\"/abs/.gitignore\" or null,\"maxFileSizeMB\":10}} to update whitelisted instance metadata; ignorePath updates the GLOBAL ignore (applies to every mount), per-mount isolated ignore files are fixed at init (only ignorePath / maxFileSizeMB allowed)", "type": "string", "required": false }
            ]
        },
        {
            "name": "commit",
            "description": "Commit a new snapshot node (快照节点): turns the whole staging area (暂存区) into a snapshot node by diffing against the latest snapshot node. VersionID (版本序号) must be a monotonically increasing digit string; DisplayVersion (显示版本号) is the public version label used by rollback/query; description and author are metadata. Staging is preserved.",
            "parameters": [
                { "name": "ProjectID", "description": "Instance name", "type": "string", "required": true },
                { "name": "VersionID", "description": "Monotonically increasing digit version ordinal (版本序号); must exceed current max", "type": "string", "required": true },
                { "name": "DisplayVersion", "description": "Unique public version label (显示版本号), e.g. 1.0.0", "type": "string", "required": true },
                { "name": "description", "description": "Version note", "type": "string", "required": false },
                { "name": "author", "description": "Author name", "type": "string", "required": false }
            ]
        },
        {
            "name": "show",
            "description": "Inspect the staging area (暂存区): without FileRelPath shows a grouped overview per mount (staged count / changed count / file list); with FileRelPath shows that file's staged detail including content comparison.",
            "parameters": [
                { "name": "ProjectID", "description": "Instance name", "type": "string", "required": true },
                { "name": "FileRelPath", "description": "Optional; inspect a single staged file", "type": "string", "required": false }
            ]
        },
        {
            "name": "list",
            "description": "Paginated snapshot node (快照节点) list, descending by version ordinal (版本序号): version id / display version / note / author / time / changed-file count.",
            "parameters": [
                { "name": "ProjectID", "description": "Project name", "type": "string", "required": true },
                { "name": "page", "description": "Page number, default 1", "type": "number", "required": false },
                { "name": "limit", "description": "Page size, default 5", "type": "number", "required": false }
            ]
        },
        {
            "name": "diff",
            "description": "Compare a target snapshot node (TargetVersion = 显示版本号 DisplayVersion) against the current staging area (暂存区): added/modified/deleted files with line-level diff summaries.",
            "parameters": [
                { "name": "ProjectID", "description": "Instance name", "type": "string", "required": true },
                { "name": "TargetVersion", "description": "Target display version (显示版本号), e.g. 1.0.0", "type": "string", "required": true }
            ]
        },
        {
            "name": "ChangeCommitNode",
            "description": "Modify a file inside an already-committed snapshot node (任意历史快照节点): action=rewrite replaces the file content (via content or SelectFilePath), action=remove marks the file deleted (REWRITE region becomes all '-'). Rewriting the same snapshot node file again only replaces the REWRITE region. Resulting change_type is rewrite/remove.",
            "parameters": [
                { "name": "ProjectID", "description": "Instance name", "type": "string", "required": true },
                { "name": "TargetVersion", "description": "Target snapshot node display version (显示版本号)", "type": "string", "required": true },
                { "name": "FileRelPath", "description": "File path (mount/relative, e.g. _main/src/index.js)", "type": "string", "required": true },
                { "name": "action", "description": "rewrite (replace content) / remove (mark deleted)", "type": "string", "required": true },
                { "name": "content", "description": "Full new content for rewrite (alternative to SelectFilePath)", "type": "string", "required": false },
                { "name": "SelectFilePath", "description": "Absolute path of a file to use as the new content (alternative to content)", "type": "string", "required": false }
            ]
        },
        {
            "name": "PullFromHistory",
            "description": "Fork old code from a historical snapshot node to OutputPath: without FileRelPathArray copies the whole tree; with it only extracts selected files. For multi-mount projects each mount gets its own subfolder under OutputPath, including _main (mirroring the mount layout). Never touches the original project or the version chain.",
            "parameters": [
                { "name": "ProjectID", "description": "Instance name", "type": "string", "required": true },
                { "name": "TargetVersion", "description": "Target display version (显示版本号)", "type": "string", "required": true },
                { "name": "OutputPath", "description": "Output root directory (absolute)", "type": "string", "required": true },
                { "name": "FileRelPathArray", "description": "Optional; only extract these files, JSON array string e.g. [\"_main/src/a.js\",\"path2/lib/b.txt\"]", "type": "string", "required": false }
            ]
        },
        {
            "name": "Rollback",
            "description": "Roll back (回滚) to a snapshot node (TargetVersion = 显示版本号 DisplayVersion): physically rewrites the project directories to the target content, deletes every snapshot node after the target, then resets the staging area (暂存区) to the rolled-back tree with every file marked unchanged (no pre-rollback staging residue). Files on disk that the head tree does not track (deleted in history, re-created locally / ignored) are never overwritten or deleted: text files are merged with git-style conflict markers (<<<<<<< HEAD / ======= / >>>>>>> version/<version_id 版本序号>); binary files are renamed aside with a versioned suffix (.rollback-conflict-v<version_id>) so the snapshot's binary restores to the original name and nothing is lost. IRREVERSIBLE - requires confirm=true to execute.",
            "parameters": [
                { "name": "ProjectID", "description": "Instance name", "type": "string", "required": true },
                { "name": "TargetVersion", "description": "Target display version (显示版本号)", "type": "string", "required": true },
                { "name": "confirm", "description": "Must be true to actually roll back (回滚) - irreversible, default false", "type": "boolean", "required": false }
            ]
        },
        {
            "name": "DestroyDatabase",
            "description": "Permanently delete a snapshot instance's database folder (manifest.json + data.db + all history). IRREVERSIBLE - requires confirm=true to execute.",
            "parameters": [
                { "name": "ProjectID", "description": "Instance name whose database folder will be removed", "type": "string", "required": true },
                { "name": "confirm", "description": "Must be true to actually delete (irreversible), default false", "type": "boolean", "required": false }
            ]
        },
        {
            "name": "GetManifest",
            "description": "Return a snapshot instance's metadata (实例元数据): rootPath, mounts, global ignorePath, per-mount isolated ignore files (mountIgnore), auto-discovered .gitignore files, size limit, inheritance, creation time and the database folder path.",
            "parameters": [
                { "name": "ProjectID", "description": "Instance name", "type": "string", "required": true }
            ]
        },
        {
            "name": "IntervalDiff",
            "description": "Compare every snapshot node (快照节点) inside a range (LeftVersion..RightVersion as display versions 显示版本号, oldest/newest auto-normalized): rebuilds the complete file states at both endpoints and reports every add/modify/delete across that interval, plus a per-node change listing. Returns whether a historical (non-head) right endpoint was reconstructed.",
            "parameters": [
                { "name": "ProjectID", "description": "Instance name", "type": "string", "required": true },
                { "name": "LeftVersion", "description": "Left boundary display version (显示版本号), e.g. 1.0.0", "type": "string", "required": true },
                { "name": "RightVersion", "description": "Right boundary display version (显示版本号), e.g. 1.0.2", "type": "string", "required": true }
            ]
        }
    ]
}*/

import { doCommit, doShow, doList, doDiff, doGetManifest, doIntervalDiff } from '../engine/core';
import { doInit, doManage, doChangeCommitNode, doPull, doRollback, doDestroyDatabase } from '../engine/history';

type Handler = (params: any) => Promise<any>;

const handlers: { [key: string]: Handler } = {
  init: (params: any) => doInit(params.ProjectID, params),
  manage: (params: any) => doManage(params.ProjectID, params),
  commit: (params: any) => doCommit(params.ProjectID, params),
  show: (params: any) => doShow(params.ProjectID, params),
  list: (params: any) => doList(params.ProjectID, params),
  diff: (params: any) => doDiff(params.ProjectID, params),
  GetManifest: (params: any) => doGetManifest(params.ProjectID, params),
  IntervalDiff: (params: any) => doIntervalDiff(params.ProjectID, params),
  ChangeCommitNode: (params: any) => doChangeCommitNode(params.ProjectID, params),
  PullFromHistory: (params: any) => doPull(params.ProjectID, params),
  Rollback: (params: any) => doRollback(params.ProjectID, params),
  DestroyDatabase: (params: any) => doDestroyDatabase(params.ProjectID, params),
};

async function wrapTool(name: string, params: any): Promise<any> {
  const System = (Java as any).type('java.lang.System');
  const t0 = System.currentTimeMillis();
  try {
    const r = await handlers[name](params || {});
    const out = r || { success: true, message: 'done' };
    // Report wall-clock duration measured via the Java bridge timer.
    if (out && typeof out === 'object') {
      try { out.durationMs = System.currentTimeMillis() - t0; } catch (e) { /* keep silent */ }
    }
    return out;
  } catch (e) {
    return { success: false, message: (e as Error).message ? (e as Error).message : String(e), durationMs: System.currentTimeMillis() - t0 };
  }
}

const api = {
  init: (params: any) => wrapTool('init', params),
  manage: (params: any) => wrapTool('manage', params),
  commit: (params: any) => wrapTool('commit', params),
  show: (params: any) => wrapTool('show', params),
  list: (params: any) => wrapTool('list', params),
  diff: (params: any) => wrapTool('diff', params),
  GetManifest: (params: any) => wrapTool('GetManifest', params),
  IntervalDiff: (params: any) => wrapTool('IntervalDiff', params),
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
export const GetManifest = api.GetManifest;
export const IntervalDiff = api.IntervalDiff;
export const ChangeCommitNode = api.ChangeCommitNode;
export const PullFromHistory = api.PullFromHistory;
export const Rollback = api.Rollback;
export const DestroyDatabase = api.DestroyDatabase;
export const main = api.main;