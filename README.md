# Version Snapshot - 文件快照管理工具

## 概述
Version Snapshot 是一个**不依赖 Git 的项目文件快照管理工具**，专为 Operit 平台设计。它提供了文件级别的变更追踪、多挂载点支持、完整的 `.gitignore` 语法解析，以及跨版本的回滚和分支（fork）能力。

## 核心特性

- **文件级变更流**：精确记录每个文件的增、删、改操作，支持二进制和文本文件。
- **多挂载点**：一个项目可以同时挂载多个目录，统一进行快照管理。
- **完整 .gitignore 语法**：支持 `*`、`?`、`[]`、`**`、锚定、否定模式（`!`）和目录规则。
- **跨版本回滚/Fork**：可以回滚到任意历史版本，或将历史版本的文件导出到任意目录。
- **无 Git 依赖**：纯 Java Bridge + `Tools.Files` 实现，不依赖任何外部版本控制工具。
- **安全存储**：数据存储在 `/storage/emulated/0/Download/Operit/SnapshotDatabase/`，用户可见、可备份。

## 使用方法
该工具包是专门给AI使用的，我们提供给 AI 10个工具，覆盖初始化、添加、删除、修改和回档5大能力，非常适合大型项目做版本管理使用

## 坑
受限于SQLite，对于资源文件严格限制为单个文件10MB

## 开源
项目基于GPL-v3协议开源，开源仓库：[https://github.com/yyswys-yjyj/com.operit.version_snapshot](https://github.com/yyswys-yjyj/com.operit.version_snapshot)   

## 叠BUFF
![访问量统计](https://visitor.serveryyswys.top/cnt/SNAPSHOTVER)